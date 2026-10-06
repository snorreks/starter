// packages/shared/schemas/src/jobs/maintenance.ts
//
// What a client may read about the maintenance schedule.
//
// Why a maintenance run is on a jobs screen at all
// -----------------------------------------------
// A scheduler is a promise, and the only honest evidence for a promise is a record
// with a trigger on it. This repository's sweep is destructive — it deletes expired
// sessions, idle rate-limit windows and stored artifacts — and its run table
// distinguishes `scheduled:<epochMs>` from `manual:<requestId>` precisely so that
// "the schedule fired" and "somebody pressed the button" cannot be confused. A UI
// that showed a last-run timestamp without the trigger would collapse that
// distinction and report a manual run as a natural firing, which is the exact
// dishonesty the design calls out for the demo.
//
// So this DTO carries the trigger, the slot, the provider's `scheduledTime`, the
// three statuses and the counts the sweep really deleted. Every number is a row
// count a statement reported; there is no "estimated" field and no percentage.
//
// What is deliberately absent: `cutoffAt` (an operator detail), the run key (which
// embeds a request id for manual runs), and any provider identifier. A closed
// object, for the same reason `JobDtoSchema` is closed: an open schema here would
// let a future column become a browser contract by accident.

import { type Static, Type } from 'typebox';
import { literalUnion } from './job.ts';

/** The two things that can start a run. Mirrors the repository's union. */
export const MAINTENANCE_TRIGGERS = ['scheduled', 'manual'] as const;
export const MaintenanceTriggerSchema = literalUnion(MAINTENANCE_TRIGGERS);
export type MaintenanceTrigger = Static<typeof MaintenanceTriggerSchema>;

export const MAINTENANCE_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export const MaintenanceRunStatusSchema = literalUnion(MAINTENANCE_RUN_STATUSES);
export type MaintenanceRunStatus = Static<typeof MaintenanceRunStatusSchema>;

/**
 * What one sweep deleted, as the numbers the database reported.
 *
 * A flat set of non-negative integers rather than one "items removed" field: the
 * counts differ in meaning (sessions are credentials, artifacts are stored bytes)
 * and a sum of them would be a number nobody could act on.
 */
export const MaintenanceCountsSchema = Type.Object(
  {
    expiredSessions: Type.Integer({ minimum: 0 }),
    idleRateLimits: Type.Integer({ minimum: 0 }),
    artifactsQueued: Type.Integer({ minimum: 0 }),
    artifactsRetired: Type.Integer({ minimum: 0 }),
    pendingDispatches: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type MaintenanceCounts = Static<typeof MaintenanceCountsSchema>;

/**
 * The most recent maintenance run this environment recorded.
 *
 * `null` for "nothing has ever run" is a *different* statement from "a run
 * failed": an empty deployment has not proved its schedule is broken. The field is
 * nullable for the same reason `JobOutputSchema.expiresAt` is meaningful while the
 * bytes are gone — availability, not existence.
 */
export const MaintenanceEvidenceSchema = Type.Object(
  {
    trigger: MaintenanceTriggerSchema,
    status: MaintenanceRunStatusSchema,
    /** `2026-10-03T17:00:00Z` for a scheduled run. Null for a manual one. */
    slot: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]),
    /**
     * The provider's `scheduledTime`, epoch ms. Null for a manual run, and null
     * for a scheduled run that is still `running` if the row has none.
     */
    scheduledTime: Type.Union([Type.Number(), Type.Null()]),
    startedAt: Type.Number(),
    completedAt: Type.Union([Type.Number(), Type.Null()]),
    counts: MaintenanceCountsSchema,
    /** A frozen code, or null. Never an exception message. */
    errorCode: Type.Union([
      Type.Union([
        Type.Literal('sweep_failed'),
        Type.Literal('dispatch_recovery_failed'),
        Type.Literal('internal_error'),
      ]),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export type MaintenanceEvidence = Static<typeof MaintenanceEvidenceSchema>;

/**
 * The latest run, or null when none exists.
 *
 * A wrapper rather than a bare nullable field on the job list, because "what is
 * the scheduler evidence" is one question with one answer and it does not change
 * per job. `hasRun` is a separate boolean so a client never has to distinguish
 * `undefined` from `null` to learn whether it may render an empty state.
 */
export const LatestMaintenanceSchema = Type.Object(
  {
    /** The cron this deployment is configured with, or null when unconfigured. */
    schedule: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    /** The most recent run of any trigger. Null when nothing has ever run. */
    latest: Type.Union([MaintenanceEvidenceSchema, Type.Null()]),
    /** The most recent *scheduled* run. Null when the schedule has not fired. */
    latestScheduled: Type.Union([MaintenanceEvidenceSchema, Type.Null()]),
    serverTime: Type.Number(),
  },
  { additionalProperties: false },
);

export type LatestMaintenance = Static<typeof LatestMaintenanceSchema>;
