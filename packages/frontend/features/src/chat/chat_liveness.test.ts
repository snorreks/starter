// packages/frontend/features/src/chat/chat_liveness.test.ts
//
// The liveness wiring on both chat screens.
//
// What these are for: the report this answers was "it is not reactive, I have to
// press refresh". So the first two tests drive the thing that was broken — a
// message or a conversation written by somebody else, arriving with no navigation
// and no button — and the rest cover the properties that make that safe to ship:
// the screen does not lie about how live it is, does not re-read over its own turn,
// does not turn a failed background read into an error, and stops reading once it
// is closed.
//
// The `LiveUpdates` here is a **fake on purpose**. The transport's own timing is
// proven in `packages/shared/live`; what is unproven at this level is a screen's
// reaction to an invalidation, and a real timer would make that a slow test that
// passes when it should fail.

import { describe, expect, test } from 'bun:test';
import { createManualLiveUpdates, type LiveUpdates } from '@starter/live';
import {
  type ApiTransport,
  type FetchLike,
  HttpTransport,
  type StreamingTransport,
  type TransportRequestOptions,
} from '@starter/platform';
import {
  type ChatStreamEvent,
  type Conversation,
  encodeSseDone,
  encodeSseFrame,
  type Message,
} from '@starter/schemas/chat';
import { ChatListViewModel } from './chat_list_view_model.svelte.ts';
import { ChatService } from './chat_service.ts';
import { ChatViewModel } from './chat_view_model.svelte.ts';

const OWNER = 'f45b2c4a-7919-4f55-ae89-e73f6753e322';

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: 'cnv_1',
  ownerId: OWNER,
  organizationId: null,
  title: 'Test',
  messageCount: 0,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'msg_1',
  conversationId: 'cnv_1',
  authorId: OWNER,
  role: 'user',
  content: 'hi',
  status: 'complete',
  createdAt: 1_700_000_000_000,
  ...overrides,
});

/** One turn's worth of frames, chunked so the real reader is exercised. */
const bodyFrom = (events: ChatStreamEvent[]): Response => {
  const bytes = new TextEncoder().encode(
    `${events.map(encodeSseFrame).join('')}${encodeSseDone()}`,
  );
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + 64));
        offset += 64;
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};

/**
 * A server the test moves underneath the screen.
 *
 * Holds the REST surface the two screens read, plus a create, because one of the
 * merge rules is about a conversation this tab created and the server has not yet
 * acknowledged — and that rule is only reachable through the real create path.
 */
const server = () => {
  let messages: Message[] = [];
  let conversations: Conversation[] = [];
  let reads = 0;
  let failNext = false;
  let nextId = 0;

  const transport: ApiTransport = {
    async request<T>(path: string, options?: TransportRequestOptions): Promise<T> {
      if (options?.method === 'POST' && path.endsWith('/conversations')) {
        const body = options.body as { title: string };
        nextId += 1;
        const created = conversation({ id: `cnv_new_${nextId}`, title: body.title });
        // Deliberately NOT added to `conversations`: the acknowledgement has not
        // reached this server's own list yet, which is the case under test.
        return created as T;
      }
      reads += 1;
      if (failNext) {
        failNext = false;
        throw new Error('the network went away');
      }
      if (path.includes('/messages/page')) {
        return { items: messages, nextCursor: null, hasMore: false } as T;
      }
      if (path.endsWith('/messages')) {
        return { messages, serverTime: 0 } as T;
      }
      return { conversations, serverTime: 0 } as T;
    },
  };

  const turnFrames: ChatStreamEvent[] = [
    { type: 'user-message', clientId: 'cid_1', message: message({ id: 'msg_stored' }) },
    { type: 'start', messageId: 'msg_reply' },
    { type: 'delta', text: 'ok' },
    { type: 'complete', message: message({ id: 'msg_reply', role: 'assistant', content: 'ok' }) },
  ];

  const fetchImpl: FetchLike = async () => bodyFrom(turnFrames);
  const streaming: StreamingTransport = {
    ...transport,
    openStream: (path: string, options?: TransportRequestOptions) =>
      new HttpTransport({ fetch: fetchImpl }).openStream(path, options),
  };

  return {
    service: new ChatService({ transport: streaming }),
    reads: () => reads,
    setMessages: (next: Message[]) => {
      messages = next;
    },
    setConversations: (next: Conversation[]) => {
      conversations = next;
    },
    failOnce: () => {
      failNext = true;
    },
  };
};

