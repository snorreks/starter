// packages/backend/jobs/src/lib/maintenance.ts
//
// Bounded maintenance, reusable by whichever Worker runs the schedule.
//
// Four services, each with the same shape: a caller supplies a *fixed* cutoff and
// a batch size, the service returns the number of rows it actually affected, and
// nothing in here ever selects a list it does not need.
//
// The rule this file exists to enforce
// -----------------------------------
// The previous `purgeExpiredSessions` read every expired session id into memory
// and then deleted with a *second* `new Date()`, reporting the count of the
// first query. Three defects in six lines:
//
//   * the read is unbounded — on a database with a million expired sessions it
//     holds a million strings to delete at most `LIMIT` of them;
//   * the cutoff moves between the two statements, so the reported count and the
//     deleted set are different sets;
//   * the count is of rows *selected*, not rows *deleted*, so a run that deleted
//     nothing could still report work done.
//
// So every service here takes its cutoff as an argument, does one bounded
// `DELETE … WHERE id IN (SELECT id … LIMIT n)`, and reports D1's own
// `meta.changes`. The count is the number of rows the database says it removed.
//
// Why `id IN (SELECT … LIMIT n)` rather than `DELETE … LIMIT n`
// --------------------------------------------------------
// `DELETE … LIMIT` needs a SQLite build compiled with
// `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`. D1's is not, and a migration or deploy
// built on that assumption fails at runtime with "near LIMIT: syntax error". The
// subquery form is portable and bounded by the same number.

import type { Clock } from './job_repository.ts';

// Re-exported so a caller of this module can supply a clock without importing the
// repository as well. One definition, two importers, no chance of drift.
export type { Clock };

/** One affected-row count, per table, from a single run. */
export interface MaintenanceReport {
  /** A slot id: the UTC hour for a schedule, or whatever the caller names it. */
  runKey: string;
  /** Epoch ms the cutoffs were taken from. One value for the whole run. */
  cutoffAt: number;
  /** Rows actually removed. From `meta.changes`, never from a prior count. */
  expiredSessions: number;
  /** Rows actually removed from the fixed-window rate limiter. */
  idleRateLimits: number;
  /** Artifacts queued for byte deletion. */
  artifactsQueued: number;
  /** Retirement rows whose bytes were confirmed removed. */
  artifactsRetired: number;
  /** Jobs still owing a dispatch. */
  pendingDispatches: number;
}

/** Ceiling on any one batch. 100, because that is what the design froze. */
export const MAX_MAINTENANCE_BATCH = 100;

/** The default batch when a caller passes nothing sensible. */
export const DEFAULT_MAINTENANCE_BATCH = 100;

/** How long an idle auth rate-limit window is kept before it is dropped. */
export const DEFAULT_RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** How long an expired session is kept before it is dropped. */
export const DEFAULT_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface MaintenanceDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta: { changes: number } }>;
      first<T = unknown>(columnName?: string): Promise<T | null>;
    };
  };
}

const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

const clampBatch = (batch: number | undefined): number => {
  if (batch === undefined || !Number.isFinite(batch)) {
    return DEFAULT_MAINTENANCE_BATCH;
  }
  return Math.min(Math.max(Math.floor(batch), 1), MAX_MAINTENANCE_BATCH);
};

/** How many sessions this run may delete. Never more than one batch. */
export interface PurgeExpiredSessionsOptions {
  /** Epoch ms. A *fixed* instant: one value for the delete and the report. */
  cutoffMs: number;
  batch?: number;
}

/**
 * Delete expired sessions, bounded, and report what was deleted.
 *
 * The cutoff is a parameter, not `new Date()` at the call site, for two reasons:
 * the report has to describe the same instant the delete used, and a test has to
 * be able to place an expired session without waiting for one to expire.
 */
