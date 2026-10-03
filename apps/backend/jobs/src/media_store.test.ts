import { expect, test } from 'bun:test';
import { createMediaStore, MAX_INPUT_BYTES } from './media_store.ts';

test('a storage outage propagates instead of reporting a missing fixture', async () => {
  const failure = new Error('storage unavailable');
  const store = createMediaStore({
    get: async () => {
      throw failure;
    },
  } as unknown as R2Bucket);
  await expect(store.readFixture('sample-v1', MAX_INPUT_BYTES)).rejects.toBe(failure);
});

test('a genuinely absent fixture remains null', async () => {
  const store = createMediaStore({ get: async () => null } as unknown as R2Bucket);
  expect(await store.readFixture('sample-v1', MAX_INPUT_BYTES)).toBeNull();
});
