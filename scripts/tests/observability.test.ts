// scripts/tests/observability.test.ts
//
// The Workers Observability request, asserted against the endpoint's contract.
//
// Split from `logs.test.ts` because the thing under test is a wire format rather
// than filter semantics, and it deserves its own file now that it is two modules.
//
// Why the shape is asserted so literally: the previous translation emitted a
// free-text `filter` string — Logpush's format — while this endpoint accepts
// structured `{key, operation, type, value}` filters under `parameters.filters`.
// It had tests, and those tests passed, because they asserted the string it
// produced. A test that pins a locally-chosen format cannot catch that format
// being wrong; only a test written against the documented endpoint can.
//
// Contract, verified 2026-10-01:
//   POST /accounts/{account_id}/workers/observability/telemetry/query
//   Auth `Authorization: Bearer <token>`, scope "Workers Observability Write"
//   https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query
//
// No credential and no network are used. The response fixture records the envelope
// shape with invented values; what is pinned is the *structure*, which is the part
// a real capture would confirm.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildObservabilityRequest,
  levelFloor,
  MAX_PROVIDER_LIMIT,
} from '../src/logs/observability.ts';
import {
  type FetchLike,
  parseObservabilityEvents,
  queryObservability,
} from '../src/logs/observability_client.ts';
import type { LogQuery } from '../src/logs/types.ts';

const NOW = 1_760_000_000_000;
const WINDOW = { from: NOW - 60_000, to: NOW };

const baseQuery: LogQuery = { app: 'web', mode: 'staging' };

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('buildObservabilityRequest', () => {
  test('emits structured filter leaves, and no filter string', () => {
    const request = buildObservabilityRequest(
      { ...baseQuery, level: 'ERROR', source: 'worker', trace: 'tr_2' },
      WINDOW,
      'starter-api',
    );

    // The endpoint has no `filter` string field at all. If one appears here the
    // request is either a 400 or is silently unnarrowed.
    expect(JSON.stringify(request)).not.toContain('"filter"');

    expect(request.parameters.filters).toContainEqual({
      key: 'source',
      operation: 'eq',
      type: 'string',
      value: 'worker',
    });
    expect(request.parameters.filters).toContainEqual({
      key: 'traceId',
      operation: 'eq',
      type: 'string',
      value: 'tr_2',
    });
    expect(request.parameters.filterCombination).toBe('and');
  });

  test('expresses severity as an in-set, because the provider orders no levels', () => {
    // `level >= "WARNING"` is not a meaningful expression here. The levels at or
    // above the threshold are enumerated, which is what `in` takes.
    const request = buildObservabilityRequest(
      { ...baseQuery, level: 'WARNING' },
      WINDOW,
      'starter-api',
    );

    const level = request.parameters.filters.find((f) => f.key === 'level');
    expect(level?.operation).toBe('in');
    expect(level?.value).toBe('WARNING,ERROR,NONE');
    expect(JSON.stringify(request)).not.toContain('>=');
  });

  test('omits a severity filter entirely for DEBUG', () => {
    // An empty `in` would match nothing, which is the opposite of what
    // `--level DEBUG` means.
    expect(levelFloor('DEBUG')).toBeNull();
    const request = buildObservabilityRequest({ ...baseQuery, level: 'DEBUG' }, WINDOW, null);
    expect(request.parameters.filters).toEqual([]);
  });

  test('sends the window as timeframe, not as a timestamp filter', () => {
    // The window is a separate required field; there is no timestamp filter key to
    // compare against.
    const request = buildObservabilityRequest({ ...baseQuery }, WINDOW, null);
    expect(request.timeframe).toEqual(WINDOW);
    expect(request.parameters.filters.find((f) => f.key === 'timestamp')).toBeUndefined();
  });

  test('names the worker through datasets, in exactly one place', () => {
    // Naming it in the body twice is how a staging query ends up reading production.
    const request = buildObservabilityRequest({ ...baseQuery }, WINDOW, 'starter-api');
    expect(request.datasets).toEqual(['starter-api']);
    expect(JSON.stringify(request).match(/starter-api/g)).toHaveLength(1);
  });

  test('clamps the limit to what the provider accepts', () => {
    // More than 2000 is a 400, not a larger read.
    expect(buildObservabilityRequest({ ...baseQuery, limit: 999_999 }, WINDOW, null).limit).toBe(
      MAX_PROVIDER_LIMIT,
    );

    expect(buildObservabilityRequest({ ...baseQuery, limit: -5 }, WINDOW, null).limit).toBe(1);
  });

  test('a quote in a value crosses the wire as data, not as filter syntax', () => {
    // The string form was injectable: a `"` in `--trace` closed the clause and the
    // remainder became filter text, widening the provider query while the local
    // predicate still narrowed it. A structured value has no such failure mode.
    const request = buildObservabilityRequest(
      { ...baseQuery, trace: 'tr" OR level >= "DEBUG' },
      WINDOW,
      null,
    );

    const trace = request.parameters.filters.find((f) => f.key === 'traceId');
    expect(trace?.value).toBe('tr" OR level >= "DEBUG');
    expect(trace?.operation).toBe('eq');
    // The decisive difference: exactly one filter leaf, carrying the whole string.
    // The old builder emitted `traceId = "tr\" OR level >= \"DEBUG"` *inside* a
    // larger expression, so the provider saw a quote and the rest of the argument
    // became syntax. Here it is one JSON value and there is nothing to close.
    expect(request.parameters.filters).toHaveLength(1);
    expect(request.parameters.filterCombination).toBe('and');
  });

  test('a user filter names the verified field, not client-reported data', () => {
    const request = buildObservabilityRequest({ ...baseQuery, uid: 'user_verified' }, WINDOW, null);
    expect(request.parameters.filters).toContainEqual({
      key: 'userId',
      operation: 'eq',
      type: 'string',
      value: 'user_verified',
    });
    expect(JSON.stringify(request)).not.toContain('clientReported');
  });
});

