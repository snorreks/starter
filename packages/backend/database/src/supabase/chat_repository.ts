import type { Conversation, Message } from '@starter/schemas/chat';
import type { SupabaseClient } from './client.ts';
import type { Database } from './database.types.ts';

export interface ChatGenerationAdmission {
  outcome: 'admitted' | 'completed' | 'in_flight';
  assistantMessageId: string;
  attempt: number;
}
export interface ChatRepository {
  createConversation(ownerId: string, title: string): Promise<Conversation>;
  listConversations(ownerId: string, page: number): Promise<Conversation[]>;
  listMessages(ownerId: string, conversationId: string, page: number): Promise<Message[]>;
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
  async listMessages(ownerId, conversationId, page) {
    const size = 50;
    const { data, error } = await client
      .from('messages')
      .select('*, conversations!inner(owner_id)')
      .eq('conversations.owner_id', ownerId)
      .eq('conversation_id', toDbId(conversationId))
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * size, page * size + size - 1);
    if (error !== null) {
      throw new Error(`Supabase chat repository: ${error.message}`);
    }
    return (data ?? []).reverse().map((row) => {
      if (row.role !== 'assistant' && row.role !== 'user') {
        throw new Error(`Supabase chat repository: invalid message role ${row.role}`);
      }
      return {
        id: fromDbId(row.id, 'msg'),
        conversationId,
        authorId: row.author_id,
        role: row.role,
        content: row.content,
        status: 'complete',
        createdAt: Date.parse(row.created_at),
      };
    });
  },
  async admitGeneration(input) {
    const { data, error } = await client.rpc('admit_chat_generation', {
      p_conversation_id: toDbId(input.conversationId),
      p_client_id: input.clientId,
      p_request_fingerprint: input.fingerprint,
      p_user_message_id: toDbId(input.userMessageId),
      p_content: input.content,
    });
    if (error !== null) {
      throw new Error(`Supabase chat admission: ${error.message}`);
    }
    const result = data?.[0];
    if (result === undefined || !['admitted', 'completed', 'in_flight'].includes(result.outcome)) {
      throw new Error('Supabase chat admission returned an invalid outcome.');
    }
    return {
      outcome: result.outcome as ChatGenerationAdmission['outcome'],
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
});
