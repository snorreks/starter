import {
  ChatListView,
  ChatListViewModel,
  ChatService,
  ChatView,
  ChatViewModel,
} from '@starter/features/chat';
import {
  type ApiTransport,
  type FetchLike,
  HttpTransport,
  type StreamingTransport,
  type TransportRequestOptions,
} from '@starter/platform';
import type { Conversation, Message } from '@starter/schemas/chat';
import { encodeSseFrame } from '@starter/schemas/chat';
import { flushSync } from 'svelte';
import { createSubscriber } from 'svelte/reactivity';
import { expect, test } from 'vitest';
import ChatPage from '../routes/chat/[id]/+page.svelte';
import { mountInDocument } from './mount_helper.ts';

const streamTransport = (transport: ApiTransport, fetchImpl: FetchLike): StreamingTransport => ({
  ...transport,
  openStream: (path: string, options?: TransportRequestOptions) =>
    new HttpTransport({ fetch: fetchImpl }).openStream(path, options),
});

import { installOfflineGuard } from './setup.ts';

const conversation: Conversation = {
  id: 'one',
  ownerId: 'owner',
  organizationId: null,
  title: 'First',
  messageCount: 0,
  createdAt: 0,
  updatedAt: 0,
};
const message: Message = {
  id: 'user',
  conversationId: 'one',
  authorId: 'owner',
  content: 'hi',
  role: 'user',
  status: 'complete',
  createdAt: 0,
};
const transport = {
  async request<T>() {
    return {} as T;
  },
};

test('streaming controls and partial text update before completion', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let reachedDelta!: () => void;
  const delta = new Promise<void>((resolve) => {
    reachedDelta = resolve;
  });
  const service = new ChatService({
    onUpdate(update) {
      if (update.type === 'delta') {
        reachedDelta();
      }
    },
    transport: streamTransport(
      transport,
      async () =>
        new Response(
          new ReadableStream({
            start(value) {
              controller = value;
            },
          }),
        ),
    ),
  });
  const vm = new ChatViewModel({
    chat: service,
    conversation,
    initialMessages: [],
    newClientId: () => 'cid',
  });
  const mounted = mountInDocument(ChatView, { viewModel: vm });
  try {
    vm.setDraft('hi');
    const sending = vm.send();
    flushSync();
    expect(mounted.target.querySelector('[data-testid="chat-cancel"]')).not.toBeNull();
    for (const frame of [
      { type: 'user-message', clientId: 'cid', message },
      { type: 'start', messageId: 'reply' },
      { type: 'delta', text: 'partial' },
    ] as const) {
      controller.enqueue(new TextEncoder().encode(encodeSseFrame(frame)));
    }
    await delta;
    flushSync();
    expect(mounted.target.textContent).toContain('partial');
    controller.enqueue(
      new TextEncoder().encode(
        encodeSseFrame({
          type: 'complete',
          message: { ...message, id: 'reply', role: 'assistant', content: 'partial' },
        }),
      ),
    );
    await sending;
    flushSync();
    expect(mounted.target.querySelector('[data-testid="chat-cancel"]')).toBeNull();
    expect(mounted.target.querySelectorAll('[data-role="assistant"]')).toHaveLength(1);
  } finally {
    mounted.destroy();
  }
});

test('creating label reacts while the request is outstanding', async () => {
  let resolve!: (value: Conversation) => void;
  const waiting = new Promise<Conversation>((done) => {
    resolve = done;
  });
  const service = new ChatService({
    transport: streamTransport(
      {
        async request<T>() {
          return (await waiting) as T;
        },
      },
      async () => new Response(new ReadableStream<Uint8Array>()),
    ),
  });
  const vm = new ChatListViewModel({
    chat: service,
    initialConversations: [],
    navigation: { go: async () => {} },
  });
  const mounted = mountInDocument(ChatListView, { viewModel: vm });
  try {
    vm.setDraftTitle('New');
    const creating = vm.create();
    flushSync();
    expect(mounted.target.querySelector('[data-testid="chat-new-submit"]')?.textContent).toContain(
      'Creating',
    );
    resolve(conversation);
    await creating;
    flushSync();
    expect(mounted.target.querySelector('[data-testid="chat-new-submit"]')?.textContent).toContain(
      'Start',
    );
  } finally {
    mounted.destroy();
  }
});

test('same-conversation reload keeps the queue; navigation sends to the new conversation', async () => {
  let current = { conversation, messages: [] as Message[] };
  let update!: () => void;
  const subscribe = createSubscriber((notify) => {
    update = notify;
  });
  const props = {
    get data() {
      subscribe();
      return { ...current, user: null };
    },
  };
  const mounted = mountInDocument(ChatPage, props);
  const requiredElement = <T extends Element>(selector: string): T => {
    const element = mounted.target.querySelector<T>(selector);
    if (element === null) {
      throw new Error(`Missing element: ${selector}`);
    }
    return element;
  };
  const input = () => requiredElement<HTMLTextAreaElement>('[data-testid="chat-input"]');
  const submit = () =>
    requiredElement<HTMLFormElement>('[data-testid="chat-composer"]').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  let calls: string[] = [];
  globalThis.fetch = (async (path: RequestInfo | URL) => {
    calls.push(String(path));
    throw new TypeError('offline');
  }) as unknown as typeof fetch;
  try {
    input().value = 'queued';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    submit();
    await expect
      .poll(() => mounted.target.querySelectorAll('[data-testid="chat-queue-item"]').length)
      .toBe(1);
    current = { conversation: { ...conversation }, messages: [] };
    update();
    flushSync();
    expect(mounted.target.querySelectorAll('[data-testid="chat-queue-item"]')).toHaveLength(1);
    current = { conversation: { ...conversation, id: 'two', title: 'Second' }, messages: [] };
    update();
    flushSync();
    expect(mounted.target.querySelector('h1')?.textContent).toBe('Second');
    expect(mounted.target.querySelectorAll('[data-testid="chat-queue-item"]')).toHaveLength(0);
    calls = [];
    input().value = 'new';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    submit();
    await expect.poll(() => calls).toEqual(['/api/chat/conversations/two/messages']);
  } finally {
    mounted.destroy();
    installOfflineGuard();
  }
});
