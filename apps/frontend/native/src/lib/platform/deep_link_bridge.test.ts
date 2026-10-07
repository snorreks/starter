import { expect, mock, test } from 'bun:test';

let live: ((urls: string[]) => void) | undefined;
const stop = () => {};
mock.module('@tauri-apps/api/core', () => ({ isTauri: () => true }));
mock.module('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: async () => ['failed-startup', 'valid-startup'],
  onOpenUrl: async (listener: (urls: string[]) => void) => {
    live = listener;
    return stop;
  },
}));
const { listenForAuthLinks } = await import('./deep_link_bridge.ts');

test('a rejected startup callback does not block subsequent URLs or live listener setup', async () => {
  const handled: string[] = [];
  const unlisten = await listenForAuthLinks(async (url) => {
    handled.push(url);
    if (url.startsWith('failed')) {
      throw new Error('Invalid callback');
    }
  });
  expect(handled).toEqual(['failed-startup', 'valid-startup']);
  expect(unlisten).toBe(stop);
  expect(live).toBeDefined();
  live?.(['failed-live', 'valid-live']);
  await Promise.resolve();
  expect(handled).toEqual(['failed-startup', 'valid-startup', 'failed-live', 'valid-live']);
});
