// packages/backend/database/src/lib/d1_rate_limit.ts
//
// The auth rate limiter's storage, on D1, in one SQL statement.
//
// Why this file exists rather than a configuration line
// ------------------------------------------------------
// Better Auth 1.7.6 offers `rateLimit.storage: "database"`, which is a supported
// option and the obvious choice. It does not work with the pinned Drizzle adapter,
// for a concrete and reproducible reason:
//
//   * Better Auth's generated `rateLimit` table is `{ key, count, lastRequest }`.
//     There is no `id` column (`@better-auth/core/dist/db/get-tables.mjs`).
//   * Its database consume path decides with `adapter.incrementOne()`.
//   * `@better-auth/drizzle-adapter`'s `incrementOne` resolves the row's primary
//     key column and returns `null` outright when the table has none
//     (`if (!idColumn) return null`).
//   * `null` is falsy, so Better Auth's `consume` recurses. Every recursion reads
//     the same unchanged row, so this is not a slow failure — it is unbounded
//     recursion on the request path of the one endpoint reachable without a
//     session.
//
// Adding an `id` column would sidestep that check, but it would mean a table
// whose shape contradicts the library's own schema definition. This file instead
// satisfies the interface Better Auth actually asks for — `rateLimit.customStorage`
// — with a single statement that does not need an `id` at all.
//
// The atomicity argument
// ----------------------
// `BetterAuthRateLimitStorage.consume` is deliberately a *single* operation. Its
// own documentation explains why: "N simultaneous requests can no longer all pass
// a stale read before any increment lands." That is the gap a separate
// get/set/increment has, and it is exactly the gap an isolate-local `Map` has —
// every Cloudflare isolate would enforce its own budget and a determined caller
// would simply be routed to a fresh isolate.
//
// So the whole decision is one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`.
// SQLite executes an upsert as a single write transaction: the row is located,
// compared and rewritten without another statement observing it in between.
// Concurrent requests therefore serialize on that write, and `count` cannot
// overshoot `max`.
//
// The decision, spelled out
// -------------------------
// `last_request` is the start of the active window, matching Better Auth's own
// `getRetryAfter(lastRequest, window)`, so `retryAfter` means the same thing here
// as it does in the in-memory path. Within one statement:
//
//   insert  (no row yet)          -> count = 1                  -> allowed when 1 <= max
//   reset   (window elapsed)      -> count = 1, last = now      -> allowed when 1 <= max
//   spend   (count < max)         -> count = old + 1            -> allowed when count <= max
//   refuse  (count >= max)        -> count = old + 1            -> blocked  when count >  max
//
// `count` is incremented on the refusing branch too. That is what makes the
// verdict unambiguous: it is read back as `count <= max`, and a blocked request
// pushes `count` strictly above `max`. The alternative — leaving `count` alone
// when refusing — collides exactly on the boundary row `count === max`, where
// "allowed because count <= max" and "blocked because count >= max" are the same
// statement. `last_request` is deliberately *not* advanced on the refusing
// branch, so a client hammering a closed window cannot push its own unlock
// further out with every rejected request.
//
// Nothing here reads a clock from outside the arguments and nothing reads
// process state, so two isolates sharing one D1 database enforce one budget.

/** One rate-limit decision. Mirrors Better Auth's `consume` return shape. */
export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window frees up, or null when allowed. */
  retryAfter: number | null;
}

export interface RateLimitRule {
  /** Window length in seconds. */
  window: number;
  /** Requests allowed inside one window. */
  max: number;
}

export interface RateLimitStorage {
  consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;
}

/**
 * The slice of the D1 API this storage uses.
 *
 * Declared structurally rather than importing `@cloudflare/workers-types`,
 * because this package is plain TypeScript and the real `D1Database` satisfies it
 * without a cast. Adding a dependency to name two methods would be a worse
 * trade than writing them out.
 */
export interface RateLimitDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}

interface RateLimitRow {
  count: number;
  last_request: number;
}