/** A `LiveUpdates` whose invalidations the test fires by hand. */
const liveFake = () => {
  const subscriptions = new Map<string, Set<() => void>>();
  let changeReports = 0;
  let refreshes = 0;

  const transport: LiveUpdates = {
    mode: 'polling',
    observe: (listener) => {
      listener('polling');
      return () => undefined;
    },
    subscribe: (topic, onInvalidated) => {
      const set = subscriptions.get(topic) ?? new Set();
      set.add(onInvalidated);
      subscriptions.set(topic, set);
      return {
        notifyChanged: () => {
          changeReports += 1;
        },
        close: () => {
          set.delete(onInvalidated);
        },
      };
    },
    refresh: () => {
      refreshes += 1;
      for (const set of subscriptions.values()) {
        for (const listener of set) {
          listener();
        }
      }
    },
    close: () => {
      subscriptions.clear();
    },
  };

  /** Fire an invalidation and let the screen's asynchronous read settle. */
  const fire = async (topic: string): Promise<void> => {
    for (const listener of subscriptions.get(topic) ?? []) {
      listener();
    }
    await settle();
  };

  return {
    transport,
    fire,
    changeReports: () => changeReports,
    refreshes: () => refreshes,
    topics: () =>
      [...subscriptions.entries()].filter(([, set]) => set.size > 0).map(([topic]) => topic),
    subscribers: (topic: string) => subscriptions.get(topic)?.size ?? 0,
  };
};

