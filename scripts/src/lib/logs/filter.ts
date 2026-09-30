// scripts/src/lib/logs/filter.ts
//
// Query -> adapter-agnostic predicate.
//
// This is where "apply the filter correctly in the adapter" actually happens.
// The providers do their own server-side narrowing where they can (a Logpush
// filter string, a local file scan); this predicate is the shared, tested
// fallback that both must agree with.
//
// Every filter is applied, and every filter the adapters cannot honour is
// reported as `capability_unsupported` *before* any provider call — so an
// unsupported flag never degrades into a silent full-dump.

import type { LogEvent, LogQuery } from './types.ts';
import { parseDuration } from './duration.ts';

/** Field name carrying the forwarded client context, per TelemetryPayload. */
const CLIENT_REPORTED_USER = 'clientReported.userId';

/** `NONE` is a valid project level but not a filter threshold; it means ERROR. */
const toThreshold = (level: string | undefined): 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' => {
  switch (level?.toUpperCase()) {
    case 'NONE':
      return 'ERROR';
    case 'INFO':
    case 'WARNING':
    case 'ERROR':
      return level.toUpperCase() as 'INFO' | 'WARNING' | 'ERROR';
    default:
      return 'DEBUG';
  }
};

export type FilterDecision =
  | { ok: true; predicate: (event: LogEvent) => boolean; since: number | undefined }
  | { ok: false; unsupported: string };

/** Does this event carry a *server-verified* user id? */
const hasVerifiedUserId = (event: LogEvent): boolean =>
  typeof event.userId === 'string' && event.userId.length > 0;

const LEVEL_RANK = { DEBUG: 1, INFO: 2, WARNING: 3, ERROR: 4 } as const;

/**
 * Build the predicate, and reject any filter the caller cannot honour.
 *
 * `capabilities` is the adapter's declared capability set from the app registry.
 */
export const buildFilter = (
  query: LogQuery,
  capabilities: { userIdFilter: boolean; traceIdFilter: boolean },
): FilterDecision => {
  if (query.uid !== undefined && !capabilities.userIdFilter) {
    return {
      ok: false,
      unsupported:
        'This adapter cannot filter by user id. `wrangler tail` is a live event ' +
        'stream with no index, so it cannot filter by any field. Use ' +
        '`--mode local` or an environment with Logpush enabled.',
    };
  }

  if (query.trace !== undefined && !capabilities.traceIdFilter) {
    return {
      ok: false,
      unsupported: 'This adapter cannot filter by trace id.',
    };
  }

  const since = query.since === undefined ? undefined : parseDuration(query.since)?.ms;
  if (query.since !== undefined && since === undefined) {
    return { ok: false, unsupported: `Could not parse --since "${query.since}".` };
  }

  const minimumRank = LEVEL_RANK[toThreshold(query.level)];

  const predicate = (event: LogEvent): boolean => {
    if (since !== undefined && event.timestamp < Date.now() - since) {
      return false;
    }
    // `LogEvent.level` is the full `LogLevel` union, which includes `NONE`.
    // `NONE` is not a severity, so it ranks as the most severe: a stray
    // `NONE` event is not something a `--level error` filter should drop.
    if (LEVEL_RANK[toThreshold(event.level)] < minimumRank) {
      return false;
    }
    if (query.source !== undefined && event.source !== query.source) {
      return false;
    }
    if (query.trace !== undefined && event.traceId !== query.trace) {
      return false;
    }
    if (query.uid !== undefined) {
      // Only a server-verified id counts. A browser-forwarded event carries the
      // user's self-assertion under `clientReported`; matching on it would let a
      // client choose whose history it appears in.
      if (!hasVerifiedUserId(event) || event.userId !== query.uid) {
        return false;
      }
    }
    return true;
  };

  return { ok: true, predicate, since };
};

/**
 * Build the Cloudflare Logpush filter fragment for the fields the provider
 * indexes.
 *
 * Returned separately from the predicate so a provider query and the local scan
 * can share the same semantics. Returns `null` when the query needs no
 * server-side narrowing.
 */
export const buildLogpushFilter = (
  query: LogQuery,
  since: number | undefined,
): string | null => {
  const clauses: string[] = [];

  if (since !== undefined) {
    // Logpush timestamps arrive as `_time` in nanoseconds.
    clauses.push(`_time >= "${new Date(Date.now() - since).toISOString()}"`);
  }
  if (query.level !== undefined && query.level !== 'DEBUG') {
    clauses.push(`jsonPayload.level >= "${query.level}"`);
  }
  if (query.source !== undefined) {
    clauses.push(`jsonPayload.source = "${query.source}"`);
  }
  if (query.trace !== undefined) {
    clauses.push(`jsonPayload.traceId = "${query.trace}"`);
  }
  if (query.uid !== undefined) {
    clauses.push(`jsonPayload.userId = "${query.uid}"`);
  }

  return clauses.length === 0 ? null : clauses.join(' AND ');
};

export { CLIENT_REPORTED_USER };
