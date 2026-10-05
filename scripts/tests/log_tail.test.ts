// scripts/tests/log_tail.test.ts
//
// `tailCloudflare`, against an injected stream runner.
//
// The lifecycle this covers was the second half of gap 2, and it is the part that
// decides what the operator is told. The stream *runner* underneath is already
// tested against a real child process (`wrangler_stream.test.ts`), so this does not
// re-test framing or the timeout — it tests the three things above it:
//
//   1. An unparseable envelope line is dropped, not printed as an event.
//   2. A session that hits its bound reports failure, so a forgotten `--follow`
//      does not read as a clean finish.
//   3. An unsupported flag is refused *before* wrangler is spawned.
//
// (3) matters most: the previous tail forwarded `--uid`/`--trace` to
// `wrangler tail`, a live stream with no index, which cannot filter by any field.
// The provider would have ignored the narrowing while the client-side predicate
// still filtered — so the answer looked filtered and was not.
//
// `setStreamRunner` makes argv observable at the process boundary rather than
// asserting on a constant, so a test can prove nothing was spawned on refusal.

import { afterEach, describe, expect, test } from 'bun:test';
import { setStreamBinary, setStreamRunner } from '../src/cloudflare/wrangler.ts';
import {
  buildHistoricalRequest,
  DEFAULT_TAIL_MS,
  MAX_TAIL_MS,
  queryCloudflareHistory,
  tailCloudflare,
} from '../src/logs/cloudflare_adapter.ts';
import type { LogQuery } from '../src/logs/types.ts';
import { targets } from '../src/registry/app_registry.ts';
import { setDeploymentValues } from '../src/registry/deployment_values.ts';

const NOW = 1_760_000_000_000;

const query = (overrides: Partial<LogQuery> = {}): LogQuery => ({
  app: 'web',
  mode: 'staging',
  follow: true,
  duration: '30s',
  ...overrides,
});

/**
 * Capture everything the tail writes, and record the argv it would spawn.
 *
 * The callback is handed the runner's real `onStdout`, so lines travel the same path
 * they would in production — parsing, predicate and all. A harness that fed lines in
 * some other way would test the harness rather than the tail, which is how "0 shown"
 * appeared while the function was working.
 */
type Emit = (onStdout: (line: string) => void) => void;

const harness = (
  emit: Emit,
  code = 0,
): {
  spawned: string[][];
  timeouts: (number | undefined)[];
  out: string[];
  err: string[];
  restore: () => void;
} => {
  const spawned: string[][] = [];
  const timeouts: (number | undefined)[] = [];
  const out: string[] = [];
  const err: string[] = [];

  // The binary is the seam too: `streamWrangler` refuses before reaching the runner
  // when wrangler is absent, so an injected runner alone is never called.
  setStreamBinary('/test/wrangler');

  setStreamRunner({
    run: async (_command, args, _options, handlers) => {
      spawned.push([...args]);
      timeouts.push(_options.timeoutMs);
      emit((line: string) => handlers.onStdout(line));
      return code;
    },
  });

  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  return {
    spawned,
    timeouts,
    out,
    err,
    restore: () => {
      process.stdout.write = writeOut;
      process.stderr.write = writeErr;
    },
  };
};

/** A provider envelope as `wrangler tail --format json` emits it. */
const envelope = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    event: {
      timestamp: NOW,
      level: 'ERROR',
      message: 'notes.create_failed',
      source: 'worker',
      traceId: 'tr_1',
      ...overrides,
    },
  });

afterEach(() => {
  setStreamRunner(null);
  setStreamBinary(null);
  setDeploymentValues(null);
});