/** Two macrotask turns: enough for an `await`ed read to finish applying. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('something written somewhere else', () => {
  test('a reply appears with no navigation and no refresh button', async () => {
    const backend = server();
    const live = liveFake();
    const vm = new ChatViewModel({
      chat: backend.service,
      conversation: conversation(),
      initialMessages: [message()],
      live: live.transport,
    });
    await vm.initialize();

    backend.setMessages([message(), message({ id: 'msg_2', role: 'assistant', content: 'hello' })]);

    // Nothing was pressed and no load re-ran. This is the whole report.
    expect(vm.transcript).toHaveLength(1);
    await live.fire('conversation:cnv_1');
    expect(vm.transcript).toHaveLength(2);
    expect(vm.transcript[1]?.content).toBe('hello');

    await vm.dispose();
  });

  test('a conversation started elsewhere appears on the list', async () => {
    const backend = server();
    const live = liveFake();
    const vm = new ChatListViewModel({
      chat: backend.service,
      navigation: { go: async () => undefined },
      initialConversations: [],
      live: live.transport,
    });
    await vm.initialize();
    expect(vm.conversations).toHaveLength(0);

    backend.setConversations([conversation({ id: 'cnv_2', title: 'Started elsewhere' })]);
    await live.fire('conversations');

    expect(vm.conversations).toHaveLength(1);
    expect(vm.conversations[0]?.title).toBe('Started elsewhere');
    await vm.dispose();
  });
});

describe('what the screen claims about itself', () => {
  test('a host with no liveness source says disabled rather than implying live', async () => {
    const backend = server();
    const vm = new ChatViewModel({ chat: backend.service, conversation: conversation() });
    expect(vm.liveMode).toBe('disabled');

    const list = new ChatListViewModel({
      chat: backend.service,
      navigation: { go: async () => undefined },
    });
    expect(list.liveMode).toBe('disabled');
    await Promise.all([vm.dispose(), list.dispose()]);
  });

  test('a disabled transport really delivers nothing, not merely says so', async () => {
    const backend = server();
    const manual = createManualLiveUpdates();
    const vm = new ChatViewModel({
      chat: backend.service,
      conversation: conversation(),
      live: manual,
    });
    await vm.initialize();
    backend.setMessages([message(), message({ id: 'msg_2' })]);

    manual.refresh();
    await settle();

    expect(vm.liveMode).toBe('disabled');
    expect(vm.transcript).toHaveLength(0);
    await vm.dispose();
  });

  test('a polling host says polling, so a degradation is visible rather than silent', async () => {
    const backend = server();
    const vm = new ChatViewModel({
      chat: backend.service,
      conversation: conversation(),
      live: reportingLive('polling'),
    });
    expect(vm.liveMode).toBe('polling');
    await vm.dispose();
  });
});

describe('a background re-read', () => {
  test('reports a change only when the server view actually moved', async () => {
    const backend = server();
    const live = liveFake();
    const vm = new ChatViewModel({
      chat: backend.service,
      conversation: conversation(),
      initialMessages: [message()],
      live: live.transport,
    });
    await vm.initialize();

    backend.setMessages([message()]);
    await live.fire('conversation:cnv_1');
    expect(live.changeReports()).toBe(0);

    backend.setMessages([message(), message({ id: 'msg_2' })]);
    await live.fire('conversation:cnv_1');
    expect(live.changeReports()).toBe(1);

    await vm.dispose();
  });

  test('that fails leaves the transcript alone rather than showing an error', async () => {
    const backend = server();
    const live = liveFake();
    const vm = new ChatViewModel({
      chat: backend.service,
      conversation: conversation(),
      initialMessages: [message()],
      live: live.transport,
    });
    await vm.initialize();

    backend.failOnce();
    await live.fire('conversation:cnv_1');

    // The transcript the user was reading is intact, and a timed-out poll has not
    // replaced it with an error.
    expect(vm.transcript).toHaveLength(1);
    expect(vm.status.kind).toBe('ready');

    // And the next interval still works.
    backend.setMessages([message(), message({ id: 'msg_2' })]);
    await live.fire('conversation:cnv_1');
    expect(vm.transcript).toHaveLength(2);

    await vm.dispose();
  });

  test('does not drop a conversation this tab created but the server has not echoed', async () => {
    const backend = server();
    const live = liveFake();
    const vm = new ChatListViewModel({
      chat: backend.service,
      navigation: { go: async () => undefined },
      initialConversations: [],
      live: live.transport,
    });
    await vm.initialize();

    vm.setDraftTitle('Mine');
    const created = await vm.create();
    expect(created.kind).toBe('created');
    expect(vm.conversations).toHaveLength(1);

    // The server's list still knows nothing about it.
    backend.setConversations([conversation({ id: 'cnv_other', title: 'Theirs' })]);
    await live.fire('conversations');

    // Both: the one just created here has not blinked out of the list it was
    // added to, and the one created elsewhere has appeared.
    expect(vm.conversations.map((entry) => entry.title).sort()).toEqual(['Mine', 'Theirs']);
    await vm.dispose();
  });
});

describe('a screen that is busy or gone', () => {
  test('does not re-read over a turn it is already streaming', async () => {
    const backend = server();
    const live = liveFake();
    const vm = new ChatViewModel({
      chat: backend.service,
      conversation: conversation(),
      initialMessages: [message()],
      live: live.transport,
    });
    await vm.initialize();

    vm.setDraft('hi');
    const sending = vm.send();
    const duringTurn = backend.reads();
    await live.fire('conversation:cnv_1');
    // The read the fire *could* have caused did not happen: a screen that re-read
    // over its own stream would be fetching an answer it already has.
    expect(backend.reads()).toBe(duringTurn);
    await sending;

    await vm.dispose();
  });

  test('stops reading once it is disposed', async () => {
    const backend = server();
    const live = liveFake();
    const vm = new ChatViewModel({
      chat: backend.service,
      conversation: conversation(),
      initialMessages: [message()],
      live: live.transport,
    });
    await vm.initialize();
    expect(live.subscribers('conversation:cnv_1')).toBe(1);

    await vm.dispose();
    expect(live.subscribers('conversation:cnv_1')).toBe(0);

    const after = backend.reads();
    backend.setMessages([message(), message({ id: 'msg_2' })]);
    await live.fire('conversation:cnv_1');

    expect(backend.reads()).toBe(after);
    expect(vm.transcript).toHaveLength(1);
  });
});

describe('a window that comes back', () => {
  test('refreshNow re-reads at once, because the host said the window returned', async () => {
    const backend = server();
    const live = liveFake();
    const vm = new ChatViewModel({
      chat: backend.service,
      conversation: conversation(),
      initialMessages: [message()],
      live: live.transport,
    });
    await vm.initialize();

    backend.setMessages([message(), message({ id: 'msg_2' })]);
    vm.refreshNow();
    await settle();

    expect(live.refreshes()).toBe(1);
    expect(vm.transcript).toHaveLength(2);
    await vm.dispose();
  });

  test('each screen watches its own topic, and both close cleanly', async () => {
    const backend = server();
    const live = liveFake();
    const list = new ChatListViewModel({
      chat: backend.service,
      navigation: { go: async () => undefined },
      initialConversations: [],
      live: live.transport,
    });
    await list.initialize();
    expect(live.topics()).toEqual(['conversations']);

    const transcript = new ChatViewModel({
      chat: backend.service,
      conversation: conversation(),
      initialMessages: [],
      live: live.transport,
    });
    await transcript.initialize();
    expect(live.topics().sort()).toEqual(['conversation:cnv_1', 'conversations']);

    await transcript.dispose();
    await list.dispose();
    expect(live.topics()).toEqual([]);
  });
});

/** A `LiveUpdates` that reports a fixed mode and delivers nothing. */
const reportingLive = (mode: 'polling' | 'live'): LiveUpdates => ({
  mode,
  observe: (listener) => {
    listener(mode);
    return () => undefined;
  },
  subscribe: () => ({ notifyChanged: () => undefined, close: () => undefined }),
  refresh: () => undefined,
  close: () => undefined,
});

