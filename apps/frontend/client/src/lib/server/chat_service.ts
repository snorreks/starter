import type { Conversation, ConversationCreate, Message, MessagePage } from '@starter/schemas/chat';

export type ChatAdmission =
  | { outcome: 'running'; assistantMessageId: string }
  | { outcome: 'conflict' }
  | { outcome: 'admitted'; userMessage: Message; assistantMessageId: string }
  | { outcome: 'completed'; userMessage: Message; assistantMessage: Message };

export interface ChatService {
  list(ownerId: string): Promise<Conversation[]>;
  find(ownerId: string, conversationId: string): Promise<Conversation | null>;
  create(ownerId: string, input: ConversationCreate): Promise<Conversation>;
  messages(ownerId: string, conversationId: string): Promise<Message[]>;
  messagePage(ownerId: string, conversationId: string, cursor: string | null): Promise<MessagePage>;
  appendUserMessage(
    ownerId: string,
    conversationId: string,
    content: string,
    clientId: string,
  ): Promise<Message | ChatAdmission | null>;
  appendAssistantMessage(
    ownerId: string,
    conversationId: string,
    content: string,
    id: string,
    createdAt: number,
  ): Promise<Message | null>;
  failGeneration(
    ownerId: string,
    conversationId: string,
    clientId: string,
    state: 'failed' | 'cancelled',
  ): Promise<void>;
}
