// scripts/tests/run_bounded.test.ts
//
// The bounded runner's output contract, against real child processes.
//
// The bound is the interesting part and the decoding is where it was wrong: a
// chunk was decoded as it arrived, and a pipe boundary is not a character
// boundary. These tests write the exact bytes into a fixture and hand the child
// one `head`/`tail` slice at a time, so where the boundary falls is decided by
// the fixture rather than by a mock's idea of a chunk. The bytes come from a file
// because `\303` in a source file is an octal escape to any TypeScript parser
// reading this repository, including the guard that refuses unparseable files.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBounded, runBoundedSync } from '../src/shared/run_bounded.ts';

const roots: string[] = [];

/** A temporary directory holding one file of exact bytes, as `$1` to a shell. */
const bytes = (...values: number[]): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-run-bounded-'));
  roots.push(root);
  const path = join(root, 'fixture.bin');
  writeFileSync(path, Buffer.from(values));
  return path;
};

const cleanup = (): void => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('a multibyte character split across two reads survives the boundary', () => {
  test('streams progress chunks while retaining bounded stdout and stderr', async () => {
    const chunks: Array<{ stream: string; text: string }> = [];
    const result = await runBounded({
      command: 'sh',
      args: ['-c', 'printf out; printf err >&2'],
      cwd: tmpdir(),
      timeoutMs: 10_000,
      maxBytes: 1024,
      onOutput: (stream, chunk) => chunks.push({ stream, text: chunk.toString() }),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(chunks.every(({ stream }) => stream === 'stdout' || stream === 'stderr')).toBe(true);
    const collected = { stdout: '', stderr: '' };
    for (const { stream, text } of chunks) {
      collected[stream as keyof typeof collected] += text;
    }
    expect(collected).toEqual({ stdout: result.stdout, stderr: result.stderr });
  });

  test('the assembled stream decodes to the character the child wrote', async () => {
    // `é` then a newline: two bytes, written 200 ms apart. The reader is blocked
    // on an empty pipe when the first write happens, so these are two `data`
    // events and the split lands between the lead byte and its continuation —
    // the only place where per-chunk decoding loses information.
    const path = bytes(0xc3, 0xa9, 0x0a);
    try {
      const result = await runBounded({
        command: 'sh',
        args: ['-c', 'head -c 1 "$1"; sleep 0.2; tail -c +2 "$1"', 'sh', path],
        cwd: dirname(path),
        timeoutMs: 10_000,
        maxBytes: 64 * 1024,
      });

      expect(result.code).toBe(0);
      // `toString('utf8')` per chunk decodes the lead byte and the continuation
      // byte to two U+FFFD, so the exact match is the assertion: a byte count
      // would pass, because U+FFFD is three bytes and the pair of them is six.
      expect(result.stdout).toBe('é\n');
      expect(result.stdout).not.toContain('\uFFFD');
      expect(Buffer.byteLength(result.stdout)).toBe(3);
    } finally {
      cleanup();
    }
  });

  test('a four-byte character split three ways is still one character', async () => {
    const path = bytes(0xf0, 0x9f, 0x98, 0x80);
    try {
      const result = await runBounded({
        command: 'sh',
        args: [
          '-c',
          'head -c 1 "$1"; sleep 0.15; tail -c +2 "$1" | head -c 1; sleep 0.15; tail -c +3 "$1"',
          'sh',
          path,
        ],
        cwd: dirname(path),
        timeoutMs: 10_000,
        maxBytes: 64 * 1024,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('\u{1F600}');
      expect(Buffer.byteLength(result.stdout)).toBe(4);
    } finally {
      cleanup();
    }
  });
});

describe('a byte budget that cuts a character omits the fragment', () => {
  test('the incomplete suffix is dropped instead of becoming U+FFFD', async () => {
    // `aaaa` then two 2-byte characters: eight bytes into a five-byte budget, so
    // the fifth kept byte is the lead byte of the first `é` and nothing follows it.
    const path = bytes(0x61, 0x61, 0x61, 0x61, 0xc3, 0xa9, 0xc3, 0xa9);
    try {
      const result = await runBounded({
        command: 'sh',
        args: ['-c', 'cat "$1"', 'sh', path],
        cwd: dirname(path),
        timeoutMs: 10_000,
        maxBytes: 5,
      });

      expect(result.stdout).toBe('aaaa');
      expect(result.stdout).not.toContain('\uFFFD');
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(5);
      // The budget was exceeded, and that is still reported as a failure with the
      // budget named: an output limit that silently succeeds is the defect this
      // module exists to prevent.
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('output budget');
    } finally {
      cleanup();
    }
  });

  test('a genuinely encoded U+FFFD is not mistaken for a fragment', async () => {
    // EF BF BD is a real U+FFFD and re-encodes to the three bytes it came from,
    // so the check that trims a truncated tail has to leave it alone.
    const path = bytes(0x61, 0xef, 0xbf, 0xbd, 0x62);
    try {
      const result = await runBounded({
        command: 'sh',
        args: ['-c', 'cat "$1"', 'sh', path],
        cwd: dirname(path),
        timeoutMs: 10_000,
        maxBytes: 64 * 1024,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('a\uFFFDb');
      expect(Buffer.byteLength(result.stdout)).toBe(5);
    } finally {
      cleanup();
    }
  });
});

describe('an inherited terminal keeps streams live and prompts answerable', () => {
  test('the output is not buffered into the result, and the exit code still decides', () => {
    const root = mkdtempSync(join(tmpdir(), 'starter-run-bounded-sync-'));
    roots.push(root);
    try {
      const result = runBoundedSync({
        command: 'sh',
        args: ['-c', 'printf "live"; exit 3'],
        cwd: root,
        stdio: 'inherit',
      });

      // Nothing is buffered, so nothing is returned: the only thing that can carry
      // those bytes is the terminal this process inherited into the child.
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      // And the run is still bounded and still honest about how it ended.
      expect(result.code).toBe(3);
    } finally {
      cleanup();
    }
  });

  test('a child under the supervisor writes to the caller stream and reads its stdin', () => {
    const root = mkdtempSync(join(tmpdir(), 'starter-run-bounded-inherit-'));
    roots.push(root);
    try {
      // Driven as a real process rather than through `runBoundedSync`, because the
      // point is what the *grandchild* inherits: the supervisor's terminal. The
      // supervisor is handed pipes here, so what the grandchild prints and reads
      // is observable — and a piped stdin already drained could never answer the
      // `read` below.
      const supervisor = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../src/shared/run_bounded.ts', import.meta.url)),
          'sh',
          '-c',
          'read line; printf "got:%s" "$line"; printf "warn" >&2',
        ],
        {
          cwd: root,
          input: 'yes\n',
          env: {
            ...process.env,
            STARTER_PROCESS_STDIO: 'inherit',
            // The supervisor reads its bounds from the environment; a real caller
            // supplies them, so this one does too rather than leaving a NaN timeout.
            STARTER_PROCESS_TIMEOUT_MS: '30000',
          },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );

      expect(supervisor.status).toBe(0);
      expect(supervisor.stdout).toBe('got:yes');
      expect(supervisor.stderr).toBe('warn');
    } finally {
      cleanup();
    }
  });
});
