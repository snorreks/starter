// packages/frontend/features/src/chat/chat_service.test.ts
//
// The client's half of chat: the two REST calls, and the stream reader.
//
// The reader tests use **real `ReadableStream`s** and the **real encoder** rather
// than fixtures. That is the point of this file: a hand-written fixture can agree
// with a broken reader, and a broken reader loses exactly one message — the symptom
// is a reply that stops halfway with nothing in the console.

import { describe, expect, test } from 'bun:test';
import {
  type ApiTransport,
  type FetchLike,
  HttpTransport,
  type StreamingTransport,
  type TransportRequestOptions,
} from '@starter/platform';
import { type ChatStreamEvent, encodeSseDone, encodeSseFrame } from '@starter/schemas/chat';
import { ChatService, readChatFrames } from './chat_service.ts';

const streamTransport = (transport: ApiTransport, fetchImpl: FetchLike): StreamingTransport => ({
  ...transport,
  openStream: (path: string, options?: TransportRequestOptions) =>
    new HttpTransport({ fetch: fetchImpl }).openStream(path, options),
});

const conversation = {
  id: 'cnv_1',
  ownerId: 'usr_1',
  organizationId: null,
  title: 'Test',
  messageCount: 0,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const message = {
  id: 'msg_1',
  conversationId: 'cnv_1',
  authorId: 'usr_1',
  role: 'user' as const,
  content: 'hi',
  status: 'complete' as const,
  createdAt: 1_700_000_000_000,
};

const transportReturning = (
  body: unknown,
  calls: { path: string; options?: TransportRequestOptions }[] = [],
): StreamingTransport => ({
  openStream: (path: string, options?: TransportRequestOptions) =>
    new HttpTransport().openStream(path, options),
  async request<T>(path: string, options?: TransportRequestOptions): Promise<T> {
    calls.push({ path, options });
    return body as T;
  },
});

/** The frames the Worker sends, as a body split into `chunkSize`-byte reads. */
const streamOf = (events: ChatStreamEvent[], chunkSize = 4096): Response => {
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
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};

describe('the REST calls', () => {
  test('listing conversations checks the answer against the shared schema', async () => {
    const calls: { path: string; options?: TransportRequestOptions }[] = [];
    const service = new ChatService({
      transport: transportReturning({ conversations: [conversation], serverTime: 5 }, calls),
    });

    expect(await service.listConversations()).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/chat/conversations');
    expect(calls[0]?.options?.method).toBe('GET');
  });

  test('a response that is not a conversation list is refused', async () => {
    // An HTML error page from a proxy would otherwise reach a ViewModel as "no
    // conversations", and the user would read that as having lost their history.
    const service = new ChatService({ transport: transportReturning('<html>502</html>') });

    await expect(service.listConversations()).rejects.toThrow(/does not understand/);
  });

  test('creating a conversation posts the body it was given', async () => {
    const calls: { path: string; options?: TransportRequestOptions }[] = [];
    const service = new ChatService({ transport: transportReturning(conversation, calls) });

    const created = await service.createConversation({ title: 'Hello' });

    expect(created.id).toBe('cnv_1');
    expect(calls[0]?.options?.body).toEqual({ title: 'Hello' });
  });

  test('the conversation id is escaped into the path', async () => {
    const calls: { path: string; options?: TransportRequestOptions }[] = [];
    const service = new ChatService({
      transport: transportReturning({ messages: [], serverTime: 0 }, calls),
    });

    await service.listMessages('cnv/../admin');

    // Without escaping, this path would leave the conversation and read another.
    expect(calls[0]?.path).toBe('/api/chat/conversations/cnv%2F..%2Fadmin/messages');
  });
});

describe('the stream reader', () => {
  test('reads every frame the Worker sends', async () => {
    const events: ChatStreamEvent[] = [
      { type: 'user-message', clientId: 'c1', message },
      { type: 'start', messageId: 'msg_reply' },
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
      { type: 'complete', message: { ...message, role: 'assistant', content: 'ab' } },
    ];
    const service = new ChatService({
      transport: streamTransport(transportReturning({}), async () => streamOf(events)),
      retainEvents: true,
    });

    const result = await service.streamTurn('cnv_1', { content: 'hi', clientId: 'c1' });

    expect(result.text).toBe('ab');
    expect(result.events).toHaveLength(5);
    expect(result.message?.id).toBe('msg_1');
  });

  test('a frame split byte-by-byte still parses', async () => {
    // Every frame boundary falls inside a read. A reader that assumed a chunk held
    // whole frames would drop or corrupt all of them.
    const events: ChatStreamEvent[] = [
      { type: 'user-message', clientId: 'c1', message },
      { type: 'start', messageId: 'r1' },
      { type: 'delta', text: 'hello' },
      { type: 'complete', message: { ...message, role: 'assistant', content: 'hello' } },
    ];
    const service = new ChatService({
      transport: streamTransport(transportReturning({}), async () => streamOf(events, 1)),
    });

    expect((await service.streamTurn('cnv_1', { content: 'hi', clientId: 'c1' })).text).toBe(
      'hello',
    );
  });

  test('a multi-byte character split across a chunk boundary survives', async () => {
    // `€` is three UTF-8 bytes. A decoder that did not carry an incomplete sequence
    // over to the next chunk would emit a replacement character, and the reply the
    // user reads would differ from the one the model produced.
    const text = 'a€b';
    const bytes = new TextEncoder().encode(
      `${encodeSseFrame({ type: 'delta', text })}${encodeSseFrame({ type: 'complete', message: { ...message, role: 'assistant', content: text } })}${encodeSseDone()}`,
    );
    const euroIndex = bytes.indexOf(0xe2);

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!started) {
          started = true;
          // Cut two bytes into the three-byte euro sign.
          controller.enqueue(bytes.slice(0, euroIndex + 1));
          return;
        }
        controller.enqueue(bytes.slice(euroIndex + 1));
        controller.close();
      },
    });
    let started = false;

    const service = new ChatService({
      transport: streamTransport(
        transportReturning({}),
        async () => new Response(body, { status: 200 }),
      ),
    });

    const result = await service.streamTurn('cnv_1', { content: 'hi', clientId: 'c1' });

    expect(result.text).toBe(text);
  });

  test('the done sentinel produces no frame', async () => {
    const service = new ChatService({
      transport: streamTransport(transportReturning({}), async () =>
        streamOf([
          { type: 'delta', text: 'x' },
          { type: 'complete', message: { ...message, role: 'assistant', content: 'x' } },
        ]),
      ),
      retainEvents: true,
    });

    const result = await service.streamTurn('cnv_1', { content: 'hi', clientId: 'c1' });

    expect(result.events).toHaveLength(2);
  });

  test('onUpdate is called once per frame, as it arrives', async () => {
    const events: ChatStreamEvent[] = [
      { type: 'start', messageId: 'r1' },
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
      { type: 'complete', message: { ...message, role: 'assistant', content: 'ab' } },
    ];
    const seen: string[] = [];
    const service = new ChatService({
      onUpdate: (update) => {
        seen.push(update.delta ?? update.replyId ?? '');
      },
      transport: streamTransport(transportReturning({}), async () => streamOf(events)),
    });

    await service.streamTurn('cnv_1', { content: 'hi', clientId: 'c1' });

    expect(seen).toEqual(['r1', 'a', 'b', '']);
  });

  test('a terminal error frame resolves with a failure rather than rejecting', async () => {
    // Resolving, not rejecting: the HTTP status was spent when the first frame went
    // out, so a rejection here would be the transport's error rather than the
    // model's, and the caller would report the wrong thing.
    const service = new ChatService({
      transport: streamTransport(transportReturning({}), async () =>
        streamOf([
          { type: 'user-message', clientId: 'c1', message },
          { type: 'start', messageId: 'r1' },
          { type: 'delta', text: 'partial' },
          { type: 'error', code: 'model_failed', message: 'The model is unavailable.' },
        ]),
      ),
    });

    const result = await service.streamTurn('cnv_1', { content: 'hi', clientId: 'c1' });

    expect(result.failure?.code).toBe('model_failed');
    expect(result.failure?.message).toBe('The model is unavailable.');
    expect(result.message).toBeUndefined();
  });

  test('a response with no body is refused', async () => {
    const service = new ChatService({
      transport: streamTransport(
        transportReturning({}),
        async () => new Response(null, { status: 200 }),
      ),
    });

    await expect(service.streamTurn('cnv_1', { content: 'hi', clientId: 'c1' })).rejects.toThrow(
      /no body/,
    );
  });
});

