import { expect, test } from 'bun:test';
import { fingerprint } from './fingerprint.ts';

test('embedded newlines cannot move the boundary between identity and content', () => {
  expect(fingerprint([{ id: 'a', content: 'b\nc' }])).not.toBe(
    fingerprint([{ id: 'a\nb', content: 'c' }]),
  );
  expect(fingerprint([{ id: 'a', content: 'b\n\nc\nd' }])).not.toBe(
    fingerprint([
      { id: 'a', content: 'b' },
      { id: 'c', content: 'd' },
    ]),
  );
});
