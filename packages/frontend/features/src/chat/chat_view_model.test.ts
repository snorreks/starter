// packages/frontend/features/src/chat/chat_view_model.test.ts
//
// The screen state for a conversation, and the queue that holds what could not be
// sent yet.
//
// What these tests are actually for: the four ways a turn can end, and the
// transcript being right in each. Everything here drives the **real** `ChatService`
// against a **real** `ReadableStream` — a fake service would let a broken frame
// reader pass, and the frame reader is the part most likely to be wrong.

import { describe, expect, test } from 'bun:test';
import {
  type ApiTransport,
  type FetchLike,
  HttpTransport,
  type StreamingTransport,
  type TransportRequestOptions,
} from '@starter/platform';
import {
  type ChatStreamEvent,
  encodeSseDone,
  encodeSseFrame,
  type Message,
} from '@starter/schemas/chat';
import { ChatService } from './chat_service.ts';

const streamTransport = (transport: ApiTransport, fetchImpl: FetchLike): StreamingTransport => ({
  ...transport,
  openStream: (path: string, options?: TransportRequestOptions) =>
    new HttpTransport({ fetch: fetchImpl }).openStream(path, options),
});

import { ChatViewModel } from './chat_view_model.svelte.ts';

const conversation = {
  id: 'cnv_1',
  ownerId: 'f45b2c4a-7919-4f55-ae89-e73f6753e322',
  organizationId: null,
  title: 'Test',
  messageCount: 0,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'msg_1',
  conversationId: 'cnv_1',
  authorId: 'f45b2c4a-7919-4f55-ae89-e73f6753e322',
  role: 'user',
  content: 'hi',
  status: 'complete',
  createdAt: 1_700_000_000_000,
  ...overrides,
});

/** Frames as a real chunked body, so the reader is exercised across boundaries. */
const bodyFrom = (events: ChatStreamEvent[], chunkSize = 64): Response => {
  const text = `${events.map(encodeSseFrame).join('')}${encodeSseDone()}`;
  const bytes = new TextEncoder().encode(text);
  let offset = 0;

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};

interface HarnessOptions {
  readonly events?: ChatStreamEvent[];
  readonly status?: number;
  readonly responseBody?: string;
  readonly failWith?: Error;
  readonly chunkSize?: number;
  readonly messages?: Message[];
}

/** A transport for the two REST calls, plus a `fetch` for the stream. */
const harness = (options: HarnessOptions = {}) => {
  const calls: { path: string; options?: TransportRequestOptions }[] = [];

  const transport: ApiTransport = {
    async request<T>(path: string, requestOptions?: TransportRequestOptions): Promise<T> {
      calls.push({ path, options: requestOptions });
      return { messages: options.messages ?? [], serverTime: 0 } as T;
    },
  };

  const fetchImpl: FetchLike = async () => {
    if (options.failWith !== undefined) {
      throw options.failWith;
    }
    if (options.status !== undefined && options.status >= 400) {
      return new Response(options.responseBody ?? '{"error":"x","message":"no"}', {
        status: options.status,
      });
    }
    return bodyFrom(options.events ?? [], options.chunkSize ?? 64);
  };

  return {
    calls,
    service: new ChatService({ transport: streamTransport(transport, fetchImpl) }),
  };
};

/** Deterministic client ids, so "two messages in the same millisecond" is real. */
const idsFrom = (...values: string[]) => {
  let index = 0;
  return () => values[index++] ?? `cid_${index}`;
};

const viewModel = (h: ReturnType<typeof harness>, ids?: () => string) =>
  new ChatViewModel({
    chat: h.service,
    conversation,
    ...(ids === undefined ? {} : { newClientId: ids }),
  });