describe('a refusal before the first frame', () => {
  test('a 404 is reported as not found, with the server own message', async () => {
    const service = new ChatService({
      transport: streamTransport(
        transportReturning({}),
        async () =>
          new Response(
            JSON.stringify({ error: 'not_found', message: 'That conversation does not exist.' }),
            {
              status: 404,
            },
          ),
      ),
    });

    await expect(
      service.streamTurn('cnv_missing', { content: 'hi', clientId: 'c1' }),
    ).rejects.toThrow('That conversation does not exist.');
  });

  test('an HTML error page does not become the message', async () => {
    const service = new ChatService({
      transport: streamTransport(
        transportReturning({}),
        async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 }),
      ),
    });

    // Proxy HTML stays out of the message shown to a user.
    await expect(service.streamTurn('cnv_1', { content: 'hi', clientId: 'c1' })).rejects.toThrow(
      /The request failed/,
    );
  });

  test('the request carries the body and the SSE accept header', async () => {
    const seen: { headers: HeadersInit | undefined; body: BodyInit | null | undefined }[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      seen.push({ headers: init?.headers, body: init?.body });
      return streamOf([{ type: 'complete', message }]);
    };
    const service = new ChatService({
      transport: streamTransport(transportReturning({}), fetchImpl),
    });

    await service.streamTurn('cnv_1', { content: 'hi', clientId: 'c1' });

    const headers = new Headers(seen[0]?.headers);
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get('content-type')).toBe('application/json');
    expect(String(seen[0]?.body)).toBe(JSON.stringify({ content: 'hi', clientId: 'c1' }));
  });
});

