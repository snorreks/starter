// apps/frontend/client/src/lib/server/chat_model.ts
//
// The model port, and the two adapters this template ships.
//
// A model is anything that turns a prompt into a stream of text chunks. That is the
// whole interface, and it is deliberately that small, because the two adapters
// differ in *where* they run rather than in what they do:
//
//   - `echo` — no binding, no credential, no network. It produces a real answer from
//     the text it was given, chunk by chunk, so the streaming path in the Worker, the
//     browser and E2E is exercised end to end on a machine with no account and no
//     key.
//   - `workers-ai` — the Cloudflare Workers AI binding. Present only where `AI` is
//     bound and `CHAT_MODEL_PROFILE` names it.
//
// **Why `echo` is not a stub.** It is a real implementation of the port returning a
// deterministic answer derived from its input. That is what lets the credential-free
// lanes prove the *streaming* behaviour — chunking, frame order, the terminal frame,
// the client's append — without a model, and it is why `test:worker` and `e2e` can
// assert on assistant text at all. A port whose only implementation threw
// "not configured" would leave every assertion about a streamed reply unverifiable,
// which is a far larger hole than a deliberately simple model.
//
// **Why the profile is explicit.** `absent` means `echo`, and `workers-ai` requires
// both the binding and `CHAT_MODEL_PROFILE=workers-ai`. Same shape as
// `resolveJobsProfile` and for the same reason: a deployment that silently gained a
// paid model path because a binding was forgotten is worse than one that refuses
// with a name.

/** One chunk of generated text. A model yields these in order. */
export interface ChatModelChunk {
  readonly text: string;
}

/**
 * What the streaming route needs from a model.
 *
 * `signal` is required rather than optional: a browser that navigates away aborts
 * the request, and a model that keeps generating tokens for a reader that has gone is
 * billed for text nobody will read. An adapter is expected to stop when it fires.
 */
export interface ChatModel {
  /** A stable name, for logs and for the refusal message. */
  readonly profile: string;
  /**
   * Produce a reply, one chunk at a time.
   *
   * Yields rather than returning a string: the point of the port is that a caller can
   * forward each chunk as it arrives, and a port that returned the whole reply would
   * force every caller to re-split it.
   */
  generate(prompt: string, signal: AbortSignal): AsyncIterable<ChatModelChunk>;
}

/** Profiles this deployment can have. */
export const CHAT_MODEL_PROFILES = ['echo', 'workers-ai'] as const;
export type ChatModelProfile = (typeof CHAT_MODEL_PROFILES)[number];

/**
 * The Workers AI binding, as this application uses it.
 *
 * Declared rather than imported from `@cloudflare/workers-types` because the one
 * method used here is the whole surface, and a hand-written declaration is checkable
 * in a way that `any` is not.
 */
