// scripts/src/logs/types.ts
//
// Shared types for the log query family.
//
// Split from the adapters so that a capability test can assert on the contract
// without booting a provider, and so the CLI can be reasoned about separately
// from the transport.

import type {
  DeploymentEnvironment,
  LogEvent,
  LogQueryResult,
  LogSource,
} from '@starter/schemas/logging';
import type { AppId, LogAdapterCapabilities, LogAdapterKind } from '../registry/app_registry.ts';

/**
 * A *threshold*, not a project level.
 *
 * `NONE` is a valid `LogLevel` (it means "log nothing") but it is not a filter
 * threshold, so it is not accepted here. Keeping the two apart stops a caller
 * from passing `NONE` and getting an empty result that looks like a working
 * filter.
 */
export type QueryLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

export type { AppId, DeploymentEnvironment, LogAdapterCapabilities, LogAdapterKind };

/** Everything a query can be narrowed by. All fields are optional. */
export interface LogQuery {
  app: AppId;
  mode: DeploymentEnvironment;
  /** Select one local run's isolated log directory. */
  runId?: string;
  /** Minimum severity. `DEBUG` includes everything. */
  level?: QueryLevel;
  /** Restrict to events originating from this source. */
  source?: LogSource;
  /** Correlate to a single request/trace. */
  trace?: string;
  /**
   * User id. Only available where the adapter declares `userIdFilter`, and
   * only meaningful against a *server-verified* id — see the note in
   * `cloudflare_logpush.ts`.
   */
  uid?: string;
  /** How far back to look, e.g. `30m`, `2h`, `7d`. */
  since?: string;
  /** Maximum events to return. Always applied, never unbounded. */
  limit?: number;
  /** Follow a live tail instead of a historical read. */
  follow?: boolean;
  /** Stop following after this long, e.g. `60s`. Required in practice. */
  duration?: string;
  /**
   * The follow session's budget in milliseconds, already parsed and clamped.
   *
   * A number rather than the `duration` string because the adapter enforces the
   * bound itself: the caller does not get to decide whether `--follow` is
   * unbounded.
   */
  followBudgetMs?: number;
  /** Emit machine-readable JSON. */
  json?: boolean;
}

export type { LogEvent, LogQueryResult };

/** Parsed duration in milliseconds. */
export interface ParsedDuration {
  ms: number;
  label: string;
}

/** One line of CLI help, so `--help` cannot drift from the implementation. */
export interface FlagDoc {
  flag: string;
  /** Value placeholder. Empty for a boolean flag. */
  arg: string;
  description: string;
  /** Which adapters honour it. Empty means all. */
  adapters?: readonly LogAdapterKind[];
}
