// packages/backend/jobs/src/lib/maintenance_run.ts
//
// Durable maintenance runs: the record of what a sweep did, and the mechanism
// that stops one slot from being swept twice.
//
// Why this file exists
// --------------------
// A schedule is a promise. `17 * * * *` means "about every hour", and a provider
// is entitled to retry a firing, to deliver one twice, and to deliver one while
// the previous is still running. Maintenance here is *destructive*: it deletes
// expired sessions, idle rate-limit windows and stored artifacts. So "exactly
// once per slot" cannot be a property of the trigger — it has to be a property
// of the database, and the only place to put that is a unique key the run has to
// win.
//
// Hence `maintenance_runs.run_key` as the primary key, with the inserting
// statement being `INSERT … ON CONFLICT DO NOTHING`. Two invocations of the same
// slot, at the same instant or a second apart, produce one row and one sweep.
//
// The run key is derived, never supplied
// --------------------------------------
// `scheduledRunKey(scheduledTimeMs)` is `scheduled:<epoch-ms>`. The provider's
// `event.schedule.scheduledTime` is the slot, so every firing of one slot names
// the same row and a retried firing is recognised as the same run.
//
// `manualRunKey(requestId)` is `manual:<request-id>`. A manual invocation is its
// own run and must never be reported as a scheduled one, so the prefix differs;
// and a manual *request* that is retried (same request id) names the same row, so
// a double-click cannot double the deletions either.
//
// Both facts are recorded on the row, which is what makes "the last run was
// scheduled" a question the database can answer rather than a claim in a log.
//
// Overlap, and recovery from a crashed run
// ----------------------------------------
// A run left `running` by a crashed instance is not a slot that will never be
// swept again; it is a stale claim. `begin` takes it over once it is older than
// `MAINTENANCE_RUN_TAKEOVER_MS`, and refuses before that. The window is the
// difference between "recovering a dead run" and "starting a second sweep over the
// same slot", and it is why the takeover has a duration rather than a boolean.
//
// Truthful counts
// ---------------
// Every count on the row is a number the database reported for a write that
// happened. `MAINTENANCE_CODES` is a closed union, so `error_code` cannot become
// whatever an exception's message was — the same rule the job rows follow.

import type { Clock, JobsDatabase } from './job_repository.ts';
import type { MaintenanceReport } from './maintenance.ts';

export type { MaintenanceReport };

export type { Clock };

/**
 * The one schedule this deployment runs maintenance on.
 *
 * Minute 17 rather than minute 0 on purpose. Every scheduler in the world fires
 * at `:00`, so a sweep that lands there competes with every other scheduled job
 * on the platform for the same database. `17 * * * *` is the same hourly
 * cadence, in a minute that is still hourly, without the stampede.
 *
 * Exported rather than written into `wrangler.jsonc` alone because the
 * configuration test asserts that the committed schedule *is* this string. A cron
 * expression nothing checks is a comment with a syntax error in it.
 */
export const MAINTENANCE_CRON = '17 * * * *';

/** How long a `running` row may be before another run may take it over. */
export const MAINTENANCE_RUN_TAKEOVER_MS = 30 * 60 * 1000;

/** The two things that can start a run, and the only two. */
export const MAINTENANCE_TRIGGERS = ['scheduled', 'manual'] as const;
export type MaintenanceTrigger = (typeof MAINTENANCE_TRIGGERS)[number];

/** Terminal and non-terminal run states. */
export const MAINTENANCE_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type MaintenanceRunStatus = (typeof MAINTENANCE_RUN_STATUSES)[number];

/**
 * Why a run failed, as a closed set.
 *
 * A run that crashed must be able to say why without storing an exception's
 * message: that text would be unbounded, would carry provider output, and would
 * be the thing a future reader trusts. Each code says what to do instead.
 */
