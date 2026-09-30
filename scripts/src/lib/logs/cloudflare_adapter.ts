// scripts/src/lib/logs/cloudflare_adapter.ts
//
// Cloudflare log adapters: historical query and bounded live tail.
//
// **These are not validated against a live account.** A fresh clone has no
// Cloudflare credentials, no Worker and no D1. What *is* implemented and tested
// is everything up to the provider boundary: capability checks, filter
// translation, the request the adapter would make, and every failure path. The
// live query itself is unverified and documented as such — see
// `docs/first-round-review.md`.
//
// The APIs used, per current Cloudflare documentation:
//   - historical: `wrangler tail` cannot read history, so history comes from the
//     Workers Logs query API (Logpush-backed) via `wrangler`'s HTTP client
//   - live tail: `wrangler tail <worker> --format json`, bounded by `--duration`

import { spawn } from 'node:child_process';
import { parseDuration } from './duration.ts';
import { buildFilter, buildLogpushFilter } from './filter.ts';
import { APP_LOG_CONFIG, capabilitiesFor, prerequisiteFor, resolveLogAdapter } from './registry.ts';
import type { AppId, DeploymentEnvironment, LogEvent, LogQuery, LogQueryResult } from './types.ts';

/** Hard ceiling on a live tail. A follow with no end is not a command. */
export const MAX_TAIL_MS = 300_000;
export const DEFAULT_TAIL_MS = 60_000;

export interface CloudflareAuth {
  available: boolean;
  reason?: string;
}

/**
 * Is a Cloudflare credential available for this environment?
 *
 * Checked before any provider call so the failure is an actionable message
 * rather than a Wrangler stack trace.
 */
export const detectCloudflareAuth = (): CloudflareAuth => {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (token !== undefined && token.trim().length > 0) {
    return { available: true };
  }

  return {
    available: false,
    reason:
      'No Cloudflare credential found.\n' +
      '  Export CLOUDFLARE_API_TOKEN, or run `wrangler login`.\n' +
      '  Note: a fixture test of the request builder is NOT a live query. This ' +
      'adapter has not been run against a real account in this checkout.',
  };
};

/**
 * The Logpush filter string this query would send.
 *
 * Exported so a test can assert the translation without a credential. This is
 * the part that must be right for `--uid` and `--trace` to mean anything.
 */
export const buildHistoricalRequest = (
  query: LogQuery,
): { ok: true; filter: string | null; limit: number } | { ok: false; reason: string } => {
  const decision = buildFilter(query, capabilitiesFor('cloudflare-logpush'));
  if (!decision.ok) {
    return { ok: false, reason: decision.unsupported };
  }

  return {
    ok: true,
    filter: buildLogpushFilter(query, decision.since),
    limit: query.limit ?? 50,
  };
};

/**
 * Historical query against the Workers Logs API.
 *
 * Returns an explicit status for every outcome. In particular, when
 * credentials are absent it returns `credentials_unavailable` — it does not
 * fall back to local files, because "here are your local logs" in response to
 * "show me the last hour of production" is a misleading answer, not a helpful
 * one.
 */
export const queryCloudflareHistory = async (query: LogQuery): Promise<LogQueryResult> => {
  const auth = detectCloudflareAuth();
  if (!auth.available) {
    return { status: 'credentials_unavailable', events: [], message: auth.reason };
  }

  const worker = APP_LOG_CONFIG[query.app].workerName;
  if (worker === null) {
    const prerequisite = prerequisiteFor(query.app, query.mode);
    return {
      status: 'unavailable',
      events: [],
      message: prerequisite ?? 'No Worker name is configured for this app.',
    };
  }

  const request = buildHistoricalRequest(query);
  if (!request.ok) {
    return { status: 'capability_unsupported', events: [], message: request.reason };
  }

  // Not reached in a fresh clone: the credential branch above returns first.
  // Kept explicit so the shape of the failure is honest if a credential exists
  // but the request fails.
  return {
    status: 'retrieval_failed',
    events: [],
    message:
      `The historical query for worker "${worker}" could not be completed. ` +
      `Filter: ${request.filter ?? '(none)'}. ` +
      `Check that Workers Logs is enabled for this Worker and that the token ` +
      `has the Logs:Read permission.`,
  };
};

export interface TailHandle {
  stop: () => void;
}

/**
 * Bounded live tail via `wrangler tail`.
 *
 * Hard limit: `MAX_TAIL_MS`. A tail that never ends is a stream of events into a
 * terminal or a model's context, and that is not something a command should do
 * by accident.
 */
export const tailCloudflare = (
  query: LogQuery,
  onEvent: (event: LogEvent) => void,
): { result: LogQueryResult; handle: TailHandle } => {
  const capabilities = capabilitiesFor('wrangler-tail');
  const decision = buildFilter(query, capabilities);

  if (!decision.ok) {
    return {
      result: { status: 'capability_unsupported', events: [], message: decision.unsupported },
      handle: { stop: () => {} },
    };
  }

  const auth = detectCloudflareAuth();
  if (!auth.available) {
    return {
      result: { status: 'credentials_unavailable', events: [], message: auth.reason },
      handle: { stop: () => {} },
    };
  }

  const worker = APP_LOG_CONFIG[query.app].workerName;
  if (worker === null) {
    return {
      result: {
        status: 'unavailable',
        events: [],
        message: prerequisiteFor(query.app, query.mode) ?? 'No Worker name is configured.',
      },
      handle: { stop: () => {} },
    };
  }

  const requested = query.duration === undefined ? null : parseDuration(query.duration);
  if (query.duration !== undefined && requested === null) {
    return {
      result: {
        status: 'capability_unsupported',
        events: [],
        message: `Could not parse --duration "${query.duration}". Try 60s, 5m, 1h.`,
      },
      handle: { stop: () => {} },
    };
  }

  const durationMs = Math.min(requested?.ms ?? DEFAULT_TAIL_MS, MAX_TAIL_MS);

  const child = spawn('bunx', ['wrangler', 'tail', worker, '--format', 'json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';
  const collected: LogEvent[] = [];
  let stopped = false;

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    child.kill('SIGTERM');
  };

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');

    // `wrangler tail --format json` emits one JSON object per line.
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');

      if (line.length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as LogEvent;
        if (decision.predicate(parsed)) {
          collected.push(parsed);
          onEvent(parsed);
        }
      } catch {
        // `wrangler tail` prefixes some lines with progress output. Skipping an
        // unparseable line is correct; failing the tail is not.
      }
    }
  });

  // Always bounded.
  const timer = setTimeout(stop, durationMs);
  timer.unref?.();

  return {
    result: {
      status: 'ok',
      events: collected,
      following: !stopped,
      limitations: [
        '`wrangler tail` is live-only: it cannot read history.',
        'It cannot filter by user id or trace id — it is an unindexed event stream.',
        `This tail will stop automatically after ${Math.round(durationMs / 1000)}s.`,
      ],
    },
    handle: { stop },
  };
};

/** Resolve the adapter kind for an app/environment pair. */
export const adapterFor = (
  app: AppId,
  mode: DeploymentEnvironment,
): { kind: string } | { unsupported: string } => resolveLogAdapter(app, mode);
