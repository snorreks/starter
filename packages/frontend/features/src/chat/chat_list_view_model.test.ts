import { describe, expect, test } from 'bun:test';
import { type FetchLike, HttpTransport } from '@starter/platform';
import type { Conversation } from '@starter/schemas/chat';
import { ChatListViewModel } from './chat_list_view_model.svelte.ts';
import { ChatService } from './chat_service.ts';

const conversation = (id: string): Conversation => ({
  id,
  ownerId: 'f45b2c4a-7919-4f55-ae89-e73f6753e322',
  organizationId: null,
  title: id,
  messageCount: 0,
  createdAt: 1,
  updatedAt: 1,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve(value) };
};

const serviceWith = (request: FetchLike) =>
  new ChatService({ transport: new HttpTransport({ fetch: request }) });

describe('conversation list ordering', () => {
  test('a server seed invalidates an older list read', async () => {
    const read = deferred<Response>();
    const service = serviceWith(async () => read.promise);
    const vm = new ChatListViewModel({ chat: service, navigation: { go: async () => {} } });
    const pending = vm.load();
    vm.seed([conversation('snapshot')]);
    read.resolve(
      new Response(JSON.stringify({ conversations: [conversation('stale')], serverTime: 1 })),
    );
    await pending;
    expect(vm.conversations.map(({ id }) => id)).toEqual(['snapshot']);
  });

  test('a committed create remains listed when navigation rejects', async () => {
    const service = serviceWith(async () => new Response(JSON.stringify(conversation('created'))));
    const vm = new ChatListViewModel({
      chat: service,
      navigation: {
        go: async () => {
          throw new Error('router failed');
        },
      },
      initialConversations: [],
    });
    vm.setDraftTitle('Created');
    const outcome = await vm.create();
    expect(outcome.kind).toBe('created-navigation-failed');
    expect(vm.conversations.map(({ id }) => id)).toEqual(['created']);
    expect(vm.createError).toContain('created');
  });

  test('parallel create calls issue one write', async () => {
    const response = deferred<Response>();
    let writes = 0;
    const service = serviceWith(async () => {
      writes += 1;
      return response.promise;
    });
    const vm = new ChatListViewModel({
      chat: service,
      navigation: { go: async () => {} },
      initialConversations: [],
    });
    vm.setDraftTitle('One');
    const first = vm.create();
    const second = await vm.create();
    expect(second.kind).toBe('rejected');
    expect(writes).toBe(1);
    response.resolve(new Response(JSON.stringify(conversation('created'))));
    expect((await first).kind).toBe('created');
  });
});
