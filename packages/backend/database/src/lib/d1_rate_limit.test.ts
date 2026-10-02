// packages/backend/database/src/lib/d1_rate_limit.test.ts
//
// The rate limiter's decision, on a real SQLite engine.
//
// Why a hand-built adapter instead of a mock: the whole claim of this module is
// that the verdict lives in one SQL statement. A mock that returns the answers
// the tests expect would prove that the code reads `count <= max`, which is not
// the claim under test. `bun:sqlite` runs the actual statement, so an upsert
// that does not do what the comment says fails here.
//
// `bun:sqlite` rather than D1 because D1 only exists inside workerd, and this
// file must run in the unit lane. The same statement is exercised against real
// D1 in `apps/frontend/client/tests/worker_integration.test.ts`; if these two
// engines ever disagreed about the upsert, one of those two suites goes red.

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createD1RateLimitStorage, type RateLimitDatabase } from './d1_rate_limit.ts';

/** The migration's table, verbatim, so a schema drift breaks these tests. */
const CREATE_TABLE = `CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  last_request INTEGER NOT NULL
);`;

/**
 * A `bun:sqlite` database behind the same two-method surface as D1.
 *
 * `prepare` on a real D1 statement is synchronous, so this mirrors that rather
 * than being lazy about it: a wrapper that awaited `prepare` would let a
 * production-only assumption through.
 */
const sqliteAdapter = (sql: Database): RateLimitDatabase => ({
  prepare(query: string) {
    const statement = sql.query(query);
    return {
      bind(...values: unknown[]) {
        return {
          async all<T>() {
            return { results: statement.all(...(values as never[])) as T[] };
          },
        };
      },
    };
  },
});

interface Harness {
  storage: ReturnType<typeof createD1RateLimitStorage>;
  rows: () => Array<{ key: string; count: number; last_request: number }>;
  /** Move the injected clock. The only way time passes in this file. */
  advance(ms: number): void;
}

/**
 * A harness with a clock the test drives.
 *
 * Every window assertion below is a claim about time passing, and the repository's
 * rule is to inject a budget rather than sleep. A `setTimeout` here would make the
 * suite slow *and* flaky, and would still not prove that the window boundary is
 * handled by the statement rather than by a timer somewhere else.
 */
const harness = (startMs = 1_700_000_000_000): Harness => {
  const sql = new Database(':memory:');
  sql.run(CREATE_TABLE);
  let clock = startMs;
  const storage = createD1RateLimitStorage(sqliteAdapter(sql), { now: () => clock });

  return {
    storage,
    rows: () =>
      sql.query('SELECT key, count, last_request FROM rate_limits ORDER BY key').all() as Array<{
        key: string;
        count: number;
        last_request: number;
      }>,
    advance(ms: number) {
      clock += ms;
    },
  };
};

const KEY = '203.0.113.7|/sign-in/email';

