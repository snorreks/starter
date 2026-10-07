import type { Conversation, Message, MessagePage } from '@starter/schemas/chat';
import { MessageCursorError } from '@starter/schemas/chat';
import type { SupabaseClient } from './client.ts';
import type { Database } from './database.types.ts';

export interface ChatGenerationAdmission {
  outcome: 'admitted' | 'running' | 'completed' | 'conflict';
  assistantMessageId: string;
  attempt: number;
}
export interface ChatRepository {
  createConversation(ownerId: string, title: string): Promise<Conversation>;
  findConversation(ownerId: string, id: string): Promise<Conversation | null>;
  findMessageByClientId(
    ownerId: string,
    conversationId: string,
    clientId: string,
  ): Promise<Message | null>;
  listConversations(ownerId: string, page: number): Promise<Conversation[]>;
  listMessages(
    ownerId: string,
    conversationId: string,
    cursor: string | null,
  ): Promise<MessagePage>;
  admitGeneration(input: {
    conversationId: string;
    clientId: string;
    fingerprint: string;
    userMessageId: string;
    content: string;
  }): Promise<ChatGenerationAdmission>;
  completeGeneration(input: {
    conversationId: string;
    clientId: string;
    attempt: number;
    content: string;
  }): Promise<string>;
  failGeneration(input: {
    conversationId: string;
    clientId: string;
    attempt: number;
    state: 'failed' | 'cancelled';
  }): Promise<void>;
}
const fromDbId = (value: string, prefix: string): string => `${prefix}_${value}`;
const toDbId = (value: string): string => value.slice(value.indexOf('_') + 1);

