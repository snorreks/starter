// scripts/src/logs/cloudflare_adapter.ts
//
// Cloudflare Workers log access: a historical query and a bounded live tail.
//
// **The historical adapter is still a stub.** `queryCloudflareHistory` validates
// configuration and then returns `retrieval_failed` without sending a provider
// request. Nothing in this repository should be read as evidence that Cloudflare
// log querying works. Replacing it with real Workers Observability REST calls —
// with response validation, pagination, output bounds and error mapping — is
// phase 3's scope, along with keeping Logpush separate as an optional capability.
//
// What *is* real and tested here: the request translation (`buildHistoricalRequest`)
// and the live tail's process lifecycle. Both are exercisable without a credential,
// and a translation bug is exactly the bug that would otherwise only surface
// against a production account.

import { streamWrangler } from '../cloudflare/wrangler.ts';
import { buildFilter, buildObservabilityQuery, type ObservabilityQuery } from './filter.ts';
import { APP_LOG_CONFIG, capabilitiesFor, prerequisiteFor, resolveLogAdapter } from './registry.ts';
import type { LogEvent, LogQuery, LogQueryResult } from './types.ts';

/** Upper bound on a single tail session, so `--follow` cannot run unbounded. */
export const MAX_TAIL_MS = 15 * 60_000;

/** Default tail budget when `--follow` is given without a duration. */
export const DEFAULT_TAIL_MS = 60_000;

/**
 * The provider request this query would send.
 *
 * Exported so the translation can be asserted without a credential. This is the
 * part that must be right for `--uid` and `--trace` to mean anything: if the
 * narrowing is dropped here, the provider returns every event and the client-side
 * predicate still reports a filtered count.
 */
export const buildHistoricalRequest = (
  query: LogQuery,
):
  | { ok: true; request: ObservabilityQuery; limit: number; since: number | undefined }
  | { ok: false; reason: string } => {
  const decision = buildFilter(query, capabilitiesFor('cloudflare-observability'));

  if (!decision.ok) {
    return { ok: false, reason: decision.unsupported };
  }

  return {
    ok: true,
    request: buildObservabilityQuery(query, decision.since),
    limit: query.limit ?? 50,
    since: decision.since,
  };
};

/**
 * Historical query against Cloudflare.
 *
 * NOT IMPLEMENTED. Configuration is validated so a caller learns about a missing
 * Worker name or an absent credential, then the function stops with an explicit
 * status. It does not fall back to local files, because "here are your local
 * logs" in answer to "show me the last hour of production" is a misleading answer
 * rather than a helpful one.
 */
export const queryCloudflareHistory = async (query: LogQuery): Promise<LogQueryResult> => {
  const prerequisite = prerequisiteFor(query.app, query.mode);
  if (prerequisite !== null) {
    return { status: 'credentials_unavailable', events: [], message: prerequisite };
  }

  const worker = APP_LOG_CONFIG[query.app].workerName;
  if (worker === null) {
    return {
      status: 'credentials_unavailable',
      events: [],
      message: `No Worker name is configured for "${query.app}".`,
    };
  }

  const request = buildHistoricalRequest(query);
  if (!request.ok) {
    return { status: 'capability_unsupported', events: [], message: request.reason };
  }

  // NOT IMPLEMENTED — see the file header. Phase 3 sends the Observability REST
  // request built above. `retrieval_failed` is the honest status: returning an
  // empty *successful* result would read as "no events matched" when nothing was
  // ever asked.
  return {
    status: 'retrieval_failed',
    events: [],
    message:
      `Historical log retrieval is NOT IMPLEMENTED for Worker "${worker}". ` +
      'This repository does not yet send a Workers Observability request, so no ' +
      'result here reflects anything stored at the provider. Live tail and the ' +
      'local adapter do work: try --follow, or --mode local.',
  };
};

/**
 * Bounded live tail through `wrangler tail`.
 *
 * `wrangler tail` prints a provider envelope per event, not an application
 * `LogEvent`, so each line is parsed and an unparseable line is skipped rather
 * than passed downstream as if it were an event.
 *
 * The session is bounded by `MAX_TAIL_MS` and reports failure when the bound is
 * reached, so a forgotten `--follow` does not leave a process holding a port.
 */