export const MAINTENANCE_FAILURE_CODES = [
  'sweep_failed',
  'dispatch_recovery_failed',
  'internal_error',
] as const;
export type MaintenanceFailureCode = (typeof MAINTENANCE_FAILURE_CODES)[number];

export interface MaintenanceRun {
  runKey: string;
  trigger: MaintenanceTrigger;
  /** `2026-10-03T17:00:00Z` for a scheduled run. Null for a manual one. */
  slot: string | null;
  scheduledTime: number | null;
  status: MaintenanceRunStatus;
  cutoffAt: number | null;
  startedAt: number;
  completedAt: number | null;
  expiredSessions: number;
  idleRateLimits: number;
  artifactsQueued: number;
  artifactsRetired: number;
  pendingDispatches: number;
  errorCode: MaintenanceFailureCode | null;
}

/**
 * The slot a scheduled time belongs to, as epoch milliseconds.
 *
 * Derived from the *cron*, not assumed: an hourly schedule floors to the hour, and
 * anything with an explicit minute floors to that minute. Reading the cron's
 * minute field is what keeps this correct if the schedule is ever changed to a
 * quarter-hourly one — a hardcoded hourly floor would then collapse four distinct
 * slots into one and silently skip three of them.
 *
 * A cron this function cannot read falls back to the minute rather than to the
 * hour: the conservative choice is the finer bucket, which can under-deduplicate
 * a slot (visible as two runs) rather than over-deduplicate it (visible as a
 * whole slot never swept).
 */
export const slotFloorMs = (scheduledTimeMs: number, cron: string = MAINTENANCE_CRON): number => {
  const minuteField = cron.trim().split(/\s+/)[0] ?? '*';
  const hourly = minuteField === '*' || minuteField === '*/1';
  const floor = hourly ? 3_600_000 : 60_000;
  return Math.floor(scheduledTimeMs / floor) * floor;
};

/** The durable key for one scheduled slot. */
export const scheduledRunKey = (scheduledTimeMs: number, cron: string = MAINTENANCE_CRON): string =>
  `scheduled:${slotFloorMs(scheduledTimeMs, cron)}`;

/** The durable key for one manual request. */
export const manualRunKey = (requestId: string): string => `manual:${requestId}`;

/**
 * The slot label: the scheduled time floored to its slot, in UTC.
 *
 * UTC because the cron is UTC. A label computed in local time would make two
 * deployments describe the same slot differently, which defeats the point of a
 * label a human reads next to a count.
 */
export const slotLabel = (scheduledTimeMs: number, cron: string = MAINTENANCE_CRON): string =>
  new Date(slotFloorMs(scheduledTimeMs, cron)).toISOString().replace('.000Z', 'Z');

/**
 * What started this run, and which key it owns.
 *
 * A discriminated union rather than three optional fields, because "a manual run
 * with a scheduled time" is exactly the state that makes scheduler evidence
 * dishonest, and an optional field cannot prevent it.
 */
export type MaintenanceRunRequest =
  | {
      trigger: 'scheduled';
      /** `event.schedule.scheduledTime`. Required: a schedule with no time is not one. */
      scheduledTimeMs: number;
      /** The cron expression the provider reported. Recorded, never trusted for arithmetic. */
      cron?: string;
    }
  | {
      trigger: 'manual';
      /**
       * The caller's identity for this invocation. A retry of the same request
       * reuses it and is therefore deduplicated; two different requests are two
       * runs, which is what an operator asked for by making two.
       */
      requestId: string;
    };

/** The key, label and time for a request. One place, so the two cannot disagree. */
export const describeRunRequest = (
  request: MaintenanceRunRequest,
): { runKey: string; slot: string | null; scheduledTime: number | null } =>
  request.trigger === 'scheduled'
    ? {
        runKey: scheduledRunKey(request.scheduledTimeMs, request.cron ?? MAINTENANCE_CRON),
        slot: slotLabel(request.scheduledTimeMs, request.cron ?? MAINTENANCE_CRON),
        scheduledTime: request.scheduledTimeMs,
      }
    : { runKey: manualRunKey(request.requestId), slot: null, scheduledTime: null };