export const purgeExpiredSessions = async (
  db: MaintenanceDatabase,
  options: PurgeExpiredSessionsOptions,
): Promise<number> => {
  const { meta } = await db
    .prepare(
      `DELETE FROM sessions WHERE id IN (
         SELECT id FROM sessions WHERE expires_at < ? ORDER BY expires_at ASC LIMIT ?
       )`,
    )
    .bind(toEpochSeconds(options.cutoffMs), clampBatch(options.batch))
    .run();
  return meta.changes;
};

/** How long a rate-limit window nobody is using any more is kept. */
export interface PurgeIdleRateLimitsOptions {
  cutoffMs: number;
  batch?: number;
}

/**
 * Delete auth rate-limit windows whose last request is older than the cutoff.
 *
 * Bounded and reported the same way. `last_request` is an index-friendly integer
 * (see `d1_rate_limit.ts`), so the inner `SELECT` is a range scan that stops after
 * `LIMIT` rows — it does not walk the whole table to find the oldest ones.
 */
export const purgeIdleRateLimits = async (
  db: MaintenanceDatabase,
  options: PurgeIdleRateLimitsOptions,
): Promise<number> => {
  const { meta } = await db
    .prepare(
      `DELETE FROM rate_limits WHERE key IN (
         SELECT key FROM rate_limits WHERE last_request < ? ORDER BY last_request ASC LIMIT ?
       )`,
    )
    .bind(options.cutoffMs, clampBatch(options.batch))
    .run();
  return meta.changes;
};

/**
 * The private artifact store, as maintenance needs to see it.
 *
 * Two operations, and only two, because those are the only two questions a sweep
 * can ask about bytes it does not hold: are they still there, and are they gone.
 * Whether this is R2, a Durable Object, or a fixture in a unit test is PR H's
 * business — this repository states the question, not the provider.
 */
export interface JobArtifactStorage {
  /** True only when the object is genuinely absent. Must not be optimistic. */
  isRemoved(outputKey: string): Promise<boolean>;
}

/**
 * What the artifact sweep needs from the job repository.
 *
 * The bytes live in private storage that D1 cannot reach, so the sweep is a
 * three-step dance: find the expired jobs, queue them, delete the bytes, then clear
 * the row. Keeping that in an interface rather than importing the repository means
 * the maintenance run can be tested against a recorder, and it means the storage
 * owner (PR H's jobs Worker) does not have to import the web application to run it.
 */
export interface ArtifactSweepRepository {
  listExpiredArtifacts(
    cutoffMs: number,
    limit: number,
  ): Promise<Array<{ id: string; outputKey: string | null }>>;
  enqueueArtifactRetirement(jobId: string, cutoffMs: number): Promise<boolean>;
  listArtifactRetirements(limit: number): Promise<Array<{ jobId: string; outputKey: string }>>;
  completeArtifactRetirement(jobId: string): Promise<boolean>;
  recordArtifactRetirementRetry(jobId: string): Promise<boolean>;
  clearJobOutput(jobId: string): Promise<boolean>;
}

export interface PurgeExpiredArtifactsOptions {
  cutoffMs: number;
  batch?: number;
}

export interface ArtifactSweepReport {
  /** Newly queued for byte deletion. */
  queued: number;
  /**
   * Retirements whose bytes the storage owner confirmed absent, and whose row was
   * therefore closed and whose job's output columns were cleared.
   *
   * A non-zero value is the *only* thing in this file that may claim bytes were
   * removed, and it is gated on `isRemoved` answering yes.
   */
  retired: number;
  /**
   * Retirements still outstanding, including the ones this run queued.
   *
   * A non-zero value is not a failure — it is the honest statement that the byte
   * deletion has not happened yet. Collapsing `queued` and `retired` into one
   * "deleted N" number would claim bytes were removed when only rows were written.
   */
  outstanding: number;
}