describe('a turn that succeeds', () => {
  const events: ChatStreamEvent[] = [
    { type: 'user-message', clientId: 'cid_1', message: message({ id: 'msg_stored' }) },
    { type: 'start', messageId: 'msg_reply' },
    { type: 'delta', text: 'You ' },
    { type: 'delta', text: 'said: hi' },
    {
      type: 'complete',
      message: message({ id: 'msg_reply', role: 'assistant', content: 'You said: hi' }),
    },
  ];

  test('the transcript holds the stored message and the complete reply', async () => {
    const vm = viewModel(harness({ events }), idsFrom('cid_1'));

    vm.setDraft('hi');
    expect(await vm.send()).toBe(true);

    expect(vm.transcript).toHaveLength(2);
    expect(vm.transcript[0]?.content).toBe('hi');
    expect(vm.transcript[0]?.state).toBe('sent');
    expect(vm.transcript[1]?.content).toBe('You said: hi');
    expect(vm.transcript[1]?.role).toBe('assistant');
    expect(vm.transcript[1]?.state).toBe('sent');
  });

  test('the optimistic row is replaced rather than duplicated', async () => {
    const vm = viewModel(harness({ events }), idsFrom('cid_1'));

    vm.setDraft('hi');
    await vm.send();

    // One user message, not the optimistic one *and* the stored one.
    const userMessages = vm.transcript.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.serverId).toBe('msg_stored');
  });

  test('the client id is kept across the reconciliation', async () => {
    const vm = viewModel(harness({ events }), idsFrom('cid_1'));

    vm.setDraft('hi');
    await vm.send();

    // The key the queue and the reconciliation agree on. If this changed to the
    // server id, a queued retry of the same message would not find its own row.
    expect(vm.transcript[0]?.clientId).toBe('cid_1');
  });

  test('the draft is cleared, so the same text is not sent twice', async () => {
    const vm = viewModel(harness({ events }), idsFrom('cid_1'));

    vm.setDraft('hi');
    await vm.send();

    expect(vm.draft).toBe('');
  });

  test('deltas arrive as their own updates, not one batch at the end', async () => {
    const seen: string[] = [];
    const h = harness({ events });
    const service = new ChatService({
      onUpdate: (update) => {
        if (update.type === 'delta') {
          seen.push(update.delta);
        }
      },
      transport: streamTransport(
        {
          async request<T>(): Promise<T> {
            return { messages: [], serverTime: 0 } as T;
          },
        },
        async () => bodyFrom(events),
      ),
    });
    const vm = new ChatViewModel({ chat: service, conversation, newClientId: idsFrom('cid_1') });

    vm.setDraft('hi');
    await vm.send();

    // The streaming property, asserted at the callback the ViewModel itself uses.
    // A service that collected first and called back once would produce the same
    // transcript with one entry, and the UI would show nothing until the end.
    expect(seen).toEqual(['You ', 'said: hi']);
    void h;
  });

  test('a frame split across two network chunks still parses', async () => {
    // `chunkSize: 1` puts every byte in its own read, so every frame boundary falls
    // mid-frame. A reader that assumed whole frames would lose or corrupt them.
    const vm = viewModel(harness({ events, chunkSize: 1 }), idsFrom('cid_1'));

    vm.setDraft('hi');
    expect(await vm.send()).toBe(true);
    expect(vm.transcript[1]?.content).toBe('You said: hi');
  });
});

describe('a turn the model fails', () => {
  const failed: ChatStreamEvent[] = [
    { type: 'user-message', clientId: 'cid_1', message: message({ id: 'msg_stored' }) },
    { type: 'start', messageId: 'msg_reply' },
    { type: 'delta', text: 'partial' },
    { type: 'error', code: 'model_failed', message: 'The model is unavailable.' },
  ];

  test('the user message stays delivered, because it was', async () => {
    const vm = viewModel(harness({ events: failed }), idsFrom('cid_1'));

    vm.setDraft('hi');
    // The turn failed, so `send` reports failure — but the *message* succeeded.
    expect(await vm.send()).toBe(false);

    const user = vm.transcript.find((m) => m.role === 'user');
    expect(user?.state).toBe('sent');
  });

  test('the half-written reply is marked failed and its text kept', async () => {
    const vm = viewModel(harness({ events: failed }), idsFrom('cid_1'));

    vm.setDraft('hi');
    await vm.send();

    const reply = vm.transcript.find((m) => m.role === 'assistant');
    expect(reply?.state).toBe('failed');
    // Kept: the user read it, and deleting text someone has read is worse than
    // marking it unfinished.
    expect(reply?.content).toBe('partial');
  });

  test('nothing is queued, because a failed reply is not an unsent message', async () => {
    // This is the distinction the queue exists to make: a failure *after* delivery
    // must not cause a resend, which would deliver the same message twice.
    const vm = viewModel(harness({ events: failed }), idsFrom('cid_1'));

    vm.setDraft('hi');
    await vm.send();

    expect(vm.queue).toHaveLength(0);
  });
});

