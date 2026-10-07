import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { decodeChatStream, isChatStreamEvent } from '@starter/schemas/chat';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { POST, _streamTurn } from '../../routes/api/chat/conversations/[id]/messages/+server.ts';
import { type ChatModel, createWorkersAiChatModel } from './chat_model.ts';
import { type ChatDatabase, createChatService } from './chat_service.ts';

const migrations = new URL(
  '../../../../../../packages/backend/database/drizzle-d1/',
  import.meta.url,
);
const setup = (legacy = false) => {
  const sql = new Database(':memory:');
  sql.run('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(migrations)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    if (legacy && file.startsWith('0006_')) {
      continue;
    }
    sql.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  sql.run(
    "INSERT INTO users (id,name,email) VALUES ('owner','Owner','owner@example.test'), ('other','Other','other@example.test')",
  );
  sql.run("INSERT INTO conversations (id,owner_id,title) VALUES ('conversation','owner','Chat')");
  // SQLite executes the same Drizzle statements as D1; only the driver differs.
  const db = drizzle(sql) as unknown as ChatDatabase;
  return { sql, db, service: createChatService(db) };
};

const post = async (db: ChatDatabase, model: ChatModel, signal?: AbortSignal) =>
  POST({
    locals: { user: { id: 'owner' }, container: { db, chatModel: model } },
    params: { id: 'conversation' },
    request: new Request('http://localhost/api/chat/conversations/conversation/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi', clientId: 'client' }),
      ...(signal === undefined ? {} : { signal }),
    }),
  } as unknown as Parameters<typeof POST>[0]);

test('conflict recovery cannot return another owners message', async () => {
  const { sql, service } = setup();
  try {
    await service.appendUserMessage('owner', 'conversation', 'private', 'client');
    expect(
      await service.appendUserMessage('other', 'conversation', 'attempt', 'client'),
    ).toBeNull();
    expect(
      (await service.appendUserMessage('owner', 'conversation', 'retry', 'client'))?.content,
    ).toBe('private');
  } finally {
    sql.close();
  }
});

test('refused persistence emits a valid not_persisted error instead of completion', async () => {
  const { sql, db } = setup();
  try {
    const response = await post(db, {
      profile: 'test',
      async *generate() {
        yield { text: 'partial' };
        sql.run("DELETE FROM conversations WHERE id='conversation'");
      },
    });
    const frames = decodeChatStream(await response.text());
    expect(frames.every(isChatStreamEvent)).toBe(true);
    expect(frames.some((frame) => frame.type === 'complete')).toBe(false);
    expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'not_persisted' });
  } finally {
    sql.close();
  }
});

test('abort while awaiting the models final chunk never persists a truncated reply', async () => {
  const { sql, db } = setup();
  const abort = new AbortController();
  try {
    const response = await post(
      db,
      {
        profile: 'test',
        async *generate() {
          yield { text: 'partial' };
          // The route has already checked cancellation before awaiting next().
          abort.abort();
          await Promise.resolve();
        },
      },
      abort.signal,
    );
    const frames = decodeChatStream(await response.text());
    expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'aborted' });
    expect(sql.query("SELECT id FROM messages WHERE role='assistant'").all()).toEqual([]);
  } finally {
    sql.close();
  }
});

test('the timestamp migration preserves history, constraints, and millisecond ordering', async () => {
  const { sql, service } = setup(true);
  try {
    sql.run(
      "INSERT INTO messages VALUES ('legacy','conversation','owner','user','old','legacy',1700000000)",
    );
    sql.exec(readFileSync(new URL('0006_message_timestamp_ms.sql', migrations), 'utf8'));
    expect((await service.messages('owner', 'conversation'))[0]?.createdAt).toBe(1700000000000);
    for (const [id, time] of [
      ['later', 1700000000123],
      ['earlier', 1700000000011],
    ] as const) {
      expect(
        (await service.appendAssistantMessage('owner', 'conversation', id, id, time))?.createdAt,
      ).toBe(time);
    }
    expect((await service.messages('owner', 'conversation')).map((message) => message.id)).toEqual([
      'legacy',
      'earlier',
      'later',
    ]);
    const before = Date.now();
    sql.run(
      "INSERT INTO messages (id,conversation_id,author_id,role,content,client_id) VALUES ('default','conversation','owner','user','default','default')",
    );
    const stored = (await service.messages('owner', 'conversation')).find(
      (message) => message.id === 'default',
    );
    expect(stored?.createdAt).toBeGreaterThanOrEqual(before);
    expect(stored?.createdAt).toBeLessThanOrEqual(Date.now());
    expect(() =>
      sql.run("INSERT INTO messages VALUES ('null','conversation','owner','user','x','null',NULL)"),
    ).toThrow();
    expect(() =>
      sql.run(
        "INSERT INTO messages VALUES ('duplicate','conversation','owner','user','x','legacy',1)",
      ),
    ).toThrow();
    expect(sql.query('PRAGMA foreign_key_check').all()).toEqual([]);
    sql.run("DELETE FROM conversations WHERE id='conversation'");
    expect(sql.query('SELECT * FROM messages').all()).toEqual([]);
  } finally {
    sql.close();
  }
});

