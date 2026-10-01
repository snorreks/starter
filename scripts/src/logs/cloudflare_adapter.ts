// scripts/src/logs/cloudflare_adapter.ts
//
// Cloudflare Workers log access: a historical query and a bounded live tail.
//
// The historical path sends a real Workers Observability request
// (`POST /accounts/{id}/workers/observability/telemetry/query`). Its translation
// lives in `observability.ts` and its transport in `observability_client.ts`; the
// split is deliberate, because the bug this replaced was invisible for a specific
// reason — the request builder had tests, the transport did not, and the builder
// was wrong. It emitted a free-text `filter` string, which is Logpush's shape, and
// the Observability endpoint accepts structured `{key, operation, type, value}`
// filters instead. The tests were green because they asserted the string.
//
// So: the translation is pure and asserted against the API's documented shape, and
// the transport is driven against a recorded response. Neither needs a credential.
// **A live call has not been made** — see docs/cloudflare.md for exactly what is
// verified and what is not.
//
// Logpush stays a separate, optional capability. It is a different product with a
// different index, and conflating the two is what made the old translation wrong.
//
// The live tail is unchanged in shape: `wrangler tail` prints a provider envelope
// per event, so each line is parsed and an unparseable line is skipped rather than
// passed downstream as if it were an application event.

import { streamWrangler } from '../cloudflare/wrangler.ts';
import { buildFilter } from './filter.ts';
import { buildObservabilityRequest, type ObservabilityRequest } from './observability.ts';
import {
  type FetchLike,
  MAX_EVENTS_KEPT,
  prerequisite as observabilityPrerequisite,
  queryObservability,
} from './observability_client.ts';
import {
  APP_LOG_CONFIG,
  capabilitiesFor,
  DEPLOYMENT_CONFIG,
  prerequisiteFor,
  resolveLogAdapter,
} from './registry.ts';
import type { LogEvent, LogQuery, LogQueryResult } from './types.ts';

/** Upper bound on a single tail session, so `--follow` cannot run unbounded. */
export const MAX_TAIL_MS = 15 * 60_000;

/** Default tail budget when `--follow` is given without a duration. */
export const DEFAULT_TAIL_MS = 60_000;

/** The window a query covers when `--since` is absent. */
export const DEFAULT_WINDOW_MS = 60 * 60_000;

/** Ceiling on one historical read, so `--since 30d` cannot fetch forever. */
export const MAX_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** The configured Cloudflare account id, or null when unprovisioned. */
const accountId = (): string | null => DEPLOYMENT_CONFIG.accountId;

/**
 * The provider request this query would send.
 *
 * Exported so the translation can be asserted without a credential, which is the
 * whole point of splitting it out: the previous translation built a free-text
 * filter string that the Observability endpoint does not accept, and its tests
 * passed because they asserted that string.
 */
export const buildHistoricalRequest = (
  query: LogQuery,
):
  | { ok: true; request: ObservabilityRequest; since: number | undefined }
  | { ok: false; reason: string } => {
  const decision = buildFilter(query, capabilitiesFor('cloudflare-observability'));

  if (!decision.ok) {
    return { ok: false, reason: decision.unsupported };
  }

  const windowMs = Math.min(decision.since ?? DEFAULT_WINDOW_MS, MAX_WINDOW_MS);
  const worker = APP_LOG_CONFIG[query.app].workerName;

  return {
    ok: true,
    // `Date.now()` is injected rather than read here so the window is assertable
    // without freezing the clock, and so the caller can pin both ends.
    request: buildObservabilityRequest(
      query,
      { from: Date.now() - windowMs, to: Date.now() },
      worker,
    ),
    since: decision.since,
  };
};

/**
 * Historical query against Cloudflare Workers Observability.
 *
 * Sends a real request to `POST /accounts/{id}/workers/observability/telemetry/query`
 * and parses the response. Failures stay distinguishable from an empty window: a
 * rejected query reports `retrieval_failed` with what the provider said, and a
 * successful query with no rows reports `rows_read` when the provider supplied it,
 * because `rows_read: 0` has been observed for API-token queries that the
 * dashboard answers with data.
 *
 * `fetchImpl` is a parameter so the response handling can be driven against a
 * recorded payload. No credential is used or required by the tests.
 */
export const queryCloudflareHistory = async (
  query: LogQuery,
  fetchImpl?: FetchLike,
): Promise<LogQueryResult> => {
  const gate = prerequisiteFor(query.app, query.mode);
  if (gate !== null) {
    return { status: 'credentials_unavailable', events: [], message: gate };
  }

  const observabilityGate = observabilityPrerequisite(accountId());
  if (observabilityGate !== null) {
    return { status: 'credentials_unavailable', events: [], message: observabilityGate };
  }

  const worker = APP_LOG_CONFIG[query.app].workerName;
  if (worker === null) {
    return {
      status: 'credentials_unavailable',
      events: [],
      message: `No Worker name is configured for "${query.app}".`,
    };
  }

  const built = buildHistoricalRequest(query);
  if (!built.ok) {
    return { status: 'capability_unsupported', events: [], message: built.reason };
  }

  // A supported filter is not the same as one the provider honours. The predicate
  // still runs over the response, so a narrowing the provider silently ignored
  // cannot present itself as a filtered result.
  const decision = buildFilter(query, capabilitiesFor('cloudflare-observability'));
  if (!decision.ok) {
    return { status: 'capability_unsupported', events: [], message: decision.unsupported };
  }

  const outcome = await queryObservability({
    accountId: accountId() as string,
    token: process.env.CLOUDFLARE_API_TOKEN as string,
    worker,
    request: built.request,
    fetchImpl,
  });

  if (!outcome.ok) {
    return { status: outcome.status, events: [], message: outcome.message };
  }

  const events =
    decision.predicate === undefined ? outcome.events : outcome.events.filter(decision.predicate);

  const rows =
    outcome.rowsRead === null ? '' : ` The provider reported ${outcome.rowsRead} rows read.`;

  const suffix = outcome.truncated
    ? `\n  Stopped at the ${MAX_EVENTS_KEPT}-event ceiling; narrow the window for the rest.`
    : '';

  if (events.length === 0) {
    // An empty result and a rejected query must never read the same. This one
    // succeeded, so the honest message is "the window held no matching events",
    // plus the provider's own row count when it gave one.
    return {
      status: 'ok',
      events: [],
      message:
        `No events matched in the queried window for Worker "${worker}".${rows}` +
        `\n  If you expected some: rows_read of 0 has been reported for API-token` +
        `\n  queries that the Cloudflare dashboard answers with data, so this may be` +
        `\n  a permissions or index-lag issue rather than an empty window.${suffix}`,
    };
  }

  return { status: 'ok', events, message: `${events.length} event(s).${rows}${suffix}` };
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
