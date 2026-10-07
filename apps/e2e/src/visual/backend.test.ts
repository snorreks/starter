import { expect, test } from 'bun:test';
import { requireVisualBackend } from './backend.ts';

test('visual capture selects the fixture-backed legacy profile by default', () => {
  expect(requireVisualBackend(undefined)).toBe('legacy');
  expect(requireVisualBackend('legacy')).toBe('legacy');
});

test('unsupported visual backends fail before a runtime starts and name the supported path', () => {
  expect(() => requireVisualBackend('supabase')).toThrow(
    /legacy local backend.*bun run e2e:visual/,
  );
});
