// packages/backend/database/src/lib/schema.ts
//
// Drizzle schema for Cloudflare D1 (SQLite).
//
// Deliberately small: the Better Auth tables plus one owned domain table.
// Drizzle is used directly at the call site — there is no
// repository/controller/service wrapper, because such a layer that only
// restates a `select()` adds a file and an indirection without adding a rule.
//
// D1 is SQLite, so everything below is SQLite dialect. `integer(...,
// { mode: 'timestamp' })` gives epoch-millisecond Date columns.

import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// -----------------------------------------------------------------------------
// Better Auth tables
//
// These tables are owned by Better Auth's expectations, not by this project.
// Round 1 enables email + password only — no OAuth provider, no email
// verification — but the schema still carries the OAuth columns, because Better
// Auth validates its expected shape against the adapter at runtime and refuses
// to start when it is incomplete.
//
// That is worth stating plainly: removing them would "simplify" the schema and
// break sign-in at runtime, not at build time. Better Auth checks
// `dist/db/schema.mjs`.
//
// `deviceCodes` is the exception: it is no longer required by any enabled
// plugin, and it is retained only because its migration is applied.
// -----------------------------------------------------------------------------

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  /** FK to `users.id`. Cascade is correct: a session cannot outlive its user. */
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `"credential"` for email+password. Other providers are not enabled. */
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    /** Scrypt hash. `null` for a provider that does not use a password. */
    password: text('password'),
    // Present because Better Auth requires the columns, unused because no OAuth
    // provider is configured. Documented rather than quietly present.
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
    scope: text('scope'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('accounts_user_provider_account_idx').on(
      table.userId,
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

/**
 * Device-authorization codes. Used by the native client, and kept on purpose.
 *
 * This table serves a native client that signs in by approving a short user code in
 * a browser it does not own. `apps/frontend/native` does that through the pinned
 * Better Auth `device-authorization` plugin, whose model name is `deviceCode` — so
 * the entry in `betterAuthSchema` below is what makes the plugin write here.
 *
 * Two things are deliberate:
 *
 *   - **The columns are the plugin's, plus this repository's usual audit pair.** The
 *     plugin owns `device_code`, `user_code`, `user_id`, `expires_at`, `status`,
 *     `last_polled_at`, `polling_interval`, `client_id` and `scope`; `created_at`
 *     and `updated_at` are added by the Drizzle adapter for every model it manages.
 *     Nothing here is invented for this application's convenience, so a plugin
 *     upgrade that changes its fields shows up as a missing column rather than as a
 *     silently unwritten value.
 *   - **It stays in migrations that have been applied.** The table was created in
 *     `0001_early_captain_cross.sql` and exists in deployed databases. Re-enabling
 *     the plugin needed **no new migration**, which is verified rather than assumed:
 *     `bun run db:generate` produces no diff against this schema, and the Worker
 *     integration test exercises the whole flow against real local D1.
 *
 * Dropping it would also be a behavioural change rather than a cleanup: the rows
 * are what a pending native sign-in is waiting on, and a signed-in user revoking
 * one is a supported operation.
 */
export const deviceCodes = sqliteTable(
  'device_codes',
  {
    id: text('id').primaryKey(),
    deviceCode: text('device_code').notNull(),
    userCode: text('user_code').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    /** `pending` | `approved` | `denied`. */
    status: text('status').notNull(),
    lastPolledAt: integer('last_polled_at', { mode: 'timestamp' }),
    pollingInterval: integer('polling_interval'),
    clientId: text('client_id'),
    scope: text('scope'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('device_codes_device_code_idx').on(table.deviceCode),
    uniqueIndex('device_codes_user_code_idx').on(table.userCode),
  ],
);

// -----------------------------------------------------------------------------
// Rate limiting
// -----------------------------------------------------------------------------

/**
 * Fixed-window counters for the auth rate limiter.
 *
 * Not a Better Auth model. Better Auth's own `rateLimit` table has no `id` column,
 * which its Drizzle adapter requires for the atomic increment it uses — see
 * `d1_rate_limit.ts` for the full account. This table is reached only by that
 * module's single-statement upsert, which is why the shape is exactly what the
 * statement needs and nothing more.
 *
 * `key` is Better Auth's `"<ip>|<path>"` bucket, so it is unique by construction;
 * making it the primary key is what lets `ON CONFLICT` do the work.
 */
export const rateLimits = sqliteTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
});

// -----------------------------------------------------------------------------
// Domain: notes
// -----------------------------------------------------------------------------

/**
 * A user-owned note.
 *
 * The ownership index is not decoration: every read and every write filters on
 * `owner_id`, and this index is what makes that filter cheap as a user
 * accumulates notes. It is the index the authorization test exercises.
 */
export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    /** FK to `users.id`. Cascade: deleting an account deletes its notes. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('notes_owner_id_idx').on(table.ownerId),
    index('notes_owner_updated_idx').on(table.ownerId, table.updatedAt),
  ],
);

// -----------------------------------------------------------------------------
// Domain: jobs
//
// Four indexes, each of which is a rule rather than a performance hint. Read
// them as claims: if one of them is wrong, the rule it enforces stops being
// enforced by the database and starts being enforced by a read-then-write check
// somewhere in application code, which is exactly the race this schema exists to
// make impossible.
//
//   * `jobs_owner_idempotency_key_uq` — one idempotency key per owner. This is
//     what makes "the same key returns the same job" true under concurrency: the
//     second concurrent request loses the insert, and it does not lose it because
//     it read first and decided so.
//
//   * `jobs_owner_active_uq` — a *partial* unique index over `owner_id` where the
//     job is `pending` or `running`. It is how "at most one active job per user"
//     is enforced atomically. A `SELECT count(*)` first would admit two jobs
//     whenever two requests overlapped, which under load is precisely when the
//     limit matters.
//
//   * `jobs_owner_created_idx` — the per-user hourly budget count and the owner's
//     listing. Both are `WHERE owner_id = ? AND created_at >= ?` scans.
//
//   * `jobs_created_idx` — the environment's per-UTC-day budget count.
//
// The hourly and daily budgets are counted from this table rather than kept in a
// counter row, because the count is read as a subquery *inside* the inserting
// statement. That is the whole trick: `INSERT ... SELECT ... WHERE (SELECT
// count(*) ...) < 5` is one statement, so SQLite decides it atomically and two
// concurrent requests cannot both see four.
// -----------------------------------------------------------------------------

/**
 * One encode job.
 *
 * Attempt fencing lives in `activeAttemptId`: a terminal write names the attempt
 * that must currently hold the lease, so a slow attempt that wakes up after its
 * lease was reclaimed and completed cannot overwrite the newer committed result.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    /** FK to `users.id`. Cascade: deleting an account deletes its jobs. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Only `encode` exists. A second kind arrives with a migration, not a guess. */
    kind: text('kind').notNull().default('encode'),
    /** `pending` | `running` | `succeeded` | `failed`. Never a fifth value. */
    status: text('status').notNull().default('pending'),
    /** The frozen fixture identity, copied from the admitted request. */
    fixture: text('fixture').notNull(),
    /** The frozen preset identity, copied from the admitted request. */
    preset: text('preset').notNull(),
    /**
     * Owner-scoped idempotency key.
     *
     * Scoped to the owner rather than global so two users who happen to choose the
     * same key — a shared client-generated value, a test fixture — do not collide
     * and cannot read each other's jobs by guessing a key.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    /**
     * Hash of the canonical request body.
     *
     * The reason a replay can be told from a conflict: same key *and* same
     * fingerprint returns the stored job, same key with a different fingerprint is
     * a caller reusing a key for a different request and gets 409 rather than
     * somebody else's job.
     */
    requestFingerprint: text('request_fingerprint').notNull(),
    /**
     * The Workflow instance this job runs in. Derived from the job id, so it is
     * stable across a crash, a retry and a reconciliation pass.
     */
    workflowId: text('workflow_id').notNull(),
    /**
     * `pending` | `dispatched` | `dispatch_failed`.
     *
     * Persisted with the job rather than held in memory, because the interesting
     * failure is exactly the one that loses memory: D1 committed the admission
     * and the Workflow call then failed. `pending` is what recovery looks for.
     */
    dispatchState: text('dispatch_state').notNull().default('pending'),
    /** How many times a dispatch was attempted. Bounds recovery's retries. */
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    /**
     * A frozen code, never a provider message. Sized to a code because the
     * unbounded alternative is a container's error text stored forever.
     */
    dispatchError: text('dispatch_error'),
    dispatchedAt: integer('dispatched_at', { mode: 'timestamp' }),
    /**
     * The attempt currently holding the lease. Null when nothing is running.
     *
     * Both terminal writes filter on this value, which is the fence: an attempt
     * that was superseded has a different id here and therefore matches no rows.
     */
    activeAttemptId: text('active_attempt_id'),
    /** When the current attempt's lease expires. Another may claim it after. */
    leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp' }),
    /** How many attempts have ever claimed this job. Bounds `MAX_JOB_ATTEMPTS`. */
    attemptCount: integer('attempt_count').notNull().default(0),
    /**
     * Private storage key for the artifact. Never leaves the server plane.
     *
     * Deliberately *not* on the wire DTO: a client that knows the key would need
     * the bucket, and a bucket binding handed to a browser is a public bucket.
     */
    outputKey: text('output_key'),
    outputBytes: integer('output_bytes'),
    outputSha256: text('output_sha256'),
    outputContainerFormat: text('output_container_format'),
    outputVideoCodec: text('output_video_codec'),
    outputWidth: integer('output_width'),
    outputHeight: integer('output_height'),
    outputDurationMs: integer('output_duration_ms'),
    /** When retention removes the bytes. Null until an encode committed. */
    outputExpiresAt: integer('output_expires_at', { mode: 'timestamp' }),
    /** A code from `JOB_ERROR_CODES`. Null until the job fails. */
    errorCode: text('error_code'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('jobs_owner_idempotency_key_uq').on(table.ownerId, table.idempotencyKey),
    index('jobs_owner_created_idx').on(table.ownerId, table.createdAt),
    index('jobs_created_idx').on(table.createdAt),
    // Bounded recovery: "which admissions never reached a Workflow?" is a scan of
    // exactly this shape, and it must be able to answer it with a LIMIT.
    index('jobs_dispatch_state_idx').on(table.dispatchState, table.createdAt),
    // The retention sweep: terminal jobs whose artifact is past its cutoff.
    index('jobs_output_expiry_idx').on(table.outputExpiresAt),
    // The atomic active-job cap. Partial, so a user may hold any number of
    // finished jobs and exactly one unfinished one. This is the index the whole
    // admission design rests on: the inserting statement either wins this or
    // affects no rows, and no read-then-write check exists anywhere to get it
    // wrong.
    uniqueIndex('jobs_owner_active_uq')
      .on(table.ownerId)
      .where(sql`${table.status} in ('pending', 'running')`),
    // Four states, not "whatever was written". A typo in a status write is a
    // constraint violation at the database rather than a job that is invisible to
    // every query in the repository.
    check(
      'jobs_status_check',
      sql`${table.status} in ('pending', 'running', 'succeeded', 'failed')`,
    ),
    check('jobs_kind_check', sql`${table.kind} in ('encode')`),
    check(
      'jobs_dispatch_state_check',
      sql`${table.dispatchState} in ('pending', 'dispatched', 'dispatch_failed')`,
    ),
  ],
);