describe('tailCloudflare', () => {
  const provision = (): void => {
    setDeploymentValues({
      workerName: 'starter-web',
      d1DatabaseId: 'db-1',
      r2BucketNames: { uploads: null },
      customDomain: null,
      jobsProfile: 'disabled',
      accountId: 'a'.repeat(32),
    });
  };

  test('prints only events that pass the predicate', async () => {
    provision();
    const h = harness((emit) => {
      emit(envelope({ message: 'keep me', source: 'worker' }));
      emit(envelope({ message: 'drop me', source: 'browser' }));
    });

    try {
      const result = await tailCloudflare(query({ source: 'worker', followBudgetMs: 5_000 }));

      expect(result.status).toBe('ok');
      // `--source worker` is honoured, so the browser-sourced event is filtered out
      // and only one reaches stdout. Both arrived; one was printed.
      const printed = h.out.filter((line) => line.startsWith('{'));
      expect(printed).toHaveLength(1);
      expect(printed[0]).toContain('keep me');
      expect(h.out.join('\n')).not.toContain('drop me');
      // The count in the message is the count printed, not the count received: a
      // filtered count that disagreed with the output is how a reader concludes a
      // request never happened when it did.
      expect(result.message).toContain('1 shown');
    } finally {
      h.restore();
    }
  });

  test('drops an unparseable line instead of printing it as an event', async () => {
    // wrangler prints its own banners and diagnostics on stdout. Passing one of those
    // downstream as an event is what made the previous tail emit plausible-looking
    // nonsense.
    provision();
    const h = harness((emit) => {
      emit('⛅️ wrangler 3.114.0');
      emit('--- Waiting for logs ---');
      emit('{ this is not json');
      emit(envelope({ message: 'a real event' }));
    });

    try {
      const result = await tailCloudflare(query({ followBudgetMs: 5_000 }));

      expect(result.status).toBe('ok');
      const printed = h.out.filter((line) => line.startsWith('{'));
      expect(printed).toHaveLength(1);
      expect(printed[0]).toContain('a real event');
      expect(h.out.join('\n')).not.toContain('Waiting for logs');
    } finally {
      h.restore();
    }
  });

  test('a session that reaches its bound reports failure, not a clean finish', async () => {
    // `code !== 0` is what a killed `wrangler tail` returns. Reporting `ok` here
    // would say the stream ran to completion and printed everything, which is the
    // opposite of what a `--follow` that hit `--duration` did.
    provision();
    const h = harness(() => {}, 1);

    try {
      const result = await tailCloudflare(query({ followBudgetMs: 300 }));

      expect(result.status).toBe('retrieval_failed');
      expect(result.message).toContain('exited 1');
      // The bound is named, so the operator knows why it stopped rather than
      // wondering whether the Worker went quiet.
      expect(result.message).toContain('after');
    } finally {
      h.restore();
    }
  });

  test('refuses --uid without spawning anything', async () => {
    // `wrangler tail` is a live event stream with no index, so it cannot filter by
    // any field. Forwarding the flag would have the provider ignore it while the
    // client-side predicate narrowed — so the result looks filtered and is not.
    provision();
    const h = harness(() => {});

    try {
      const result = await tailCloudflare(query({ uid: 'user_1', followBudgetMs: 5_000 }));

      expect(result.status).toBe('capability_unsupported');
      expect(result.message).toContain('cannot filter by user id');
      expect(h.spawned).toEqual([]);
    } finally {
      h.restore();
    }
  });

  test('refuses --trace without spawning anything', async () => {
    provision();
    const h = harness(() => {});

    try {
      const result = await tailCloudflare(query({ trace: 'tr_1', followBudgetMs: 5_000 }));

      expect(result.status).toBe('capability_unsupported');
      expect(h.spawned).toEqual([]);
    } finally {
      h.restore();
    }
  });

  test('clamps the session budget to the maximum, whatever the caller asks', async () => {
    // `--follow` with no end is not a command. The adapter enforces the bound rather
    // than trusting `--duration`, so a caller cannot decide to run unbounded.
    provision();
    const h = harness(() => {});

    try {
      await tailCloudflare(query({ followBudgetMs: MAX_TAIL_MS * 10 }));

      expect(h.spawned).toHaveLength(1);
      // The budget reaches the runner as a timeout, not as a duration string, so it
      // is bounded by construction rather than by being parsed correctly.
      expect(h.timeouts).toEqual([MAX_TAIL_MS]);
    } finally {
      h.restore();
    }
  });

  test('refuses when no Worker is provisioned', async () => {
    setDeploymentValues({
      workerName: null,
      d1DatabaseId: 'db-1',
      r2BucketNames: { uploads: null },
      customDomain: null,
      jobsProfile: 'disabled',
      accountId: 'a'.repeat(32),
    });
    const h = harness(() => {});

    try {
      const result = await tailCloudflare(query({ followBudgetMs: 5_000 }));

      expect(result.status).toBe('credentials_unavailable');
      expect(h.spawned).toEqual([]);
    } finally {
      h.restore();
    }
  });

  test('the default budget is finite', () => {
    // A regression guard rather than a behaviour test: `DEFAULT_TAIL_MS` becoming
    // `Infinity` would make `--follow` unbounded and nothing else would notice.
    expect(Number.isFinite(DEFAULT_TAIL_MS)).toBe(true);
    expect(DEFAULT_TAIL_MS).toBeLessThan(MAX_TAIL_MS);
  });
});

describe('environment-specific log targets', () => {
  test('history and tail use the selected Worker and refuse absent environments', async () => {
    const saved = process.env.CLOUDFLARE_API_TOKEN;
    const h = harness(() => {});
    try {
      process.env.CLOUDFLARE_API_TOKEN = 'fixture-token';
      setDeploymentValues({
        accountId: 'a'.repeat(32),
        workerName: 'single-web',
        d1DatabaseId: 'single-db',
        r2BucketNames: { uploads: null },
        customDomain: null,
        jobsProfile: 'disabled',
        environments: {
          staging: targets({
            workerName: 'staging-web',
            d1DatabaseId: 'staging-db',
            origin: 'https://staging.example',
          }),
        },
      });
      const requests: unknown[] = [];
      const fetchImpl: import('../src/logs/observability_client.ts').FetchLike = async (
        _url,
        init,
      ) => {
        requests.push(JSON.parse(init.body));
        return { ok: true, status: 200, text: async () => '{"result":{"data":[]}}' };
      };
      const built = buildHistoricalRequest(query());
      expect(built.ok).toBe(true);
      if (built.ok) {
        expect(built.request.datasets).toEqual(['staging-web']);
      }
      expect((await queryCloudflareHistory(query(), fetchImpl)).status).toBe('ok');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toHaveProperty('datasets', ['staging-web']);
      await tailCloudflare(query());
      expect(h.spawned[0]).toContain('staging-web');
      expect(h.spawned[0]).not.toContain('single-web');

      expect(buildHistoricalRequest(query({ mode: 'production' })).ok).toBe(false);
      expect((await queryCloudflareHistory(query({ mode: 'production' }), fetchImpl)).status).toBe(
        'credentials_unavailable',
      );
      expect((await tailCloudflare(query({ mode: 'production' }))).status).toBe(
        'credentials_unavailable',
      );
      expect(requests).toHaveLength(1);
      expect(h.spawned).toHaveLength(1);
    } finally {
      h.restore();
      if (saved === undefined) {
        delete process.env.CLOUDFLARE_API_TOKEN;
      } else {
        process.env.CLOUDFLARE_API_TOKEN = saved;
      }
    }
  });
});