export const tailCloudflare = async (query: LogQuery): Promise<LogQueryResult> => {
  const resolution = resolveLogAdapter(query.app, query.mode);
  if ('unsupported' in resolution) {
    return { status: 'capability_unsupported', events: [], message: resolution.unsupported };
  }
  if (resolution.kind !== 'wrangler-tail') {
    return {
      status: 'capability_unsupported',
      events: [],
      message: `--follow needs the wrangler-tail adapter; "${query.app}" does not use it here.`,
    };
  }

  const prerequisite = prerequisiteFor(query.app, query.mode);
  if (prerequisite !== null) {
    return { status: 'credentials_unavailable', events: [], message: prerequisite };
  }

  const worker = APP_LOG_CONFIG[query.app].workerName;
  if (worker === null) {
    return {
      status: 'credentials_unavailable',
      events: [],
      message: `No Worker name is configured for "${query.app}".`,
    };
  }

  const decision = buildFilter(query, capabilitiesFor('wrangler-tail'));
  if (!decision.ok) {
    return { status: 'capability_unsupported', events: [], message: decision.unsupported };
  }

  const budgetMs = Math.min(query.followBudgetMs ?? DEFAULT_TAIL_MS, MAX_TAIL_MS);
  let printed = 0;

  const code = await streamWrangler(['tail', worker, '--format', 'json', '--status', 'error'], {
    timeoutMs: budgetMs,
    // A live stream has no index, so the predicate runs here, on the client.
    // docs/logs.md says so rather than implying the provider filtered it.
    onStdout: (line) => {
      const event = parseEnvelopeEvent(line);
      if (event === null) {
        return;
      }
      if (decision.predicate?.(event) === true) {
        printed += 1;
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
    },
    onStderr: (line) => process.stderr.write(`${line}\n`),
  });

  const elapsed = `after ${Math.round(budgetMs / 1000)}s`;

  if (code === 0) {
    return { status: 'ok', events: [], message: `Tail closed ${elapsed}. ${printed} shown.` };
  }

  return {
    status: 'retrieval_failed',
    events: [],
    message: `wrangler tail exited ${code} ${elapsed}. ${printed} shown.`,
  };
};

/**
 * Epoch milliseconds, or null when the value is not a timestamp.
 *
 * A number passes through — that is what `wrangler tail --format json` emits. A
 * string is accepted only when `Date.parse` understands it, so an ISO-8601 event
 * from a hand-written or Logpush-shaped line still lands as a usable time rather
 * than as a string that fails every comparison downstream.
 */
const toEpochMs = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

/**
 * Pull an application event out of one line of `wrangler tail` output.
 *
 * Returns null for anything that is not an envelope carrying the required event
 * fields: every wrangler banner, every line of its own diagnostics, and any
 * envelope whose shape has changed. Passing one of those downstream as if it were
 * a `LogEvent` is what made the previous tail emit plausible-looking nonsense.
 */
export const parseEnvelopeEvent = (line: string): LogEvent | null => {
  const trimmed = line.trim();
  if (trimmed === '' || !trimmed.startsWith('{')) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const envelope = parsed as Record<string, unknown>;

  // `wrangler tail --format json` wraps the event; some versions emit it bare.
  // Accept both, and refuse anything missing the fields a `LogEvent` requires, so
  // a shape change shows up as fewer events rather than as invented ones.
  const candidate = (envelope.event ?? envelope.logs ?? envelope) as Record<string, unknown>;
  if (typeof candidate !== 'object' || candidate === null) {
    return null;
  }

  const { timestamp, level, message, source } = candidate;
  if (typeof level !== 'string' || typeof message !== 'string' || typeof source !== 'string') {
    return null;
  }

  // `LogEvent.timestamp` is a number, and the two things that read it assume one:
  // `--since` compares `event.timestamp < Date.now() - since`, which is false for
  // every string (NaN), and the human renderer formats it. Accepting only a string
  // here therefore rejected a numeric timestamp outright — and accepting a string
  // without converting it would pass the check while feeding NaN to both. So
  // numbers pass through, ISO-8601 is converted, and anything else is refused.
  const at = toEpochMs(timestamp);
  if (at === null) {
    return null;
  }

  return { ...candidate, timestamp: at, level, message, source } as unknown as LogEvent;
};
