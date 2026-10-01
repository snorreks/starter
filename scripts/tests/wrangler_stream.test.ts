// scripts/tests/wrangler_stream.test.ts
//
// The streaming Wrangler invocation: line framing and the timeout.
//
// Both properties are only observable through a real child process, so these
// spawn `sh` rather than a mock. A mock's `onStdout` is called with whatever the
// test decides to hand it, which is exactly the assumption that was wrong: a pipe
// delivers whatever bytes happened to fill the buffer, not whole lines.

import { describe, expect, test } from 'bun:test';
import { defaultStreamRunner } from '../src/cloudflare/wrangler.ts';

/** Run `sh` through the real streaming runner and collect every line it emits. */
const streamShell = async (
  script: string,
  timeoutMs: number,
): Promise<{ lines: string[]; code: number }> => {
  const lines: string[] = [];

  const code = await defaultStreamRunner.run(
    'sh',
    ['-c', script],
    { cwd: process.cwd(), timeoutMs },
    {
      onStdout: (line) => lines.push(line),
      onStderr: (line) => lines.push(`stderr:${line}`),
    },
  );

  return { lines, code };
};

describe('streamed line framing', () => {
  test('emits one line per line of output, not one per chunk', async () => {
    // A chunk boundary lands wherever the pipe buffer fills. Splitting each chunk
    // on its own emits fragments, so a consumer parsing JSON lines rejected most
    // of a JSON stream — and the fragments are indistinguishable from real lines
    // by anything downstream.
    //
    // `awk` in one buffered write, because a shell loop's per-line writes can each
    // arrive as their own chunk, which hides the split by luck rather than by
    // correctness. 20k lines is several times the pipe buffer.
    const { lines } = await streamShell(
      'awk \'BEGIN{for(i=1;i<=20000;i++) printf "line-%d\\n", i}\'',
      20_000,
    );

    expect(lines).toHaveLength(20_000);
    expect(lines[0]).toBe('line-1');
    expect(lines.at(-1)).toBe('line-20000');
    for (const line of lines) {
      expect(line).toMatch(/^line-\d+$/);
    }
  });

  test('reassembles a line split across chunk boundaries', async () => {
    // One long line, no newline until the end: a per-chunk splitter emits it in
    // pieces, and a consumer sees either nothing or several short lines.
    const { lines } = await streamShell(
      'i=0; while [ $i -lt 200000 ]; do printf "x"; i=$((i+1)); done; printf "\\n"',
      10_000,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(200_000);
  });

  test('flushes a final line that has no trailing newline', async () => {
    // Held back waiting for a newline that never comes, which is the "the stream
    // went quiet" case an operator waits on longest.
    const { lines } = await streamShell('printf "no-newline-here"', 10_000);

    expect(lines).toEqual(['no-newline-here']);
  });

  test('drops blank lines rather than emitting them', async () => {
    const { lines } = await streamShell('printf "a\\n\\n\\nb\\n"', 10_000);

    expect(lines).toEqual(['a', 'b']);
  });

  test('frames stdout and stderr independently', async () => {
    // One carry per stream: sharing one between them interleaves half-lines from
    // two streams into a single corrupt line.
    const { lines } = await streamShell('printf "out-1\\n"; printf "err-1\\n" >&2', 10_000);

    expect(lines).toContain('out-1');
    expect(lines).toContain('stderr:err-1');
  });

  test('streams incrementally rather than buffering to the end', async () => {
    // A consumer that waits for the whole run cannot show a line as it arrives,
    // and `--follow` is the reason the streaming API exists at all.
    const seen: number[] = [];

    const done = defaultStreamRunner.run(
      'sh',
      ['-c', 'printf "one\\n"; sleep 1; printf "two\\n"'],
      { cwd: process.cwd(), timeoutMs: 10_000 },
      { onStdout: () => seen.push(Date.now()), onStderr: () => undefined },
    );

    // The first line arrives well before the process exits.
    await Bun.sleep(500);
    expect(seen).toHaveLength(1);

    expect(await done).toBe(0);
    expect(seen).toHaveLength(2);
  });
});

describe('streamed timeout', () => {
  test('a process killed by the timeout reports failure, not success', async () => {
    // A SIGTERM-ed process has no exit code of its own, so `code ?? 1` is what
    // fell out — and resolving 0 told the caller the tail ran to completion and
    // printed everything, which is the opposite of what happened.
    const { code } = await streamShell('sleep 30', 300);

    expect(code).not.toBe(0);
  });

  test('a nonzero exit before the timeout is preserved', async () => {
    // A real answer about the command, and it has to survive the timeout
    // bookkeeping: a run that exited 3 exited 3.
    const { code } = await streamShell('exit 3', 10_000);

    expect(code).toBe(3);
  });

  test('a clean exit before the timeout still reports 0', async () => {
    const { code } = await streamShell('exit 0', 10_000);

    expect(code).toBe(0);
  });
});