/**
 * One row per artifact past its retention cutoff, awaiting deletion.
 *
 * Why a separate table rather than a `DELETE ... WHERE output_expires_at <= ?`:
 * the bytes live in private R2 and D1 cannot delete them, so the sequence is
 * "select the keys, delete the bytes, then delete the row". Doing that atomically in
 * one statement would drop the record of work whose bytes were never removed, and
 * the next run would have nothing to retry with. A row that survives a failed
 * byte-deletion is therefore the recovery record, and `runs` bounds the attempts.
 */
export const jobArtifactRetirements = sqliteTable('job_artifact_retirements', {
  /** The job whose artifact is due. */
  jobId: text('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  /** The private key the bytes are under, kept so a retry needs no second read. */
  outputKey: text('output_key').notNull(),
  /** How many deletion attempts have been made. */
  runs: integer('runs').notNull().default(0),
  /** Epoch ms the cutoff was taken at, so the sweep is deterministic. */
  cutoffAt: integer('cutoff_at', { mode: 'timestamp' }).notNull(),
});

/**
 * One scheduled maintenance run, keyed by what caused it.
 *
 * The primary key *is* the deduplication mechanism, and that is the whole reason
 * this table exists. A cron schedule can fire twice for one slot — a retry, a
 * duplicated configuration, an operator's manual trigger landing on the same
 * minute — and maintenance is destructive: it deletes sessions, rate-limit
 * windows and stored artifacts. "Run at most once per slot" therefore has to be a
 * property of the database rather than a promise the schedule makes, so the run
 * key is the primary key and the inserting statement is
 * `INSERT … ON CONFLICT DO NOTHING`. A second invocation of the same slot
 * affects no rows and reports why.
 *
 * The key is derived from the *trigger*, never supplied freely:
 *
 *   `scheduled:<scheduledTimeMs>` — one key per scheduled slot, so a duplicate
 *   firing of `17 * * * *` addresses the same row.
 *   `manual:<requestId>` — a manual invocation is its own run, and a retried
 *   manual *request* (same request id) does not run twice.
 *
 * Because the two prefixes cannot collide, a manual run is never mistaken for a
 * scheduled one — which is the difference between honest scheduler evidence and
 * a run that was started by hand and reported as natural.
 */
export const maintenanceRuns = sqliteTable(
  'maintenance_runs',
  {
    /**
     * `scheduled:<epochMs>` or `manual:<requestId>`. See the table comment: the
     * key is the deduplication mechanism, so nothing here is nullable.
     */
    runKey: text('run_key').primaryKey(),
    /** `scheduled` for a cron firing, `manual` for an operator or a test. */
    trigger: text('trigger').notNull(),
    /** The slot label, e.g. `2026-10-03T17:00:00Z`. Null for a manual run. */
    slot: text('slot'),
    /** The provider's `scheduledTime`, epoch ms. Null for a manual run. */
    scheduledTime: integer('scheduled_time', { mode: 'timestamp' }),
    /** `running` | `succeeded` | `failed`. */
    status: text('status').notNull().default('running'),
    /** One instant for every cutoff in the run. Null until the sweep starts. */
    cutoffAt: integer('cutoff_at', { mode: 'timestamp' }),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    // Truthful counts, one column per number the report carries. Each is a row
    // count the database reported, never a count of rows a statement selected.
    expiredSessions: integer('expired_sessions').notNull().default(0),
    idleRateLimits: integer('idle_rate_limits').notNull().default(0),
    artifactsQueued: integer('artifacts_queued').notNull().default(0),
    artifactsRetired: integer('artifacts_retired').notNull().default(0),
    pendingDispatches: integer('pending_dispatches').notNull().default(0),
    /** A frozen code when the run failed. Never provider text. */
    errorCode: text('error_code'),
  },
  (table) => [
    // "What was the most recent run?" — the query a demo dashboard and a future
    // jobs screen both ask, and it is answered without touching a sweep.
    index('maintenance_runs_started_idx').on(table.startedAt),
    check(
      'maintenance_runs_status_check',
      sql`${table.status} in ('running', 'succeeded', 'failed')`,
    ),
    check('maintenance_runs_trigger_check', sql`${table.trigger} in ('scheduled', 'manual')`),
  ],
);

// -----------------------------------------------------------------------------
// Row types
//
// Derived from the schema, never hand-written alongside it: a parallel
// hand-maintained type is exactly how a migration and a type drift apart.
// -----------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type NewNoteRow = typeof notes.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type JobArtifactRetirementRow = typeof jobArtifactRetirements.$inferSelect;
export type MaintenanceRunRow = typeof maintenanceRuns.$inferSelect;

// The chat tables live in their own module — `schema.ts` is already the longest file
// in this package — and are imported here so the database schema has one import
// site. Imported rather than duplicated: two declarations of the same table would
// produce two objects for one table, and Drizzle would not notice.
export { conversations, messages } from './chat_tables.ts';
export type { ConversationRow, MessageRow } from './chat_tables.ts';

/**
 * Column->table map handed to Better Auth's Drizzle adapter. The adapter looks
 * tables up by its own singular model names (`user`, `session`, ...), which do
 * not match the exported variable names, hence this explicit map.
 */
export const betterAuthSchema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  deviceCode: deviceCodes,
} as const;