export type BeginRunOutcome =
  | {
      ok: true;
      run: MaintenanceRun /** True when a stale run was taken over. */;
      tookOver: boolean;
    }
  | {
      ok: false;
      reason: 'already_finished' | 'in_progress';
      run: MaintenanceRun;
    };

export interface MaintenanceRunRepository {
  /**
   * Claim the run for `request`, or explain which claim stopped it.
   *
   * The decision is one inserting statement. The reads afterwards only name the
   * refusal, exactly as `createEncodeJob` does for an admission budget.
   */
  begin(request: MaintenanceRunRequest, cutoffAtMs: number): Promise<BeginRunOutcome>;

  /** Record a finished sweep. Only from `running`. */
  complete(runKey: string, report: MaintenanceReport): Promise<boolean>;

  /** Record a failed sweep, with a frozen code. Only from `running`. */
  fail(runKey: string, code: MaintenanceFailureCode): Promise<boolean>;

  /** One run by key, or null. */
  get(runKey: string): Promise<MaintenanceRun | null>;

  /** The most recent runs, newest first. Bounded. */
  list(limit: number): Promise<MaintenanceRun[]>;
}

interface RunRow {
  run_key: string;
  trigger: string;
  slot: string | null;
  scheduled_time: number | null;
  status: string;
  cutoff_at: number | null;
  started_at: number;
  completed_at: number | null;
  expired_sessions: number;
  idle_rate_limits: number;
  artifacts_queued: number;
  artifacts_retired: number;
  pending_dispatches: number;
  error_code: string | null;
}

const RUN_COLUMNS = `
  run_key, trigger, slot, scheduled_time, status, cutoff_at, started_at, completed_at,
  expired_sessions, idle_rate_limits, artifacts_queued, artifacts_retired,
  pending_dispatches, error_code`;

const ms = (seconds: number | null): number | null => (seconds === null ? null : seconds * 1000);

const toRun = (row: RunRow): MaintenanceRun => {
  const trigger = MAINTENANCE_TRIGGERS.find((value) => value === row.trigger);
  const status = MAINTENANCE_RUN_STATUSES.find((value) => value === row.status);
  if (trigger === undefined || status === undefined) {
    // CHECK constraints make this unreachable through the repository. A throw
    // rather than a cast: an unreadable row is a fault, and a plausible-looking
    // record with a wrong trigger is how a manual run gets reported as scheduled.
    throw new Error(`Maintenance run ${row.run_key} has an unknown trigger or status.`);
  }
  return {
    runKey: row.run_key,
    trigger,
    slot: row.slot,
    scheduledTime: ms(row.scheduled_time),
    status,
    cutoffAt: ms(row.cutoff_at),
    startedAt: row.started_at * 1000,
    completedAt: ms(row.completed_at),
    expiredSessions: row.expired_sessions,
    idleRateLimits: row.idle_rate_limits,
    artifactsQueued: row.artifacts_queued,
    artifactsRetired: row.artifacts_retired,
    pendingDispatches: row.pending_dispatches,
    errorCode: row.error_code as MaintenanceFailureCode | null,
  };
};

const BEGIN_SQL = `
INSERT INTO maintenance_runs (run_key, trigger, slot, scheduled_time, status, cutoff_at, started_at)
VALUES (?, ?, ?, ?, 'running', ?, ?)
ON CONFLICT (run_key) DO NOTHING
`;