describe('a message that never reached the server', () => {
  test('a network failure queues the message instead of losing it', async () => {
    const vm = viewModel(harness({ failWith: new TypeError('network down') }), idsFrom('cid_1'));

    vm.setDraft('hi');
    expect(await vm.send()).toBe(false);

    expect(vm.queue).toHaveLength(1);
    expect(vm.queue[0]?.content).toBe('hi');
  });

  test('the queued message is not also left in the transcript', async () => {
    // It would otherwise appear twice: once as "queued" and once as "in the
    // conversation", which is a claim about a message the server has not received.
    const vm = viewModel(harness({ failWith: new TypeError('down') }), idsFrom('cid_1'));

    vm.setDraft('hi');
    await vm.send();

    expect(vm.transcript).toHaveLength(0);
  });

  test('an HTTP refusal queues it, and keeps the server own message', async () => {
    const vm = viewModel(
      harness({
        status: 503,
        responseBody: '{"error":"unavailable","message":"The model is down."}',
      }),
      idsFrom('cid_1'),
    );

    vm.setDraft('hi');
    expect(await vm.send()).toBe(false);

    expect(vm.queue[0]?.failure).toBe('The model is down.');
  });

  test('flushing sends what is queued, in the order it was written', async () => {
    // One ViewModel whose network comes back. A second one would not prove the
    // queue was flushed — it would prove a fresh screen starts empty.
    let online = false;
    const calls: { content: string }[] = [];

    const service = new ChatService({
      transport: streamTransport(
        {
          async request<T>(): Promise<T> {
            return { messages: [], serverTime: 0 } as T;
          },
        },
        async (_input, init) => {
          const sent = JSON.parse(String(init?.body ?? '{}')) as {
            content: string;
            clientId: string;
          };
          calls.push({ content: sent.content });
          if (!online) {
            throw new TypeError('network down');
          }
          return bodyFrom([
            {
              type: 'user-message',
              clientId: sent.clientId,
              message: message({ id: `m_${sent.content}`, content: sent.content }),
            },
            { type: 'start', messageId: `r_${sent.content}` },
            {
              type: 'complete',
              message: message({
                id: `r_${sent.content}`,
                role: 'assistant',
                content: `re: ${sent.content}`,
              }),
            },
          ]);
        },
      ),
    });

    const vm = new ChatViewModel({
      chat: service,
      conversation,
      newClientId: idsFrom('cid_1', 'cid_2', 'cid_3'),
    });

    // Three sends with no network, so the queue holds three in written order.
    for (const content of ['one', 'two', 'three']) {
      vm.setDraft(content);
      await vm.send();
    }
    expect(vm.queue.map((q) => q.content)).toEqual(['one', 'two', 'three']);

    online = true;
    await vm.flush();

    // Queue drained. The first three entries are the original offline sends; the
    // last three are the retries. Asserted separately from the retry ordering below,
    // because the property worth stating is that the *retries* kept the order they
    // were written in rather than the order they happened to complete.
    expect(vm.queue).toHaveLength(0);
    expect(calls.map((c) => c.content)).toEqual(['one', 'two', 'three', 'one', 'two', 'three']);
    expect(vm.transcript.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  test('a retry that fails again stops, rather than hammering', async () => {
    const vm = viewModel(harness({ failWith: new TypeError('down') }), idsFrom('cid_1', 'cid_2'));

    for (const content of ['one', 'two']) {
      vm.setDraft(content);
      await vm.send();
    }
    expect(vm.queue).toHaveLength(2);

    await vm.flush();

    // Both remain queued rather than one being consumed and lost.
    expect(vm.queue).toHaveLength(2);
  });

  test('a queued message can be discarded', async () => {
    const vm = viewModel(harness({ failWith: new TypeError('down') }), idsFrom('cid_1'));

    vm.setDraft('hi');
    await vm.send();
    expect(vm.queue).toHaveLength(1);

    vm.discard('cid_1');

    expect(vm.queue).toHaveLength(0);
  });

  test('with no conversation, a message is queued rather than dropped', async () => {
    const h = harness({ events: [] });
    const vm = new ChatViewModel({
      chat: h.service,
      conversation: null,
      newClientId: idsFrom('cid_1'),
    });

    vm.setDraft('hi');
    expect(await vm.send()).toBe(false);

    // Nothing was requested — `/api/chat/conversations/undefined/messages` is the
    // call a naive implementation would make.
    expect(h.calls).toHaveLength(0);
    expect(vm.queue).toHaveLength(1);
  });
});

describe('guards on the screen', () => {
  test('a second send is refused while a turn is streaming', async () => {
    // Two concurrent turns produce two replies whose chunks interleave, which reads
    // as one incoherent answer.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const h = harness({ events: [] });
    const service = new ChatService({
      transport: streamTransport(h.service as unknown as ApiTransport, async () => {
        await gate;
        return bodyFrom([
          { type: 'user-message', clientId: 'cid_1', message: message() },
          { type: 'start', messageId: 'r1' },
          { type: 'complete', message: message({ id: 'r1', role: 'assistant', content: 'ok' }) },
        ]);
      }),
    });
    const vm = new ChatViewModel({
      chat: service,
      conversation,
      newClientId: idsFrom('cid_1', 'cid_2'),
    });

    vm.setDraft('one');
    const first = vm.send();
    // The turn is in flight at this point: the fetch is parked on the gate.
    vm.setDraft('two');
    expect(await vm.send()).toBe(false);

    release?.();
    await first;
    expect(vm.transcript.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  test('an empty draft is refused', async () => {
    const vm = viewModel(harness({ events: [] }), idsFrom('cid_1'));

    vm.setDraft('   ');

    expect(await vm.send()).toBe(false);
  });

  test('disposing mid-turn prevents late state changes', async () => {
    const h = harness({ events: [] });
    const service = new ChatService({
      transport: streamTransport(h.service as unknown as ApiTransport, async () =>
        bodyFrom([{ type: 'user-message', clientId: 'cid_1', message: message() }]),
      ),
    });
    const vm = new ChatViewModel({ chat: service, conversation, newClientId: idsFrom('cid_1') });

    vm.setDraft('hi');
    const pending = vm.send();
    await vm.dispose();
    const transcript = [...vm.transcript];
    await pending;

    expect(vm.queue).toHaveLength(0);
    expect(vm.transcript).toEqual(transcript);
  });
});

describe('loading the history', () => {
  test('a snapshot deferred during a turn retains both newly sent rows', async () => {
    const stored = message({ id: 'msg_new_user' });
    const reply = message({ id: 'msg_new_reply', role: 'assistant', content: 'hello' });
    const earlier = message({ id: 'msg_earlier', content: 'earlier' });
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await finish.promise;
        for (const event of [
          { type: 'user-message', clientId: 'cid_1', message: stored },
          { type: 'start', messageId: reply.id },
          { type: 'complete', message: reply },
        ] satisfies ChatStreamEvent[]) {
          controller.enqueue(new TextEncoder().encode(encodeSseFrame(event)));
        }
        controller.close();
      },
    });
    const vm = new ChatViewModel({
      chat: new ChatService({
        transport: new HttpTransport({
          fetch: async () => {
            started.resolve();
            return new Response(body);
          },
        }),
      }),
      conversation,
      initialMessages: [earlier],
      newClientId: idsFrom('cid_1'),
    });

    vm.setDraft('hi');
    const sending = vm.send();
    await started.promise;
    expect(vm.isStreaming).toBe(true);
    vm.reconcileServerSnapshot([{ ...earlier, content: 'refreshed' }]);
    expect(vm.transcript[0]?.content).toBe('earlier');

    finish.resolve();
    expect(await sending).toBe(true);
    expect(
      vm.transcript.map(({ serverId, content, state }) => ({ serverId, content, state })),
    ).toEqual([
      { serverId: earlier.id, content: 'refreshed', state: 'sent' },
      { serverId: stored.id, content: stored.content, state: 'sent' },
      { serverId: reply.id, content: reply.content, state: 'sent' },
    ]);
    const clientIds = vm.transcript.map(({ clientId }) => clientId);
    vm.reconcileServerSnapshot([earlier, stored, reply]);
    expect(vm.transcript.map(({ clientId }) => clientId)).toEqual(clientIds);
  });

  test('a seeded transcript is not re-fetched', async () => {
    const h = harness({ messages: [message({ content: 'earlier' })] });
    const vm = new ChatViewModel({
      chat: h.service,
      conversation,
      initialMessages: [message({ content: 'earlier' })],
    });

    await vm.initialize();

    expect(h.calls).toHaveLength(0);
    expect(vm.transcript[0]?.content).toBe('earlier');
  });

  test('without a seed it reads the history', async () => {
    const h = harness({ messages: [message({ content: 'earlier' })] });
    const vm = viewModel(h);

    await vm.initialize();

    expect(h.calls.map((c) => c.path)).toEqual(['/api/chat/conversations/cnv_1/messages']);
    expect(vm.transcript).toHaveLength(1);
  });

  test('a refreshed snapshot preserves unsent queue entries', async () => {
    const failing = harness({ failWith: new TypeError('down') });
    const vm = viewModel(failing, idsFrom('cid_1'));

    vm.setDraft('typed but unsent');
    await vm.send();
    expect(vm.queue).toHaveLength(1);

    vm.seed([message({ content: 'server view' })]);

    expect(vm.queue.map((entry) => entry.content)).toEqual(['typed but unsent']);
    expect(vm.transcript.map((m) => m.content)).toEqual(['server view']);
  });
});

describe('the two halves of the contract agree', () => {
  test('the reader refuses a frame the protocol does not declare', async () => {
    const bogus = 'event: delta\ndata: {"type":"teleport"}\n\n';
    const bytes = new TextEncoder().encode(`${bogus}${encodeSseDone()}`);
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const h = harness({ events: [] });
    const service = new ChatService({
      transport: streamTransport(h.service as unknown as ApiTransport, async () => response),
    });

    // Refused rather than skipped: a skipped frame loses a turn, and the symptom is
    // a reply that stops halfway with no error anywhere.
    await expect(service.streamTurn('cnv_1', { content: 'hi', clientId: 'c1' })).rejects.toThrow(
      /does not understand/,
    );
  });

  test('the frames the Worker encodes are the frames the client accepts', async () => {
    // The encoder lives in `@starter/schemas`, so this is really an assertion that
    // the two modules were not forked — stated here because it is the seam where a
    // fork would show up.
    const frame = encodeSseFrame({ type: 'delta', text: 'hi' });
    expect(frame).toContain('event: delta');
    expect(frame).toContain('data: {"type":"delta","text":"hi"}');
    expect(frame.endsWith('\n\n')).toBe(true);
  });
});

test('unsent retries retain queue order, and failed replies never requeue stored messages', async () => {
  let online = false;
  const service = new ChatService({
    transport: streamTransport(
      {
        async request<T>() {
          return {} as T;
        },
      },
      async (_input, init) => {
        if (!online) {
          throw new TypeError('offline');
        }
        const input = JSON.parse(String(init?.body)) as { clientId: string; content: string };
        return bodyFrom([
          {
            type: 'user-message',
            clientId: input.clientId,
            message: message({ content: input.content }),
          },
          { type: 'start', messageId: 'reply' },
          { type: 'error', code: 'model_failed', message: 'unavailable' },
        ]);
      },
    ),
  });
  const vm = new ChatViewModel({ chat: service, conversation, newClientId: idsFrom('one', 'two') });
  for (const content of ['one', 'two']) {
    vm.setDraft(content);
    await vm.send();
  }
  await vm.flush();
  expect(vm.queue.map((entry) => entry.clientId)).toEqual(['one', 'two']);
  expect(vm.queue[0]?.failure).toBe('Could not reach the server.');
  online = true;
  await vm.flush();
  expect(vm.queue.map((entry) => entry.clientId)).toEqual(['two']);
  expect(vm.transcript.find((entry) => entry.clientId === 'one')?.state).toBe('sent');
});

test('an abort before acknowledgement queues the original message for retry', async () => {
  const vm = viewModel(
    harness({ failWith: new DOMException('cancelled', 'AbortError') }),
    idsFrom('cid_1'),
  );
  vm.setDraft('hi');
  expect(await vm.send()).toBe(false);
  expect(vm.queue[0]?.clientId).toBe('cid_1');
  expect(vm.transcript).toHaveLength(0);
});

test('live updates preserve unrelated pending messages and are not replayed at completion', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let sawDelta!: () => void;
  const delta = new Promise<void>((resolve) => {
    sawDelta = resolve;
  });
  const service = new ChatService({
    onUpdate(update) {
      if (update.type === 'delta') {
        sawDelta();
      }
    },
    transport: streamTransport(
      {
        async request<T>() {
          return {} as T;
        },
      },
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
          }),
        ),
    ),
  });
  const vm = new ChatViewModel({ chat: service, conversation, newClientId: idsFrom('cid_1') });
  vm.messages = [
    {
      clientId: 'other',
      serverId: null,
      content: 'other',
      role: 'user',
      state: 'pending',
      createdAt: 0,
    },
  ];
  vm.setDraft('hi');
  const sending = vm.send();
  const emit = (event: ChatStreamEvent) =>
    controller.enqueue(new TextEncoder().encode(encodeSseFrame(event)));
  emit({ type: 'user-message', clientId: 'cid_1', message: message() });
  emit({ type: 'start', messageId: 'reply' });
  emit({ type: 'delta', text: 'partial' });
  await delta;
  expect(vm.isStreaming).toBe(true);
  expect(vm.transcript[0]?.serverId).toBeNull();
  expect(vm.transcript[2]?.content).toBe('partial');
  emit({
    type: 'complete',
    message: message({ id: 'reply', role: 'assistant', content: 'partial' }),
  });
  expect(await sending).toBe(true);
  expect(vm.transcript).toHaveLength(3);
  expect(vm.transcript[2]?.content).toBe('partial');
});