describe('the reader as a unit', () => {
  test('yields each data payload once', async () => {
    const body = new TextEncoder().encode(
      `${encodeSseFrame({ type: 'delta', text: 'a' })}${encodeSseFrame({ type: 'delta', text: 'b' })}`,
    );
    const frames: unknown[] = [];

    for await (const frame of readChatFrames(
      new Response(body).body as ReadableStream<Uint8Array>,
    )) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
    ]);
  });

  test('a frame with no data yields nothing', async () => {
    const body = new TextEncoder().encode(`: ${'__done__'}\n\nevent: ping\n\n`);

    const frames: unknown[] = [];
    for await (const frame of readChatFrames(
      new Response(body).body as ReadableStream<Uint8Array>,
    )) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(0);
  });
});

test('EOF without a terminal frame reports truncation', async () => {
  for (const events of [
    [],
    [
      { type: 'start', messageId: 'reply' },
      { type: 'delta', text: 'partial' },
    ],
  ] as ChatStreamEvent[][]) {
    const service = new ChatService({
      transport: streamTransport(transportReturning({}), async () => streamOf(events)),
    });
    const result = await service.streamTurn('cnv_1', { content: 'hi', clientId: 'cid' });
    expect(result.failure?.code).toBe('truncated');
    expect(result.message).toBeUndefined();
  }
});

test('rejecting a frame cancels the unfinished reader and releases its lock', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"unknown"}\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const service = new ChatService({
    transport: streamTransport(transportReturning({}), async () => new Response(body)),
  });
  await expect(service.streamTurn('cnv_1', { content: 'hi', clientId: 'cid' })).rejects.toThrow();
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

test('chat streaming goes through the injected transport origin and credentials', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const service = new ChatService({
    transport: new HttpTransport({
      baseUrl: 'https://host.example.test',
      credentials: 'omit',
      headers: { authorization: 'Bearer current' },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return streamOf([{ type: 'complete', message }]);
      },
    }),
  });
  await service.streamTurn('cnv_1', { content: 'hi', clientId: 'cid' });
  expect(calls[0]?.url).toBe('https://host.example.test/api/chat/conversations/cnv_1/messages');
  expect(calls[0]?.init?.credentials).toBe('omit');
  expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer current');
});

test('a stream keeps no event history unless explicitly requested', async () => {
  const service = new ChatService({
    transport: new HttpTransport({
      fetch: async () =>
        streamOf([
          { type: 'delta', text: 'partial' },
          { type: 'complete', message },
        ]),
    }),
  });
  expect(
    (await service.streamTurn('cnv_1', { content: 'hi', clientId: 'cid' })).events,
  ).toHaveLength(0);
});

test('an oversized unfinished frame is refused and its reader cancelled', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${'x'.repeat(1_048_577)}\n\n`));
    },
    cancel() {
      cancelled = true;
    },
  });
  const consume = async () => {
    for await (const _frame of readChatFrames(body)) {
      /* consume */
    }
  };
  await expect(consume()).rejects.toThrow(/too large/);
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

test('CRLF delimiters split across chunks preserve complete frames', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"delta","text":"hi"}\r\n\r\n');
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
      } else {
        controller.enqueue(bytes.slice(offset, ++offset));
      }
    },
  });
  const frames = [];
  for await (const frame of readChatFrames(body)) {
    frames.push(frame);
  }
  expect(frames).toEqual([{ type: 'delta', text: 'hi' }]);
});
