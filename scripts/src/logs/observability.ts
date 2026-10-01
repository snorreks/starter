// scripts/src/logs/observability.ts
//
// The Workers Observability query request, as the API actually accepts it.
//
// Contract verified 2026-10-01 against
//   POST /accounts/{account_id}/workers/observability/telemetry/query
//   https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query
// and recorded in docs/cloudflare.md so it is not re-derived from memory.
//
// Why this module exists at all: the adapter used to build a single free-text
// `filter` string, the shape Logpush uses —
//
//   timestamp >= "2026-01-01T00:00:00.000Z" AND level >= "ERROR"
//
// The Observability query endpoint has no such field. It takes *structured*
// filter objects:
//
//   { key, operation, type, value }
//
// under `parameters.filters`, with `filterCombination` deciding how they join.
// So the old translation either produced a 400 or — worse — had its narrowing
// ignored and returned every event in the timeframe while the caller reported a
// filtered count. It was covered by tests, and those tests passed, because they
// asserted the string shape. A test that pins the wrong contract is worse than no
// test: it reads as evidence the code is right.
//
// The two failure modes are separated here on purpose. `buildObservabilityRequest`
// decides *what to ask for* and is pure, so it can be asserted without a
// credential. `queryObservability` does the request, and is the only part that
// needs a network.

import type { LogQuery } from './types.ts';

/** One filter clause, as the endpoint's leaf filter takes it. */
export interface ObservabilityFilter {
  key: string;
  operation: string;
  type: 'string' | 'number' | 'boolean';
  value?: string | number | boolean;
}

/** A filter group, for nesting. Max depth 4 per the API; this builds depth 1. */
export interface ObservabilityGroup {
  kind: 'group';
  filterCombination: 'and' | 'or';
  filters: ObservabilityFilter[];
}

export interface ObservabilityRequest {
  /** Ad-hoc id. The API requires one; any identifier will do. */
  queryId: string;
  /** Unix milliseconds. Required, and `from` must be earlier than `to`. */
  timeframe: { from: number; to: number };
  view: 'events';
  /** Capped at 2000 by the provider. */
  limit: number;
  /** The worker script to read. Empty string means "all datasets". */
  datasets: string[];
  parameters: {
    filterCombination: 'and';
    filters: ObservabilityFilter[];
  };
}

/** The provider's cap, not ours: asking for more returns a 400. */
export const MAX_PROVIDER_LIMIT = 2000;

/** Default when `--limit` is absent. Matches the CLI's own default. */
export const DEFAULT_LIMIT = 50;

/**
 * Severity ordering, shared with the local predicate.
 *
 * `NONE` is a valid `LogLevel` meaning "log nothing" and is not a severity, so
 * it ranks as the most severe here — a stray `NONE` event is not something
 * `--level error` should drop.
 */
const LEVEL_RANK: Record<string, number> = { DEBUG: 1, INFO: 2, WARNING: 3, ERROR: 4, NONE: 4 };

const threshold = (level: string | undefined): string => {
  const upper = level?.toUpperCase() ?? 'DEBUG';
  return LEVEL_RANK[upper] === undefined ? 'DEBUG' : upper;
};

/** The lowest severity a filter should admit, or null for "everything". */
export const levelFloor = (level: string | undefined): string | null => {
  const wanted = threshold(level);
  return LEVEL_RANK[wanted] <= 1 ? null : wanted;
};

/**
 * Build the request body.
 *
 * Two things the old string translation got wrong, both of which are structural
 * rather than cosmetic:
 *
 * 1. **Severity is an `in` set, not a `>=` comparison.** The provider orders no
 *    levels, so `level >= "WARNING"` is not a meaningful expression for it. The
 *    levels at or above the threshold are enumerated instead.
 * 2. **Values are typed.** `type` must match the indexed field's type, so a
 *    numeric comparison is declared `number` and a string one `string`. Sending a
 *    string for a numeric field is a 400, not a coercion.
 *
 * The window is `timeframe`, not a filter clause: the API takes it separately,
 * and there is no timestamp filter key to compare against.
 */
export const buildObservabilityRequest = (
  query: LogQuery,
  window: { from: number; to: number },
  worker: string | null,
): ObservabilityRequest => {
  const filters: ObservabilityFilter[] = [];

  const floor = levelFloor(query.level);
  if (floor !== null) {
    const admitted = Object.entries(LEVEL_RANK)
      .filter(([, rank]) => rank >= LEVEL_RANK[floor])
      .map(([name]) => name);

    // `in` takes a comma-separated list; the value is still typed as a string
    // because that is the indexed field's type.
    filters.push({
      key: 'level',
      operation: 'in',
      type: 'string',
      value: admitted.join(','),
    });
  }

  if (query.source !== undefined) {
    filters.push({ key: 'source', operation: 'eq', type: 'string', value: query.source });
  }

  if (query.trace !== undefined) {
    // Structured values need no quoting, so the injection the string form was
    // vulnerable to — a `"` in `--trace` closing the clause and appending
    // arbitrary filter text — has no analogue here. The value crosses the wire as
    // JSON data rather than as a fragment of an expression.
    filters.push({ key: 'traceId', operation: 'eq', type: 'string', value: query.trace });
  }

  if (query.uid !== undefined) {
    // The *server-verified* id. A browser-forwarded event carries the user's
    // self-assertion under `clientReported`, and matching on that would let a
    // client choose whose history it appears in.
    filters.push({ key: 'userId', operation: 'eq', type: 'string', value: query.uid });
  }

  const requested = query.limit ?? DEFAULT_LIMIT;

  return {
    queryId: 'adhoc-starter-logs',
    timeframe: window,
    view: 'events',
    // Clamped rather than trusted: `--limit 99999` must not become a 400, and a
    // bounded read is the contract this repository keeps.
    limit: Math.min(Math.max(1, requested), MAX_PROVIDER_LIMIT),
    datasets: worker === null ? [] : [worker],
    parameters: { filterCombination: 'and', filters },
  };
};