describe('a turn that is already running on another connection', () => {
  /** A transport whose POST is refused with the endpoint's `running` 409. */
  const runningServer = (status: number, body: unknown) => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const streaming: StreamingTransport = {
      request: async <T>() => ({ messages: [], serverTime: 0 }) as T,
      openStream: (path: string, options?: TransportRequestOptions) =>
        new HttpTransport({ fetch: fetchImpl }).openStream(path, options),
    };
    return new ChatService({ transport: streaming });
  };

  const transcript = (service: ChatService) =>
    new ChatViewModel({
      chat: service,
      conversation: conversation(),
      initialMessages: [],
      newClientId: () => 'cid_1',
    });

  test('keeps the message instead of queueing a duplicate the server would refuse', async () => {
    const vm = transcript(
      runningServer(409, { code: 'running', generationId: 'msg_gen', recoverable: true }),
    );

    vm.setDraft('hi');
    await vm.send();

    // The row is on the server. Removing it and queueing it would re-submit a
    // stored message, which is refused again — forever.
    expect(vm.hasQueue).toBe(false);
    expect(vm.queue).toHaveLength(0);
    expect(vm.transcript).toHaveLength(1);
    expect(vm.transcript[0]?.content).toBe('hi');
    expect(vm.transcript[0]?.state).toBe('sent');
    vm.messages = [
      ...vm.messages,
      {
        clientId: 'unrelated',
        serverId: null,
        role: 'user',
        content: 'local draft',
        state: 'pending',
        createdAt: 0,
      },
    ];
    vm.reconcileServerSnapshot([message({ id: 'server_copy', content: 'hi' })]);
    expect(vm.transcript.map((row) => row.content)).toEqual(['hi', 'local draft']);
    expect(vm.transcript[0]?.serverId).toBe('server_copy');
    await vm.dispose();
  });

  test('does not claim the screen is still streaming once it has stood down', async () => {
    const vm = transcript(
      runningServer(409, { code: 'running', generationId: 'msg_gen', recoverable: true }),
    );
    vm.setDraft('hi');
    await vm.send();

    expect(vm.isStreaming).toBe(false);
    expect(vm.isBusy).toBe(false);
    // And the composer is usable again, which is what "stood down" means to a user.
    expect(vm.canSend).toBe(false); // no draft left
    vm.setDraft('again');
    expect(vm.canSend).toBe(true);
    await vm.dispose();
  });

  test('an unrelated 409 is still a refusal, and is queued for retry', async () => {
    const vm = transcript(
      runningServer(409, {
        code: 'conflict',
        message: 'This idempotency key was already used with different content.',
      }),
    );

    vm.setDraft('hi');
    await vm.send();

    // `conflict` is terminal: retrying cannot help, but the message must not be
    // silently dropped either, so it is queued and shown with its reason.
    expect(vm.transcript).toHaveLength(0);
    expect(vm.hasQueue).toBe(true);
    expect(vm.queue[0]?.content).toBe('hi');
    await vm.dispose();
  });

  test('a non-409 failure is unaffected', async () => {
    const vm = transcript(runningServer(500, { code: 'server_error', message: 'boom' }));
    vm.setDraft('hi');
    await vm.send();

    expect(vm.hasQueue).toBe(true);
    await vm.dispose();
  });
});

for (const screen of ['list', 'conversation'] as const) {
  test(`${screen} background invalidation cannot cancel an explicit load`, async () => {
    let reads = 0;
    let signal: AbortSignal | undefined;
    const response = Promise.withResolvers<unknown>();
    const chat = new ChatService({
      transport: {
        openStream: async () => {
          throw new Error('This load must not open a stream.');
        },
        request: async <T>(_path: string, options?: TransportRequestOptions): Promise<T> => {
          reads += 1;
          signal = options?.signal;
          return (await response.promise) as T;
        },
      },
    });
    const live = liveFake();
    const vm =
      screen === 'list'
        ? new ChatListViewModel({
            chat,
            live: live.transport,
            navigation: { go: async () => undefined },
          })
        : new ChatViewModel({ chat, live: live.transport, conversation: conversation() });
    const loading = vm.initialize();
    await live.fire(screen === 'list' ? 'conversations' : 'conversation:cnv_1');
    expect(reads).toBe(1);
    expect(signal?.aborted).toBe(false);
    response.resolve(
      screen === 'list'
        ? { conversations: [conversation()], serverTime: 0 }
        : { messages: [message()], serverTime: 0 },
    );
    await loading;
    expect(vm.status.kind).toBe('ready');
    await vm.dispose();
  });
}
