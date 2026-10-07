import { expect, test } from 'bun:test';
import { checkSchema } from '../validation.ts';
import { MessagePageSchema } from './message.ts';

test('message pages require the complete strict cursor envelope', () => {
  expect(
    checkSchema(MessagePageSchema, {
      items: [],
      nextCursor: null,
      hasMore: false,
      serverTime: 123,
    }),
  ).toBe(true);
  expect(
    checkSchema(MessagePageSchema, {
      items: [],
      nextCursor: 'opaque',
      hasMore: true,
      serverTime: 123,
      ownerId: 'foreign',
    }),
  ).toBe(false);
});
