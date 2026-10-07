import type { Conversation, ConversationCreate, Message } from '@starter/schemas/chat';
import { createId } from '@starter/utils';
import { type ChatService, createChatService } from './chat_service.ts';
import type { ApplicationServices } from './supabase_context.ts';

type AdmissionResult =
  | { outcome: 'running'; assistantMessageId: string }
  | { outcome: 'conflict' }
  | { outcome: 'admitted'; userMessage: Message; assistantMessageId: string }
  | { outcome: 'completed'; userMessage: Message; assistantMessage: Message };

export type RequestChatService = Omit<ChatService, 'appendUserMessage'> & {
  appendUserMessage(
    ...args: Parameters<ChatService['appendUserMessage']>
  ): Promise<Message | AdmissionResult | null>;
  failGeneration(
    ownerId: string,
    conversationId: string,
    clientId: string,
    state: 'failed' | 'cancelled',
  ): Promise<void>;
};

/** Select the complete chat implementation from this request's composition root. */
export const createRequestChatService = (locals: {
  context?: {
    backendProfile: 'legacy' | 'supabase';
    user: { id: string } | null;
    services: ApplicationServices | null;
  };
  container: { db: Parameters<typeof createChatService>[0] };
}): RequestChatService => {
  if (locals.context?.backendProfile !== 'supabase') {
    return Object.assign(createChatService(locals.container.db), {
      failGeneration: async () => {},
    });
  }
  const identity = locals.context.services?.identity;
  const repository = locals.context.services?.chat;
  if (!identity || !repository || identity.user.id !== locals.context.user?.id) {
    throw new Error("Supabase chat service requires this request's verified Supabase identity.");
  }
  const owner = (ownerId: string) => {
    if (ownerId !== identity.user.id) {
      throw new Error('Supabase chat owner does not match the verified identity.');
    }
  };
  const admissions = new Map<
    string,
    { clientId: string; attempt: number; assistantMessageId: string }
  >();
  return {
    async list(ownerId) {
      owner(ownerId);
      return repository.listConversations(ownerId, 0);
    },
    async find(ownerId, id) {
      owner(ownerId);
      return repository.findConversation(ownerId, id);
    },
    async create(ownerId, input: ConversationCreate): Promise<Conversation> {
      owner(ownerId);
      return repository.createConversation(ownerId, input.title);
    },
    async messages(ownerId, conversationId): Promise<Message[]> {
      owner(ownerId);
      return (await repository.listMessages(ownerId, conversationId, null)).items;
    },
    async messagePage(ownerId, conversationId, cursor) {
      owner(ownerId);
      return repository.listMessages(ownerId, conversationId, cursor);
    },
    async appendUserMessage(ownerId, conversationId, content, clientId) {
      owner(ownerId);
      const userMessageId = createId('msg');
      const fingerprint = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
      const admission = await repository.admitGeneration({
        conversationId,
        clientId,
        fingerprint: [...new Uint8Array(fingerprint)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join(''),
        userMessageId,
        content,
      });
      if (admission.outcome === 'conflict') {
        return { outcome: 'conflict' };
      }
      if (admission.outcome === 'running') {
        return { outcome: 'running', assistantMessageId: admission.assistantMessageId };
      }
      const userMessage = await repository.findMessageByClientId(ownerId, conversationId, clientId);
      if (userMessage === null) {
        throw new Error('Supabase chat admission has no stored user message.');
      }
      if (admission.outcome === 'completed') {
        const assistantMessage = await repository.findMessageByClientId(
          ownerId,
          conversationId,
          `assistant:${clientId}`,
        );
        if (assistantMessage === null) {
          throw new Error('Completed Supabase chat admission has no stored reply.');
        }
        return { outcome: 'completed', userMessage, assistantMessage };
      }
      admissions.set(clientId, {
        clientId,
        attempt: admission.attempt,
        assistantMessageId: admission.assistantMessageId,
      });
      return {
        outcome: 'admitted',
        userMessage,
        assistantMessageId: admission.assistantMessageId,
      };
    },
    async appendAssistantMessage(ownerId, conversationId, content, id, createdAt) {
      owner(ownerId);
      const admission = [...admissions.values()].find((item) => item.assistantMessageId === id);
      if (!admission) {
        return null;
      }
      await repository.completeGeneration({
        conversationId,
        clientId: admission.clientId,
        attempt: admission.attempt,
        content,
      });
      admissions.delete(admission.clientId);
      return {
        id,
        conversationId,
        authorId: ownerId,
        role: 'assistant' as const,
        content,
        status: 'complete',
        createdAt,
      };
    },
    async failGeneration(ownerId, conversationId, clientId, state) {
      owner(ownerId);
      const admission = admissions.get(clientId);
      if (admission === undefined) {
        return;
      }
      await repository.failGeneration({
        conversationId,
        clientId,
        attempt: admission.attempt,
        state,
      });
      admissions.delete(clientId);
    },
  };
};
