// scripts/src/logs/observability_client.ts
//
// The one place that talks to the Workers Observability API over HTTP.
//
// Separate from `observability.ts` because that module is pure request-building
// and can be asserted without a credential, while this one needs one. Keeping
// them apart is what makes the request shape testable at all — the previous
// adapter had a tested translation and an untested transport, and the translation
// was the part that turned out to be wrong.
//
// Three invariants this module owns:
//
//   1. **The token is never logged.** Errors carry Cloudflare's message, which can
//      echo the request; the token is not in the request, so it cannot be echoed.
//      It is also never written to disk or included in a URL.
//   2. **A non-2xx is an error, not an empty result.** "No events matched" and "the
//      provider rejected the query" must never render the same way, because the
//      first invites a hunt through code and the second is a bug in this request.
//   3. **Every request is bounded.** A body budget, because a query with a wide
//      window and no filters can return a large page, and an event budget, because
//      `--limit` is the caller's bound and the provider's is 2000.
//
// `fetch` is a parameter so the response handling can be driven against a recorded
// provider payload rather than a hand-written object — a mock that agrees with the
// code proves nothing about the code.

import type { LogEvent } from '@starter/schemas/logging';
import { hasCloudflareCredential } from '../cloudflare/wrangler.ts';
import type { ObservabilityRequest } from './observability.ts';

/** Bytes of response body we will read. Beyond this the query is refused. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Hard ceiling on events kept, regardless of what the provider returns. */
export const MAX_EVENTS_KEPT = 2000;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface ObservabilityQueryOptions {
  accountId: string;
  token: string;
  worker: string | null;
  request: ObservabilityRequest;
  /** Injected in tests; defaults to the platform `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected in tests, so a timeout need not be real. */
  timeoutMs?: number;
}

export type ObservabilityOutcome =
  | {
      ok: true;
      events: LogEvent[] /** Provider-reported rows, for an empty result. */;
      rowsRead: number | null;
      truncated: boolean;
    }
  | {
      ok: false;
      status: 'credentials_unavailable' | 'retrieval_failed' | 'capability_unsupported';
      message: string;
    };

const API_ROOT = 'https://api.cloudflare.com/client/v4';

/** Why the query cannot be attempted, or null when it can. */
export const prerequisite = (accountId: string | null): string | null => {
  if (!hasCloudflareCredential()) {
    return (
      'No Cloudflare credential found. Set CLOUDFLARE_API_TOKEN.\n' +
      '  Nothing has been sent to the provider.'
    );
  }
  if (accountId === null || accountId.trim() === '') {
    return (
      'No Cloudflare account id is configured.\n' +
      '  The Observability endpoint is account-scoped, so there is nothing to query\n' +
      '  without one. Run: bun run deploy:configure'
    );
  }
  return null;
};

/** Cloudflare's error envelope, when the body carries one. */
const providerMessage = (body: string, fallback: string): string => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const envelope = parsed as { errors?: unknown; success?: unknown };
      if (Array.isArray(envelope.errors)) {
        const first = envelope.errors[0] as { message?: unknown } | undefined;
        if (typeof first?.message === 'string' && first.message !== '') {
          return first.message;
        }
      }
    }
  } catch {
    // Not JSON. A proxy or an edge error can return HTML, and that text is more
    // useful than "unexpected token h".
  }
  return body.trim() === '' ? fallback : body.trim().slice(0, 500);
};

/**
 * Pull application events out of a provider response.
 *
 * The endpoint returns `{ result: { data: [...] } }` where each row is the logged
 * object under a `$metadata` envelope. A row that lacks the fields a `LogEvent`
 * requires is *dropped*, not coerced: inventing a missing `level` or `source`
 * produces a plausible-looking event that no log ever emitted, which is the
 * failure this whole module exists to prevent.
 */
export const parseObservabilityEvents = (
  body: string,
): { events: LogEvent[]; rowsRead: number | null } => {
  const empty = { events: [] as LogEvent[], rowsRead: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return empty;
  }

  const root = parsed as {
    result?: { data?: unknown; rows_read?: unknown; statistics?: { rows_read?: unknown } };
    rows_read?: unknown;
  };

  const rows = root.result?.data;
  if (!Array.isArray(rows)) {
    const direct = root.result?.statistics?.rows_read ?? root.rows_read;
    return { events: [], rowsRead: typeof direct === 'number' ? direct : null };
  }

  // Reported, never used to decide whether the result is empty. `rows_read: 0`
  // has been observed for API-token queries the Cloudflare dashboard answers with
  // data, so treating it as authoritative would turn an indexing or permissions
  // problem into a confident "no events matched".
  const reported = root.result?.statistics?.rows_read ?? root.rows_read;
  const rowsRead = typeof reported === 'number' ? reported : null;

  const events: LogEvent[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const metadata = (record.$metadata ?? {}) as Record<string, unknown>;

    const message = record.message ?? metadata.message;
    const level = record.level ?? metadata.level;
    const source = record.source ?? metadata.source;
    const timestamp = metadata.timestamp ?? record.timestamp;

    if (typeof message !== 'string' || typeof level !== 'string' || typeof source !== 'string') {
      continue;
    }

    // `$metadata.timestamp` is an ISO string on this endpoint, while `LogEvent`
    // requires epoch milliseconds and both downstream comparisons assume a number.
    const at = typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp ?? ''));
    if (Number.isNaN(at)) {
      continue;
    }

    events.push({
      ...record,
      timestamp: at,
      level,
      message,
      source,
    } as unknown as LogEvent);

    if (events.length >= MAX_EVENTS_KEPT) {
      break;
    }
  }

  return { events, rowsRead };
};

/**
 * Run one historical query.
 *
 * Never throws. A failure is a typed outcome with a message the operator can act
 * on, because "retrieval failed" without saying what the provider said is the
 * same as no information.
 */
export const queryObservability = async (
  options: ObservabilityQueryOptions,
): Promise<ObservabilityOutcome> => {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (fetchImpl === undefined) {
    return {
      ok: false,
      status: 'capability_unsupported',
      message: 'No global fetch is available in this runtime, so the query cannot be sent.',
    };
  }

  const url = `${API_ROOT}/accounts/${encodeURIComponent(options.accountId)}/workers/observability/telemetry/query`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  timeout.unref?.();

  let response: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
      // `worker` is deliberately absent from the body: it narrows via `datasets`,
      // and sending it in two places is how a staging query ends up reading
      // production.
      body: JSON.stringify(options.request),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 'retrieval_failed',
      message:
        `The Observability request did not complete: ${detail}\n` +
        '  Nothing was changed. Check network reachability and the token scope\n' +
        '  ("Workers Observability Write").',
    };
  }
  clearTimeout(timeout);

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 'retrieval_failed',
      message: `The Observability response body could not be read: ${detail}`,
    };
  }

  if (body.length > MAX_RESPONSE_BYTES) {
    return {
      ok: false,
      status: 'retrieval_failed',
      message:
        `The Observability response was ${body.length} bytes, over the ${MAX_RESPONSE_BYTES}-byte\n` +
        '  budget. Narrow the window or add a filter rather than reading it into memory.',
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 'retrieval_failed',
      message:
        `Cloudflare returned ${response.status}: ${providerMessage(body, 'no detail supplied')}\n` +
        '  The query was sent and rejected; this is not an empty result.',
    };
  }

  const { events, rowsRead } = parseObservabilityEvents(body);

  return {
    ok: true,
    events,
    rowsRead,
    truncated: events.length >= MAX_EVENTS_KEPT,
  };
};
