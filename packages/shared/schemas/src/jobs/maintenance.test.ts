// packages/shared/schemas/src/jobs/maintenance.test.ts
//
// The refusals that keep a maintenance run from becoming an unvalidated surface.
//
// A scheduler run is the one piece of jobs state a client can read *without owning
// anything*, so its DTO is the one most likely to grow a field by accident: a new
// column added for the run log is exactly the shape that "the schema allows extra
// properties" would silently publish to every browser.

import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { LatestMaintenanceSchema, MaintenanceEvidenceSchema } from './maintenance.ts';

// The literal rather than `@starter/jobs`'s `MAINTENANCE_CRON`: this package is
// the portable contract and must not reach a server-only package to assert
// something. The schedule string is what the Worker is configured with, and the
// DTO carries it as an opaque field for exactly that reason.
const SCHEDULE = '17 * * * *';

const scheduledRun = () => ({
  trigger: 'scheduled' as const,
  status: 'succeeded' as const,
  slot: '2026-10-03T17:00:00Z',
  scheduledTime: 1_772_573_400_000,
  startedAt: 1_772_573_402_000,
  completedAt: 1_772_573_405_000,
  counts: {
    expiredSessions: 12,
    idleRateLimits: 4,
    artifactsQueued: 1,
    artifactsRetired: 3,
    pendingDispatches: 0,
  },
  errorCode: null,
});

describe('MaintenanceEvidenceSchema', () => {
  test('accepts a completed scheduled run', () => {
    expect(Value.Check(MaintenanceEvidenceSchema, scheduledRun())).toBe(true);
  });

  test('accepts a run that is still running, with nothing completed and no code', () => {
    const running = {
      ...scheduledRun(),
      status: 'running' as const,
      completedAt: null,
    };
    expect(Value.Check(MaintenanceEvidenceSchema, running)).toBe(true);
  });

  test('refuses a trigger outside the two that exist', () => {
    // A third trigger would be either a scheduler nobody configured or a
    // mislabelled manual run, and both are claims about evidence rather than
    // facts a client should render as one.
    expect(Value.Check(MaintenanceEvidenceSchema, { ...scheduledRun(), trigger: 'cron' })).toBe(
      false,
    );
  });

  test('refuses an unbounded failure message in place of a code', () => {
    // The stored error is a closed union. An exception's message here would be
    // provider output reaching a browser.
    expect(
      Value.Check(MaintenanceEvidenceSchema, {
        ...scheduledRun(),
        status: 'failed',
        errorCode: 'D1_ERROR: no such table: sessions',
      }),
    ).toBe(false);
  });

  test('refuses a negative count', () => {
    // Counts are row counts for writes that happened. A negative one is not a
    // number any of this repository's statements can report, so a DTO that
    // accepted it would let a subtraction bug look like a result.
    expect(
      Value.Check(MaintenanceEvidenceSchema, {
        ...scheduledRun(),
        counts: { ...scheduledRun().counts, artifactsRetired: -1 },
      }),
    ).toBe(false);
  });

  test('refuses the run key, which embeds a request id for manual runs', () => {
    expect(
      Value.Check(MaintenanceEvidenceSchema, { ...scheduledRun(), runKey: 'manual:req_7' }),
    ).toBe(false);
  });
});

describe('LatestMaintenanceSchema', () => {
  const latest = () => ({
    schedule: SCHEDULE,
    latest: scheduledRun(),
    latestScheduled: scheduledRun(),
    serverTime: 1_772_573_406_000,
  });

  test('accepts a deployment with a scheduled run on record', () => {
    expect(Value.Check(LatestMaintenanceSchema, latest())).toBe(true);
  });

  test('accepts a deployment that has never run maintenance', () => {
    // The case the design asks for by name: "nothing has run yet" and "the last
    // run failed" are different statements, and only one of them is a defect.
    expect(
      Value.Check(LatestMaintenanceSchema, {
        schedule: null,
        latest: null,
        latestScheduled: null,
        serverTime: 1,
      }),
    ).toBe(true);
  });

  test('refuses a claim of progress without a numeric bound', () => {
    // There is no `progress` field and there must never be one: a run reports
    // what it deleted after the fact, never a percentage of a sweep in flight.
    expect(Value.Check(LatestMaintenanceSchema, { ...latest(), progress: 42 })).toBe(false);
  });
});
