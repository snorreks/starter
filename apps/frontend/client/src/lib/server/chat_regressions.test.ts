import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { decodeChatStream, isChatStreamEvent } from '@starter/schemas/chat';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { POST } from '../../routes/api/chat/conversations/[id]/messages/+server.ts';
import type { ChatModel } from './chat_model.ts';
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