/**
 * Queue expired artifacts for deletion and close out the ones already gone.
 *
 * Deleting the bytes is the storage owner's operation, and this function does not
 * perform it: it asks `JobArtifactStorage.isRemoved` and closes a retirement only
 * when the answer is yes. That is the difference between a maintenance run that
 * reports deletions and one that reports row writes.
 *
 * A failed or absent byte-deletion therefore leaves a recoverable row rather than a
 * job whose artifact silently vanished from the database while the object stayed in
 * the bucket forever — and the next run picks the same row up again.
 */
export const purgeExpiredArtifacts = async (
  repository: ArtifactSweepRepository,
  storage: JobArtifactStorage,
  options: PurgeExpiredArtifactsOptions,
): Promise<ArtifactSweepReport> => {
  const limit = clampBatch(options.batch);
  const expired = await repository.listExpiredArtifacts(options.cutoffMs, limit);

  let queued = 0;
  for (const job of expired) {
    if (await repository.enqueueArtifactRetirement(job.id, options.cutoffMs)) {
      queued += 1;
    }
  }

  const retirements = await repository.listArtifactRetirements(limit);
  let retired = 0;
  for (const retirement of retirements) {
    if (!(await storage.isRemoved(retirement.outputKey))) {
      await repository.recordArtifactRetirementRetry(retirement.jobId);
      continue;
    }
    // Both steps, and both reported: closing the retirement without clearing the
    // job would leave a job claiming an artifact that no longer exists.
    if (!(await repository.completeArtifactRetirement(retirement.jobId))) {
      continue;
    }
    if (await repository.clearJobOutput(retirement.jobId)) {
      retired += 1;
    }
  }

  const remaining = await repository.listArtifactRetirements(limit);
  return { queued, retired, outstanding: remaining.length };
};

/** How many admitted jobs are still owed a Workflow dispatch. */
export interface PendingDispatchRepository {
  listPendingDispatches(limit: number): Promise<unknown[]>;
  failStaleJobs(cutoffMs: number, limit: number): Promise<number>;
}

export interface MaintenanceOptions {
  /** One value for the whole run. Every cutoff below is derived from it. */
  runKey: string;
  batch?: number;
  sessionRetentionMs?: number;
  rateLimitRetentionMs?: number;
  /** Maximum age since a failed dispatch; defaults to one hour. */
  dispatchRetentionMs?: number;
}

/**
 * One bounded maintenance run.
 *
 * `cutoffAt` is taken from the injected clock *once* and every cutoff is derived
 * from that single value, so a run that straddles a second boundary cannot
 * delete with one instant and report another.
 *
 * Ownership note: PR H owns the *schedule* and the jobs Worker that runs it. This
 * function is the reusable part and takes its collaborators as arguments, so
 * neither has to import the other.
 */
export const runMaintenance = async (
  database: MaintenanceDatabase,
  repository: ArtifactSweepRepository & PendingDispatchRepository,
  storage: JobArtifactStorage,
  clock: Clock,
  options: MaintenanceOptions,
): Promise<MaintenanceReport> => {
  const cutoffAt = clock.now();
  const batch = clampBatch(options.batch);

  const expiredSessions = await purgeExpiredSessions(database, {
    cutoffMs: cutoffAt - (options.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS),
    batch,
  });
  const idleRateLimits = await purgeIdleRateLimits(database, {
    cutoffMs: cutoffAt - (options.rateLimitRetentionMs ?? DEFAULT_RATE_LIMIT_RETENTION_MS),
    batch,
  });
  const artifacts = await purgeExpiredArtifacts(repository, storage, { cutoffMs: cutoffAt, batch });
  await repository.failStaleJobs(cutoffAt - (options.dispatchRetentionMs ?? 60 * 60 * 1000), batch);
  const pendingDispatches = (await repository.listPendingDispatches(batch)).length;

  return {
    runKey: options.runKey,
    cutoffAt,
    expiredSessions,
    idleRateLimits,
    artifactsQueued: artifacts.queued,
    artifactsRetired: artifacts.retired,
    pendingDispatches,
  };
};
