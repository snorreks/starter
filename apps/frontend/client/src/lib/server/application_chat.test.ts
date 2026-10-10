// apps/frontend/client/src/lib/server/application_chat.test.ts
//
// The id the service mints, asserted at the layer that mints it.
//
// This is the seam where the bug lived. `packages/backend/database` proves the
// `admit_chat_generation` RPC works when handed a UUID — its own test mints one —
// and the unit tests above the route prove the flow with a repository that accepts
// any string. Nothing in between checked that the id the *application* generates is
// the shape the database requires, so a base-36 `createId` reached a `uuid` column
// and every chat message died as a 500.

import { describe, expect, test } from 'bun:test';
import type { ChatRepository } from '@starter/database/supabase';
import { createRequestChatService } from './application_chat.ts';
import type { ApplicationServices } from './supabase_context.ts';

const OWNER = '10000000-0000-4000-8000-000000000001';
const CONVERSATION = 'conv_6f1c8f0e-1f2a-4c3b-9a55-2f9a1d3c4b5e';

/** A repository that records what it was asked to admit, and answers plausibly. */
const recordingChat = () => {
  const admitted: { userMessageId: string; conversationId: string; fingerprint: string }[] = [];
  const repository = {
    listConversations: async () => [],
    findConversation: async () => null,
    createConversation: async () => {
      throw new Error('not used');
    },
    listMessages: async () => ({ items: [], nextCursor: null, hasMore: false, serverTime: 0 }),
    findMessageByClientId: async () => ({
      id: 'msg_stored',
      conversationId: CONVERSATION,
      authorId: OWNER,
      role: 'user' as const,
      content: 'hello',
      status: 'complete' as const,
      createdAt: 0,
    }),
    admitGeneration: async (input: {
      userMessageId: string;
      conversationId: string;
      fingerprint: string;
    }) => {
      admitted.push(input);
      return { outcome: 'admitted' as const, assistantMessageId: 'msg_assistant', attempt: 1 };
    },
    completeGeneration: async () => 'msg_assistant',
    failGeneration: async () => {},
  } as unknown as ChatRepository;
  return { repository, admitted };
};

const localsFor = (chat: ChatRepository) =>
  ({
    context: {
      user: { id: OWNER },
      services: { identity: { user: { id: OWNER } }, chat } as unknown as ApplicationServices,
    },
  }) as Parameters<typeof createRequestChatService>[0];

describe('admitting a chat turn', () => {
  test('the user message id is a prefixed UUID, because the column is a uuid', async () => {
    const { repository, admitted } = recordingChat();
    const service = createRequestChatService(localsFor(repository));

    const result = await service.appendUserMessage(OWNER, CONVERSATION, 'hello', 'cli_1');

    expect(result).toMatchObject({ outcome: 'admitted' });
    expect(admitted).toHaveLength(1);
    const { userMessageId } = admitted[0] as { userMessageId: string };
    // What the repository does with it: strip the prefix and hand the rest to
    // Postgres. That remainder has to be a UUID or the request fails with
    // `invalid input syntax for type uuid`.
    expect(userMessageId).toMatch(
      /^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test('and the fingerprint is the hex SHA-256 the RPC validates against', async () => {
    const { repository, admitted } = recordingChat();
    const service = createRequestChatService(localsFor(repository));

    await service.appendUserMessage(OWNER, CONVERSATION, 'hello', 'cli_1');

    // The migration refuses anything not `^[a-f0-9]{64}$`, so a base-16 encoding
    // bug here is a 500 as surely as a bad id.
    expect(admitted[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test('two turns do not reuse one id', async () => {
    const { repository, admitted } = recordingChat();
    const service = createRequestChatService(localsFor(repository));

    await service.appendUserMessage(OWNER, CONVERSATION, 'first', 'cli_1');
    await service.appendUserMessage(OWNER, CONVERSATION, 'second', 'cli_2');

    expect(admitted[0]?.userMessageId).not.toBe(admitted[1]?.userMessageId);
  });
});