test('cursor pages keep newest history visible and traverse more than 500 tied timestamps', async () => {
  const { sql, service } = setup();
  try {
    for (let index = 0; index < 537; index += 1) {
      const id = `msg_${String(index).padStart(4, '0')}`;
      sql.run(
        'INSERT INTO messages (id,conversation_id,author_id,role,content,client_id,created_at) VALUES (?,?,?,?,?,?,?)',
        [
          id,
          'conversation',
          'owner',
          index % 2 ? 'assistant' : 'user',
          `body-${index}`,
          `client-${index}`,
          1700000000000,
        ],
      );
    }
    const newestReload = await service.messagePage('owner', 'conversation', null);
    expect(newestReload.items).toHaveLength(50);
    expect(newestReload.items.at(-1)?.id).toBe('msg_0536');

    const seen = [...newestReload.items.map((message) => message.id)];
    let cursor = newestReload.nextCursor;
    while (cursor !== null) {
      const older = await service.messagePage('owner', 'conversation', cursor);
      seen.unshift(...older.items.map((message) => message.id));
      cursor = older.nextCursor;
    }
    expect(seen).toHaveLength(537);
    expect(new Set(seen).size).toBe(537);
    expect(seen[0]).toBe('msg_0000');
    expect(seen.at(-1)).toBe('msg_0536');
    await expect(service.messagePage('owner', 'conversation', '%%%')).rejects.toThrow('malformed');
    const foreign = btoa(
      JSON.stringify({
        ownerId: 'other',
        conversationId: 'conversation',
        createdAt: 1700000000000,
        id: 'msg_0500',
      }),
    );
    await expect(service.messagePage('owner', 'conversation', foreign)).rejects.toThrow(
      'malformed',
    );
  } finally {
    sql.close();
  }
});

test('injected deadline and output byte budgets end with validated failure frames and never persist', async () => {
  const { sql, service } = setup();
  const userMessage = await service.appendUserMessage(
    'owner',
    'conversation',
    'prompt',
    'turn-budget',
  );
  if (userMessage === null) {
    throw new Error('fixture message did not persist');
  }
  const persisted: string[] = [];
  const outcomes: string[] = [];
  try {
    const deadline = _streamTurn({
      model: {
        profile: 'delayed-fixture',
        async *generate(_prompt, signal) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (!signal.aborted) {
            yield { text: 'late' };
          }
        },
      },
      prompt: 'prompt',
      replyId: 'msg_deadline',
      conversationId: 'conversation',
      userMessage,
      clientId: 'turn-budget',
      signal: new AbortController().signal,
      deadlineMs: 1,
      persistAssistantReply: async () => {
        persisted.push('deadline');
        return null;
      },
      onTerminal: (outcome) => outcomes.push(outcome),
    });
    const deadlineEvents = decodeChatStream(await deadline.text());
    expect(deadlineEvents.at(-1)).toMatchObject({ type: 'error', code: 'aborted' });

    const output = _streamTurn({
      model: {
        profile: 'output-fixture',
        async *generate() {
          yield { text: '123' };
        },
      },
      prompt: 'prompt',
      replyId: 'msg_output',
      conversationId: 'conversation',
      userMessage,
      clientId: 'turn-budget',
      signal: new AbortController().signal,
      maxOutputBytes: 2,
      persistAssistantReply: async () => {
        persisted.push('output');
        return null;
      },
      onTerminal: (outcome) => outcomes.push(outcome),
    });
    const outputEvents = decodeChatStream(await output.text());
    expect(outputEvents.at(-1)).toMatchObject({ type: 'error', code: 'output_limit' });
    expect(persisted).toEqual([]);
    expect(outcomes).toEqual(['failed', 'failed']);
  } finally {
    sql.close();
  }
});

test('abort during a delayed Workers AI response forwards cancellation and persists no output', async () => {
  const { sql, db } = setup();
  const abort = new AbortController();
  let forwarded: AbortSignal | undefined;
  let providerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    providerStarted = resolve;
  });
  try {
    const model = createWorkersAiChatModel({
      binding: {
        async run(_model, _input, options) {
          forwarded = options?.signal as AbortSignal;
          providerStarted();
          await new Promise((resolve) => setTimeout(resolve, 20));
          return new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"response":"late"}\n\ndata: [DONE]\n\n'),
              );
              controller.close();
            },
          });
        },
      },
    });
    const response = await post(db, model, abort.signal);
    const reading = response.text();
    await started;
    abort.abort(new Error('navigation'));
    const events = decodeChatStream(await reading);
    expect(forwarded?.aborted).toBe(true);
    expect(events.some((event) => event.type === 'delta' || event.type === 'complete')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'aborted' });
    expect(sql.query("SELECT id FROM messages WHERE role='assistant'").all()).toEqual([]);
  } finally {
    sql.close();
  }
});