describe('parseObservabilityEvents', () => {
  test('reads events out of a recorded provider response', () => {
    const parsed = parseObservabilityEvents(fixture('observability_response.json'));

    expect(parsed.events).toHaveLength(3);
    expect(parsed.rowsRead).toBe(3);

    const first = parsed.events[0];
    expect(first?.level).toBe('ERROR');
    expect(first?.message).toBe('Unhandled exception in /api/notes');
    expect(first?.source).toBe('worker');
    // The fixture carries an ISO string. `LogEvent.timestamp` is a number, and both
    // `--since` comparison and the human renderer assume one, so a string here
    // makes every comparison false and renders as `NaN`.
    expect(typeof first?.timestamp).toBe('number');
    expect(first?.timestamp).toBe(Date.parse('2026-09-30T12:00:00.123Z'));
  });

  test('drops rows that are not events instead of coercing them', () => {
    // Inventing a missing level would produce an event that looks real and that no
    // log ever emitted. The fixture holds three unusable rows, so a parser that
    // returned them would report 3 rather than 0.
    const parsed = parseObservabilityEvents(fixture('observability_non_events.json'));

    expect(parsed.events).toEqual([]);
    // Reported rather than used to decide emptiness: `rows_read: 0` has been
    // observed for API-token queries the dashboard answers with data.
    expect(parsed.rowsRead).toBe(0);
  });

  test('a body that is not JSON yields nothing rather than throwing', () => {
    expect(parseObservabilityEvents('<html>502 Bad Gateway</html>')).toEqual({
      events: [],
      rowsRead: null,
    });
  });

  test('a response with no data array is empty, not an error', () => {
    const parsed = parseObservabilityEvents(JSON.stringify({ success: true, result: {} }));
    expect(parsed.events).toEqual([]);
  });
});

describe('queryObservability', () => {
  const request = buildObservabilityRequest(baseQuery, WINDOW, 'starter-api');

  const send = (
    reply: string,
    status = 200,
  ): { fetchImpl: FetchLike; seen: { url?: string; body?: unknown; auth?: string } } => {
    const seen: { url?: string; body?: unknown; auth?: string } = {};
    const fetchImpl: FetchLike = async (url, init) => {
      seen.url = url;
      seen.body = JSON.parse(init.body);
      seen.auth = init.headers.Authorization;
      return { ok: status >= 200 && status < 300, status, text: async () => reply };
    };
    return { fetchImpl, seen };
  };

  test('posts to the account-scoped endpoint with a bearer token', async () => {
    const { fetchImpl, seen } = send(fixture('observability_response.json'));
    const outcome = await queryObservability({
      accountId: 'acct_abc123',
      token: 'tok_secret',
      worker: 'starter-api',
      request,
      fetchImpl,
    });

    expect(outcome.ok).toBe(true);
    expect(seen.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct_abc123/workers/observability/telemetry/query',
    );
    expect(seen.auth).toBe('Bearer tok_secret');
    // The token must not reach the body or the URL, where a log line would capture it.
    expect(JSON.stringify(seen.body)).not.toContain('tok_secret');
    expect(seen.url).not.toContain('tok_secret');
  });

  test('reports a rejected query as a failure, never as an empty window', async () => {
    // "No events matched" and "the provider refused" must not render alike: the
    // first sends a reader hunting through code, the second is a bug in this request.
    const { fetchImpl } = send(
      JSON.stringify({ success: false, errors: [{ message: 'invalid filter key' }] }),
      400,
    );

    const outcome = await queryObservability({
      accountId: 'acct_abc123',
      token: 'tok',
      worker: 'starter-api',
      request,
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe('retrieval_failed');
      expect(outcome.message).toContain('invalid filter key');
      expect(outcome.message).toContain('400');
    }
  });

  test('surfaces a transport failure with what actually happened', async () => {
    const outcome = await queryObservability({
      accountId: 'acct_abc123',
      token: 'tok',
      worker: 'starter-api',
      request,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe('retrieval_failed');
      expect(outcome.message).toContain('ECONNREFUSED');
    }
  });

  test('refuses a body over the byte budget rather than reading it into memory', async () => {
    const huge = JSON.stringify({ result: { data: [], pad: 'x'.repeat(9 * 1024 * 1024) } });
    const { fetchImpl } = send(huge);

    const outcome = await queryObservability({
      accountId: 'acct_abc123',
      token: 'tok',
      worker: 'starter-api',
      request,
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain('budget');
    }
  });

  test('says so when there is no fetch at all, rather than throwing', async () => {
    const savedFetch = globalThis.fetch;
    try {
      Object.defineProperty(globalThis, 'fetch', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      const outcome = await queryObservability({
        accountId: 'acct_abc123',
        token: 'tok',
        worker: 'starter-api',
        request,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.status).toBe('capability_unsupported');
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test('aborts while retrieving the response body and reports a read failure', async () => {
    const outcome = await queryObservability({
      accountId: 'acct_abc123',
      token: 'tok',
      worker: 'starter-api',
      request,
      timeoutMs: 10,
      fetchImpl: async (_url, init) => ({
        ok: true,
        status: 200,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            if (init.signal === undefined) {
              throw new Error('Missing request signal');
            }
            init.signal.addEventListener('abort', () => reject(new Error('body aborted')), {
              once: true,
            });
          }),
      }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe('retrieval_failed');
      expect(outcome.message).toContain('body aborted');
    }
  });
});