export interface WorkersAiBinding {
  run(
    model: string,
    input: {
      messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
      stream?: boolean;
      max_tokens?: number;
    },
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

export const CHAT_MODEL_PROFILE_ENV = 'CHAT_MODEL_PROFILE';
export const CHAT_MODEL_BINDING = 'AI';

/** The model a `workers-ai` profile runs. Named, so it is one edit. */
export const WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
export const WORKERS_AI_CONTEXT_TOKENS = 32_000;
export const CHAT_OUTPUT_MAX_TOKENS = 768;
export const CHAT_OUTPUT_MAX_BYTES = 12_288;
export const CHAT_PROMPT_MAX_BYTES = 24_576;
export const CHAT_GENERATION_DEADLINE_MS = 45_000;

/**
 * How many characters the echo model speaks per chunk.
 *
 * Not a token and not a word: an echo model has no tokenizer, and claiming it did
 * would be a fiction the tests would then depend on. Small enough that a test can
 * assert on the number of frames, large enough that a message arrives as several
 * deltas rather than one.
 */
export const ECHO_CHUNK_SIZE = 24;

/**
 * Fail-closed, exactly as `resolveJobsProfile` does.
 *
 * `absent` is `echo`, the only profile needing neither a binding nor a credential, so
 * a fresh clone runs the streaming path with no configuration at all. The inverse
 * default would be the one that spends money.
 */
export const resolveChatModelProfile = (env: { CHAT_MODEL_PROFILE?: string }): ChatModelProfile => {
  const raw = env.CHAT_MODEL_PROFILE?.trim();

  if (raw === undefined || raw.length === 0) {
    return 'echo';
  }
  for (const profile of CHAT_MODEL_PROFILES) {
    if (raw === profile) {
      return profile;
    }
  }

  throw new Error(
    `CHAT_MODEL_PROFILE is "${raw}", which is not a known chat model profile. ` +
      `Valid values: ${CHAT_MODEL_PROFILES.join(', ')}. Refusing to start: ` +
      'an unrecognised profile must not be guessed at.',
  );
};

/**
 * The echo model.
 *
 * Real, deterministic and dependency-free. It answers with the prompt's own text
 * wrapped in a short framing, split into fixed-size chunks, so a client exercising
 * this sees the same shape it would see from a real model: several deltas, in order.
 */
export const createEchoChatModel = (
  options: { chunkSize?: number; delayMs?: number } = {},
): ChatModel => {
  const chunkSize = options.chunkSize ?? ECHO_CHUNK_SIZE;
  const delayMs = options.delayMs ?? 0;

  return {
    profile: 'echo',
    async *generate(prompt, signal) {
      const answer = `You said: ${prompt.trim()}`;

      for (let offset = 0; offset < answer.length; offset += chunkSize) {
        if (signal.aborted) {
          return;
        }
        if (delayMs > 0) {
          await sleepOrAbort(delayMs, signal);
          if (signal.aborted) {
            return;
          }
        }
        yield { text: answer.slice(offset, offset + chunkSize) };
      }
    },
  };
};

/**
 * The Workers AI adapter.
 *
 * Every refusal names what is missing, because the two failures a reader has to act
 * on are different: "this deployment has no AI binding" is a deployment problem, and
 * "the model call was rejected" is a provider or prompt problem.
 */
export const createWorkersAiChatModel = (options: {
  binding: WorkersAiBinding | undefined;
  model?: string;
}): ChatModel => {
  const model = options.model ?? WORKERS_AI_MODEL;

  return {
    profile: 'workers-ai',
    async *generate(prompt, signal) {
      if (options.binding === undefined) {
        throw new Error(
          `CHAT_MODEL_PROFILE is "workers-ai" but the ${CHAT_MODEL_BINDING} binding is not ` +
            'available. Declare it in apps/frontend/client/wrangler.jsonc, or set ' +
            'CHAT_MODEL_PROFILE=echo.',
        );
      }

      if (signal.aborted) {
        return;
      }

      if (new TextEncoder().encode(prompt).byteLength > CHAT_PROMPT_MAX_BYTES) {
        throw new Error(`Chat history exceeds the ${CHAT_PROMPT_MAX_BYTES}-byte prompt budget.`);
      }
      const answer = await options.binding.run(
        model,
        {
          messages: [{ role: 'user', content: prompt }],
          stream: true,
          max_tokens: CHAT_OUTPUT_MAX_TOKENS,
        },
        { signal },
      );

      // The binding's response shape is provider-owned, so it is narrowed rather than
      // asserted: a response this adapter cannot read is a refusal naming the model,
      // not a stream of `undefined`.
      if (answer instanceof ReadableStream) {
        yield* readWorkersAiStream(answer, signal);
        return;
      }
      throw new Error(`The Workers AI model ${model} did not return the requested stream.`);
    },
  };
};

/** Decode the provider's SSE stream incrementally and stop consuming after abort. */
const readWorkersAiStream = async function* (
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ChatModelChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) {
            continue;
          }
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            return;
          }
          let value: unknown;
          try {
            value = JSON.parse(data);
          } catch {
            throw new Error('Workers AI returned malformed streaming JSON.');
          }
          if (
            typeof value !== 'object' ||
            value === null ||
            !('response' in value) ||
            typeof value.response !== 'string'
          ) {
            continue;
          }
          if (value.response.length > 0) {
            yield { text: value.response };
          }
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (signal.aborted) {
      await reader.cancel('client aborted').catch(() => undefined);
    }
    reader.releaseLock();
  }
};

/**
 * Sleep, or return early when the signal fires.
 *
 * Injected rather than hard-coded so a test can prove the abort path without waiting
 * for a real delay — the same rule `.pi/tests/process.test.ts` follows for a
 * subprocess that must not exit.
 */
const sleepOrAbort = async (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * The model this deployment has.
 *
 * Built from the binding set rather than memoized: the container is already the
 * memoized thing, and see `container.ts` for why bindings live there and identity
 * does not.
 */
export const createChatModel = (options: {
  profile: ChatModelProfile;
  binding: WorkersAiBinding | undefined;
  echo?: { chunkSize?: number; delayMs?: number };
}): ChatModel =>
  options.profile === 'workers-ai'
    ? createWorkersAiChatModel({ binding: options.binding })
    : createEchoChatModel(options.echo ?? {});