/**
 * `?` placeholders rather than `?1`/`?2` or named parameters.
 *
 * The repeated `?` for the same value looks redundant until you count them: the
 * clock is read seven times in one statement and every occurrence must be the
 * same instant. Binding one value seven times is the only way to guarantee that
 * without a helper the reader would have to trust.
 */
const CONSUME_SQL = `
INSERT INTO rate_limits (key, count, last_request)
VALUES (?, 1, ?)
ON CONFLICT(key) DO UPDATE SET
  count = CASE
    WHEN ? - last_request >= ? THEN 1
    ELSE count + 1
  END,
  last_request = CASE
    WHEN ? - last_request >= ? THEN ?
    ELSE last_request
  END
RETURNING count, last_request
`;

/**
 * Delete windows nobody is using any more.
 *
 * Without this the table grows one row per distinct `ip|path` forever, on a
 * database that a rate limiter is otherwise invisible to. The delete is bounded
 * by `LIMIT`, so one run cannot monopolise a D1 write.
 *
 * The cutoff is a flat age rather than the calling request's own window. Using
 * `now - rule.window` would let a 10-second rule reap rows belonging to an
 * hour-long rule, reopening a window that is still supposed to be closed. A
 * fixed age that exceeds every window this application configures cannot do
 * that, and needs no cross-request bookkeeping to stay safe.
 *
 * `lastPrunedAt` is module scope, and that is deliberate and narrow: it decides
 * *when housekeeping runs*, never whether a request is allowed. The decision
 * above is one SQL statement that this value cannot influence — an isolate that
 * never prunes is slower to clean up, not weaker at limiting.
 */
const PRUNE_AFTER_MS = 60_000;
const PRUNE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 200;
const PRUNE_SQL = 'DELETE FROM rate_limits WHERE last_request < ? LIMIT ?';

export interface D1RateLimitStorageOptions {
  /**
   * Injectable clock, in epoch milliseconds.
   *
   * Time-bounded behaviour is proven by injecting a budget rather than by
   * sleeping, which is the repository's rule for anything with a deadline in it.
   */
  now?: () => number;
  /** Bound on one prune statement's row count. */
  pruneBatch?: number;
}

export const createD1RateLimitStorage = (
  db: RateLimitDatabase,
  options: D1RateLimitStorageOptions = {},
): RateLimitStorage => {
  const now = options.now ?? Date.now;
  const pruneBatch = options.pruneBatch ?? PRUNE_BATCH;
  let lastPrunedAt = 0;

  return {
    async consume(key, rule) {
      // Clamped so a malformed rule cannot produce `count <= 0`, which the
      // `count <= max` verdict would read as "allow everything".
      const max = Math.max(1, Math.floor(rule.max));
      const windowMs = Math.max(1, Math.floor(rule.window)) * 1000;
      const at = now();

      const rows = (
        await db
          .prepare(CONSUME_SQL)
          .bind(key, at, at, windowMs, at, windowMs, at)
          .all<RateLimitRow>()
      ).results;

      const row = rows[0];
      if (row === undefined) {
        // An upsert always returns its row. Reaching here means the statement
        // changed shape or the table is missing, and guessing "allowed" would
        // turn a schema error into a silently disabled brake.
        throw new Error(
          'rate limit consume returned no row. Is the rate_limits migration applied?',
        );
      }

      const allowed = row.count <= max;
      const decision: RateLimitDecision = allowed
        ? { allowed: true, retryAfter: null }
        : {
            allowed: false,
            retryAfter: Math.max(1, Math.ceil((row.last_request + windowMs - at) / 1000)),
          };

      if (at - lastPrunedAt >= PRUNE_AFTER_MS) {
        lastPrunedAt = at;
        await db
          .prepare(PRUNE_SQL)
          .bind(at - PRUNE_MAX_AGE_MS, pruneBatch)
          .all<unknown>()
          .catch(() => {
            // Housekeeping failing must not turn a refused request into a 500.
            // The row still exists; the next prune will catch it.
          });
      }

      return decision;
    },
  };
};