export const createSupabaseChatRepository = (
  client: SupabaseClient<Database>,
  adminClient?: SupabaseClient<Database>,
): ChatRepository => ({
  async createConversation(ownerId, title) {
    const { data, error } = await client
      .from('conversations')
      .insert({ owner_id: ownerId, title })
      .select('*')
      .single();
    if (error !== null || data === null) {
      throw new Error(
        `Supabase chat repository: ${error?.message ?? 'conversation insert returned no row'}`,
      );
    }
    return {
      id: fromDbId(data.id, 'conv'),
      ownerId: data.owner_id,
      organizationId: null,
      title: data.title,
      messageCount: 0,
      createdAt: Date.parse(data.created_at),
      updatedAt: Date.parse(data.updated_at),
    };
  },
  async findConversation(ownerId, id) {
    const { data, error } = await client
      .from('conversations')
      .select('*, messages(count)')
      .eq('owner_id', ownerId)
      .eq('id', toDbId(id))
      .maybeSingle();
    if (error !== null) {
      throw new Error(`Supabase chat repository: ${error.message}`);
    }
    return data === null
      ? null
      : {
          id: fromDbId(data.id, 'conv'),
          ownerId: data.owner_id,
          organizationId: null,
          title: data.title,
          messageCount: data.messages?.[0]?.count ?? 0,
          createdAt: Date.parse(data.created_at),
          updatedAt: Date.parse(data.updated_at),
        };
  },
  async findMessageByClientId(ownerId, conversationId, clientId) {
    const { data, error } = await client
      .from('messages')
      .select('*, conversations!inner(owner_id)')
      .eq('conversations.owner_id', ownerId)
      .eq('conversation_id', toDbId(conversationId))
      .eq('client_id', clientId)
      .maybeSingle();
    if (error !== null) {
      throw new Error(`Supabase chat repository: ${error.message}`);
    }
    if (data === null) {
      return null;
    }
    if (data.role !== 'assistant' && data.role !== 'user') {
      throw new Error(`Supabase chat repository: invalid message role ${data.role}`);
    }
    return {
      id: fromDbId(data.id, 'msg'),
      clientId: data.client_id,
      conversationId,
      authorId: data.author_id,
      role: data.role,
      content: data.content,
      status: 'complete',
      createdAt: Date.parse(data.created_at),
    };
  },
  async listConversations(ownerId, page) {
    const size = 50;
    const { data, error } = await client
      .from('conversations')
      .select('*, messages(count)')
      .eq('owner_id', ownerId)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * size, page * size + size - 1);
    if (error !== null) {
      throw new Error(`Supabase chat repository: ${error.message}`);
    }
    interface ConversationWithCount {
      id: string;
      owner_id: string;
      title: string;
      created_at: string;
      updated_at: string;
      messages?: { count: number }[];
    }
    const rows = (data ?? []) as unknown as ConversationWithCount[];
    return rows.map((row) => ({
      id: fromDbId(row.id, 'conv'),
      ownerId: row.owner_id,
      organizationId: null,
      title: row.title,
      messageCount: row.messages?.[0]?.count ?? 0,
      createdAt: Date.parse(row.created_at),
      updatedAt: Date.parse(row.updated_at),
    }));
  },
  async listMessages(ownerId, conversationId, cursor) {
    const size = 50;
    let query = client
      .from('messages')
      .select('*, conversations!inner(owner_id)')
      .eq('conversations.owner_id', ownerId)
      .eq('conversation_id', toDbId(conversationId));
    if (cursor !== null) {
      let boundary: { createdAt: string; id: string };
      try {
        const parsed: unknown = JSON.parse(atob(cursor));
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('createdAt' in parsed) ||
          !('id' in parsed) ||
          !('ownerId' in parsed) ||
          !('conversationId' in parsed) ||
          parsed.ownerId !== ownerId ||
          parsed.conversationId !== conversationId ||
          typeof parsed.createdAt !== 'string' ||
          typeof parsed.id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            parsed.id,
          ) ||
          !Number.isFinite(Date.parse(parsed.createdAt)) ||
          new Date(parsed.createdAt).toISOString() !== parsed.createdAt
        ) {
          throw new Error();
        }
        boundary = { createdAt: parsed.createdAt, id: parsed.id };
      } catch {
        throw new MessageCursorError();
      }
      query = query.or(
        `created_at.lt.${boundary.createdAt},and(created_at.eq.${boundary.createdAt},id.lt.${boundary.id})`,
      );
    }
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(size + 1);
    if (error !== null) {
      throw new Error(`Supabase chat repository: ${error.message}`);
    }
    const rows = data ?? [];
    const hasMore = rows.length > size;
    const selected = rows.slice(0, size);
    const items = selected.reverse().map((row) => {
      if (row.role !== 'assistant' && row.role !== 'user') {
        throw new Error(`Supabase chat repository: invalid message role ${row.role}`);
      }
      return {
        id: fromDbId(row.id, 'msg'),
        clientId: row.client_id,
        conversationId,
        authorId: row.author_id,
        role: row.role as 'assistant' | 'user',
        content: row.content,
        status: 'complete' as const,
        createdAt: Date.parse(row.created_at),
      };
    });
    const first = items[0];
    return {
      items,
      nextCursor:
        hasMore && first
          ? btoa(
              JSON.stringify({
                ownerId,
                conversationId,
                createdAt: new Date(first.createdAt).toISOString(),
                id: toDbId(first.id),
              }),
            )
          : null,
      hasMore,
      serverTime: Date.now(),
    };
  },
  async admitGeneration(input) {
    const { data, error } = await client.rpc('admit_chat_generation', {
      p_conversation_id: toDbId(input.conversationId),
      p_client_id: input.clientId,
      p_request_fingerprint: input.fingerprint,
      p_user_message_id: toDbId(input.userMessageId),
      p_content: input.content,
    });
    if (
      error !== null &&
      error.code === '23505' &&
      error.message.includes('chat idempotency conflict')
    ) {
      return { outcome: 'conflict', assistantMessageId: '', attempt: 0 };
    }
    if (error !== null) {
      throw new Error(`Supabase chat admission: ${error.message}`);
    }
    const result = data?.[0];
    if (result === undefined || !['admitted', 'completed', 'in_flight'].includes(result.outcome)) {
      throw new Error('Supabase chat admission returned an invalid outcome.');
    }
    return {
      outcome:
        result.outcome === 'in_flight'
          ? 'running'
          : (result.outcome as ChatGenerationAdmission['outcome']),
      assistantMessageId: fromDbId(result.assistant_message_id, 'msg'),
      attempt: result.attempt,
    };
  },
  async completeGeneration(input) {
    if (adminClient === undefined) {
      throw new Error('Supabase chat completion requires an explicit admin client.');
    }
    const { data, error } = await adminClient.rpc('complete_chat_generation', {
      p_conversation_id: toDbId(input.conversationId),
      p_client_id: input.clientId,
      p_attempt: input.attempt,
      p_content: input.content,
    });
    if (error !== null || data === null) {
      throw new Error(`Supabase chat completion: ${error?.message ?? 'no message id returned'}`);
    }
    return fromDbId(data, 'msg');
  },
  async failGeneration(input) {
    if (adminClient === undefined) {
      throw new Error('Supabase chat failure recording requires an explicit admin client.');
    }
    const { data, error } = await adminClient.rpc('fail_chat_generation', {
      p_conversation_id: toDbId(input.conversationId),
      p_client_id: input.clientId,
      p_attempt: input.attempt,
      p_state: input.state,
    });
    if (error !== null || data !== true) {
      throw new Error(
        `Supabase chat failure recording: ${error?.message ?? 'stale generation attempt'}`,
      );
    }
  },
});