describe('a single-statement D1 rate limit', () => {
  test('allows exactly `max` requests in one window and then refuses', async () => {
    const { storage } = harness();

    const withinBudget = await Promise.all(
      Array.from({ length: 3 }, () => storage.consume(KEY, { window: 60, max: 3 })),
    );
    expect(withinBudget.map((decision) => decision.allowed)).toEqual([true, true, true]);
    expect(withinBudget.every((decision) => decision.retryAfter === null)).toBe(true);

    const refused = await storage.consume(KEY, { window: 60, max: 3 });
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBe(60);
  });

  test('a refused request does not push its own window further out', async () => {
    const clock = harness();
    await clock.storage.consume(KEY, { window: 60, max: 1 });
    await clock.storage.consume(KEY, { window: 60, max: 1 });

    const first = await clock.storage.consume(KEY, { window: 60, max: 1 });
    clock.advance(20_000);
    const later = await clock.storage.consume(KEY, { window: 60, max: 1 });

    // `last_request` must still be the first request's instant, so both refusals
    // report the same 40s. A limiter that bumped the window on every rejection
    // could be held shut indefinitely by hammering it.
    expect(first.retryAfter).toBe(60);
    expect(later.retryAfter).toBe(40);
  });

  test('the window reopens on its own once it elapses', async () => {
    const clock = harness();
    await clock.storage.consume(KEY, { window: 60, max: 1 });
    expect((await clock.storage.consume(KEY, { window: 60, max: 1 })).allowed).toBe(false);

    clock.advance(59_999);
    expect((await clock.storage.consume(KEY, { window: 60, max: 1 })).allowed).toBe(false);

    clock.advance(1);
    expect((await clock.storage.consume(KEY, { window: 60, max: 1 })).allowed).toBe(true);
  });

  test('an elapsed window resets the count instead of accumulating forever', async () => {
    const clock = harness();
    for (let round = 0; round < 5; round += 1) {
      await clock.storage.consume(KEY, { window: 60, max: 2 });
      await clock.storage.consume(KEY, { window: 60, max: 2 });
      clock.advance(60_000);
    }

    // `count` climbing to 11 across five windows would mean the reset branch is
    // never taken and the limiter eventually refuses a caller doing nothing wrong.
    expect(clock.rows()[0]?.count).toBeLessThanOrEqual(3);
  });

  test('separate keys hold separate budgets', async () => {
    const { storage } = harness();
    const other = '198.51.100.4|/sign-in/email';

    await storage.consume(KEY, { window: 60, max: 1 });
    expect((await storage.consume(KEY, { window: 60, max: 1 })).allowed).toBe(false);
    expect((await storage.consume(other, { window: 60, max: 1 })).allowed).toBe(true);
  });

  test('a key containing a separator cannot collide with another key', async () => {
    const { storage, rows } = harness();
    await storage.consume('a|/sign-in', { window: 60, max: 1 });
    await storage.consume('a|', { window: 60, max: 5 });

    // Better Auth builds `ip|path`. A hostile `ip` cannot be chosen, but a path
    // can, and two rows must exist either way — the budget is keyed on the whole
    // string, never reassembled from parts.
    expect(rows()).toHaveLength(2);
  });

  test('concurrent requests cannot overshoot the budget', async () => {
    const { storage, rows } = harness();
    const attempts = 40;

    // One statement per request, all in flight at once. This is the assertion an
    // isolate-local Map cannot pass and a get/set counter cannot either: it is
    // only true because the check and the increment are the same write.
    const decisions = await Promise.all(
      Array.from({ length: attempts }, () => storage.consume(KEY, { window: 60, max: 5 })),
    );

    // Exactly 5, never 6: the boundary row must not be ambiguous.
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    // Every refused request also counted itself, so the stored counter is the
    // total attempt count. That is the cost of the unambiguous `count <= max`
    // verdict, and it is bounded by one window's traffic rather than by time.
    expect(rows()[0]?.count).toBe(attempts);
  });

  test('a malformed rule cannot be read as "allow everything"', async () => {
    const { storage, rows } = harness();
    // `max: 0` would make the verdict `count <= 0` false for every request, and
    // an unclamped `count <= -1` would be equally broken in the other direction.
    // The clamp means the smallest budget is one request.
    expect((await storage.consume(KEY, { window: 60, max: 0 })).allowed).toBe(true);
    expect((await storage.consume(KEY, { window: 60, max: 0 })).allowed).toBe(false);
    expect(rows()[0]?.count).toBe(2);
  });

  test('an absent table fails loudly instead of disabling the brake', async () => {
    const sql = new Database(':memory:');
    const storage = createD1RateLimitStorage(sqliteAdapter(sql));

    // No CREATE TABLE. Swallowing this would present a schema error as "no limit
    // configured", which is the exact kind of silently weakened control the
    // repository refuses to ship.
    await expect(storage.consume(KEY, { window: 60, max: 5 })).rejects.toThrow(/rate_limits/);
  });

  test('pruning removes expired rows and leaves live ones alone', async () => {
    const clock = harness();
    await clock.storage.consume('1.1.1.1|/sign-in', { window: 60, max: 1 });
    await clock.storage.consume(KEY, { window: 60, max: 1 });

    // Long enough to clear the prune throttle and age `1.1.1.1` past the flat
    // maximum, while `KEY` is refreshed immediately beforehand.
    clock.advance(25 * 60 * 60 * 1000);
    await clock.storage.consume(KEY, { window: 60, max: 1 });
    await clock.storage.consume('2.2.2.2|/sign-in', { window: 60, max: 1 });

    const keys = clock.rows().map((row) => row.key);
    expect(keys).toContain(KEY);
    expect(keys).toContain('2.2.2.2|/sign-in');
    expect(keys).not.toContain('1.1.1.1|/sign-in');
  });

  test('a short rule cannot reap a long rule’s row', async () => {
    const clock = harness();
    await clock.storage.consume('9.9.9.9|/sign-in', { window: 3600, max: 5 });

    // A 10s request arrives two hours later and triggers the prune. If the cutoff
    // followed the calling rule, the hour-long window would be reopened early.
    clock.advance(2 * 60 * 60 * 1000);
    await clock.storage.consume('8.8.8.8|/health', { window: 10, max: 100 });

    expect(clock.rows().map((row) => row.key)).toContain('9.9.9.9|/sign-in');
  });
});
