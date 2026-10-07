import { describe, expect, test } from 'bun:test';
describe('dev_process start command', () => {
  test('uses the current web dev command and has no stale reference', async () => {
    const source = await Bun.file(new URL('../extensions/dev_process.ts', import.meta.url)).text();
    expect(source).toContain("dev: 'bun run dev'");
    expect(source).not.toContain('dev:api');
  });
});
