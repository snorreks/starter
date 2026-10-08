import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

describe('dev_process start command', () => {
  test('uses the current web dev command and has no stale reference', async () => {
    const subject = new URL('../extensions/dev_process.ts', import.meta.url);
    if (!existsSync(subject)) {
      throw new Error('The dev_process source moved; update this test path invariant.');
    }
    const source = await Bun.file(subject).text();
    expect(source).toContain("dev: 'bun run dev'");
    expect(source).not.toContain('dev:api');
  });
});
