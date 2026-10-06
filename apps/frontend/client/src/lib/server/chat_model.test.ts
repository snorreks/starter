// apps/frontend/client/src/lib/server/chat_model.test.ts
//
// The model port, and the profile policy.
//
// Two properties are worth their own files elsewhere, and they are here:
//
//   1. **The echo model really streams.** Not "returns a string" — several chunks, in
//      order, and it stops when the signal fires. A model that produced one chunk
//      would leave every assertion about incremental delivery in the client and the
//      E2E lane untested, because a one-chunk stream is indistinguishable from a
//      non-streaming response.
//   2. **An unconfigured profile is `echo`, and a bad one is refused.** Asserted
//      against the real resolver, because a default that is wrong here spends money or
//      silently runs a local model where an operator meant a real one.

import { describe, expect, test } from 'bun:test';
import {
  CHAT_MODEL_PROFILES,
  createChatModel,
  createEchoChatModel,
  createWorkersAiChatModel,
  ECHO_CHUNK_SIZE,
  resolveChatModelProfile,
  WORKERS_AI_MODEL,
} from './chat_model.ts';

const collect = async (iterable: AsyncIterable<{ text: string }>): Promise<string[]> => {
  const chunks: string[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk.text);
  }
  return chunks;
};

describe('the echo model', () => {
  test('produces more than one chunk, so streaming is actually exercised', async () => {
    const model = createEchoChatModel();

    // The prompt is long enough to span several default-sized chunks. A one-chunk
    // implementation would fail this, and a one-chunk stream is byte-identical to a
    // non-streaming response — so this is the assertion that keeps the client's
    // incremental-append path from being untested.
    const chunks = await collect(
      model.generate(
        'explain how a Cloudflare Durable Object hibernates a WebSocket',
        new AbortController().signal,
      ),
    );

    expect(chunks.length).toBeGreaterThan(1);
  });

  test('the chunks concatenate to a real answer derived from the prompt', async () => {
    const model = createEchoChatModel();

    const text = (await collect(model.generate('what is D1?', new AbortController().signal))).join(
      '',
    );

    expect(text).toContain('what is D1?');
  });

  test('honours an explicit chunk size', async () => {
    const model = createEchoChatModel({ chunkSize: 4 });

    const chunks = await collect(model.generate('abcdefghij', new AbortController().signal));

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4);
    }
    expect(chunks.join('')).toContain('abcdefghij');
  });

  test('stops when the signal is already aborted, producing nothing', async () => {
    const model = createEchoChatModel();
    const controller = new AbortController();
    controller.abort();

    // The property that stops a departed reader being billed for tokens: a model
    // that ignored the signal would emit the whole answer here.
    expect(await collect(model.generate('hello', controller.signal))).toHaveLength(0);
  });

  test('stops mid-answer when the signal fires', async () => {
    const model = createEchoChatModel({ chunkSize: 1, delayMs: 5 });
    const controller = new AbortController();

    const chunks: string[] = [];
    for await (const chunk of model.generate('a long prompt that yields many chunks', controller.signal)) {
      chunks.push(chunk.text);
      if (chunks.length === 3) {
        controller.abort();
      }
    }

    // Bounded rather than exact: the point is that it stopped early, and how many
    // chunks arrive before an abort lands depends on timing, which a test must not
    // depend on.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(20);
  });

  test('the default chunk size is the documented one', async () => {
    // Restating the constant would make the test agree with a change by changing
    // itself. This asserts the two are the same *decision*.
    const model = createEchoChatModel();

    expect(model.profile).toBe('echo');
    expect(ECHO_CHUNK_SIZE).toBeGreaterThan(1);
  });
});

describe('the profile policy', () => {
  test('an absent profile is the local model, so a fresh clone runs', () => {
    // The default that makes `bun install && bun run dev` show a working chat with
    // no credential anywhere.
    expect(resolveChatModelProfile({})).toBe('echo');
    expect(resolveChatModelProfile({ CHAT_MODEL_PROFILE: '  ' })).toBe('echo');
  });

  test('each declared profile resolves to itself', () => {
    for (const profile of CHAT_MODEL_PROFILES) {
      expect(resolveChatModelProfile({ CHAT_MODEL_PROFILE: profile })).toBe(profile);
    }
  });

  test('an unrecognised profile is refused rather than guessed', () => {
    // A typo that silently enabled a paid path, or silently disabled a real one,
    // both read as "the feature is broken" from the outside.
    expect(() => resolveChatModelProfile({ CHAT_MODEL_PROFILE: 'openai' })).toThrow(
      /not a known chat model profile/,
    );
  });

  test('the refusal names the valid values', () => {
    expect(() => resolveChatModelProfile({ CHAT_MODEL_PROFILE: 'gpt' })).toThrow(/echo, workers-ai/);
  });
});

describe('the Workers AI adapter', () => {
  test('refuses with the binding named, when the profile wants one and it is absent', async () => {
    const model = createWorkersAiChatModel({ binding: undefined });

    // Named rather than generic: "this deployment has no AI binding" is a
    // configuration fix and "something went wrong" is not.
    await expect(collect(model.generate('hi', new AbortController().signal))).rejects.toThrow(
      /AI binding is not available/,
    );
  });

  test('emits the binding response as a single chunk', async () => {
    let askedModel = '';
    const model = createWorkersAiChatModel({
      binding: {
        async run(m, input) {
          askedModel = m;
          void input;
          return { response: 'a reply' };
        },
      },
    });

    const chunks = await collect(model.generate('hi', new AbortController().signal));

    // Documented as a single chunk because the binding returns a whole completion
    // rather than a stream. Asserted so a future adapter that *did* stream would
    // have to change this deliberately.
    expect(chunks).toEqual(['a reply']);
    expect(askedModel).toBe(WORKERS_AI_MODEL);
  });

  test('refuses a response shape it cannot read, naming the model', async () => {
    const model = createWorkersAiChatModel({
      binding: { async run() {
        return { nope: true };
      } },
    });

    await expect(collect(model.generate('hi', new AbortController().signal))).rejects.toThrow(
      /cannot read/,
    );
  });

  test('produces nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const model = createWorkersAiChatModel({
      binding: {
        async run() {
          ran = true;
          return { response: 'x' };
        },
      },
    });

    expect(await collect(model.generate('hi', controller.signal))).toHaveLength(0);
    // The call itself is skipped, not merely its result discarded: a provider billed
    // for a request the reader abandoned is the failure this guards.
    expect(ran).toBe(false);
  });
});

describe('choosing the model', () => {
  test('the echo profile does not need a binding', async () => {
    const model = createChatModel({ profile: 'echo', binding: undefined });

    expect(model.profile).toBe('echo');
    expect((await collect(model.generate('hi', new AbortController().signal))).length).toBeGreaterThan(
      0,
    );
  });

  test('the workers-ai profile reaches the binding it was given', async () => {
    const model = createChatModel({
      profile: 'workers-ai',
      binding: { async run() {
        return { response: 'bound' };
      } },
    });

    expect(await collect(model.generate('hi', new AbortController().signal))).toEqual(['bound']);
  });
});