export const createMaintenanceRunRepository = (
  db: JobsDatabase,
  clock: Clock,
): MaintenanceRunRepository => {
  const read = async (runKey: string): Promise<MaintenanceRun> => {
    const row = await db
      .prepare(`SELECT ${RUN_COLUMNS} FROM maintenance_runs WHERE run_key = ?`)
      .bind(runKey)
      .first<RunRow>();
    if (row === null) {
      throw new Error(`Maintenance run ${runKey} was claimed but could not be read back.`);
    }
    return toRun(row);
  };

  return {
    async begin(request, cutoffAtMs) {
      const described = describeRunRequest(request);
      const nowMs = clock.now();
      const nowSec = Math.floor(nowMs / 1000);

      const { meta } = await db
        .prepare(BEGIN_SQL)
        .bind(
          described.runKey,
          request.trigger,
          described.slot,
          described.scheduledTime === null ? null : Math.floor(described.scheduledTime / 1000),
          Math.floor(cutoffAtMs / 1000),
          nowSec,
        )
        .run();

      if (meta.changes === 1) {
        return { ok: true, run: await read(described.runKey), tookOver: false };
      }

      // The row exists. Two reasons, and they need opposite answers: a finished
      // run means this slot is done and must not sweep again, while a *running*
      // row means either a concurrent sweep (refuse) or a crashed one (take over
      // once it is stale). Only the age separates the two.
      const existing = await read(described.runKey);
      if (existing.status !== 'running') {
        return { ok: false, reason: 'already_finished', run: existing };
      }
      if (nowMs - existing.startedAt < MAINTENANCE_RUN_TAKEOVER_MS) {
        return { ok: false, reason: 'in_progress', run: existing };
      }

      const { meta: takeover } = await db
        .prepare(
          `UPDATE maintenance_runs
           SET cutoff_at = ?, started_at = ?, completed_at = NULL, error_code = NULL,
               expired_sessions = 0, idle_rate_limits = 0, artifacts_queued = 0,
               artifacts_retired = 0, pending_dispatches = 0
           WHERE run_key = ? AND status = 'running'`,
        )
        .bind(Math.floor(cutoffAtMs / 1000), nowSec, described.runKey)
        .run();
      if (takeover.changes !== 1) {
        // Another invocation took it over between the read and this write. Its
        // answer is the truthful one, so it is re-read and reported.
        return { ok: false, reason: 'in_progress', run: await read(described.runKey) };
      }
      return { ok: true, run: await read(described.runKey), tookOver: true };
    },

    async complete(runKey, report) {
      const { meta } = await db
        .prepare(
          `UPDATE maintenance_runs
           SET status = 'succeeded', cutoff_at = ?, completed_at = ?, error_code = NULL,
               expired_sessions = ?, idle_rate_limits = ?, artifacts_queued = ?,
               artifacts_retired = ?, pending_dispatches = ?
           WHERE run_key = ? AND status = 'running'`,
        )
        .bind(
          Math.floor(report.cutoffAt / 1000),
          Math.floor(clock.now() / 1000),
          report.expiredSessions,
          report.idleRateLimits,
          report.artifactsQueued,
          report.artifactsRetired,
          report.pendingDispatches,
          runKey,
        )
        .run();
      return meta.changes === 1;
    },

    async fail(runKey, code) {
      const { meta } = await db
        .prepare(
          `UPDATE maintenance_runs
           SET status = 'failed', completed_at = ?, error_code = ?
           WHERE run_key = ? AND status = 'running'`,
        )
        .bind(Math.floor(clock.now() / 1000), code, runKey)
        .run();
      return meta.changes === 1;
    },

    async get(runKey) {
      const row = await db
        .prepare(`SELECT ${RUN_COLUMNS} FROM maintenance_runs WHERE run_key = ?`)
        .bind(runKey)
        .first<RunRow>();
      return row === null ? null : toRun(row);
    },

    async list(limit) {
      const bounded = Math.min(Math.max(Math.floor(limit), 1), 100);
      const { results } = await db
        .prepare(
          `SELECT ${RUN_COLUMNS} FROM maintenance_runs ORDER BY started_at DESC, run_key DESC LIMIT ?`,
        )
        .bind(bounded)
        .all<RunRow>();
      return results.map(toRun);
    },
  };
};
