// scripts/src/logs/logs.test.ts
//
// Deterministic tests for the log family.
//
// Everything here runs without credentials, without a network and without
// Cloudflare. That is the point: the *translation* of a query into a provider
// filter, and the decision to refuse an unsupported filter, are the parts that
// can silently be wrong, and both are testable offline.
//
// What is NOT covered here: a live Cloudflare query. The request shape and the
// response handling are pinned against the documented endpoint contract and a
// recorded response fixture, but no request has been sent to a provisioned
// account. docs/cloudflare.md records that distinction explicitly.
//
// The previous version of this file tested a translation that was wrong: it
// asserted a free-text `filter` string, which is Logpush's shape, while the
// Observability query endpoint takes structured `{key, operation, type, value}`
// filters. Those tests passed, which is the part worth remembering — a test that
// pins the wrong contract reads as evidence the code is correct.

import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { type LogEvent, LogEventSchema } from '@starter/schemas';
import { parseArgs, toQuery } from '../src/commands/logs.ts';
import {
  buildHistoricalRequest,
  MAX_TAIL_MS,
  parseEnvelopeEvent,
} from '../src/logs/cloudflare_adapter.ts';
import { parseDuration } from '../src/logs/duration.ts';
import { buildFilter } from '../src/logs/filter.ts';
import { parseNdjson } from '../src/logs/local_file_adapter.ts';
import { capabilitiesFor, resolveLogAdapter } from '../src/logs/registry.ts';
import type { LogQuery } from '../src/logs/types.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_760_000_000_000;

const event = (overrides: Partial<LogEvent> = {}): LogEvent => ({
  timestamp: NOW,
  app: 'client',
  environment: 'local',
  source: 'browser',
  level: 'INFO',
  event: 'notes.list',
  release: 'test-sha',
  ...overrides,
});

const FIXTURES: LogEvent[] = [
  // Older than every window used below, so `--since` has something to exclude.
  event({ timestamp: NOW - 40 * 60_000, level: 'INFO', event: 'notes.ancient' }),
  event({ timestamp: NOW - 60_000, level: 'DEBUG', event: 'notes.debug' }),
  event({ timestamp: NOW - 30_000, level: 'INFO', event: 'notes.list' }),
  event({ timestamp: NOW - 20_000, level: 'WARNING', event: 'notes.slow' }),
  event({ timestamp: NOW - 10_000, level: 'ERROR', event: 'notes.create_failed', traceId: 'tr_1' }),
  event({
    timestamp: NOW - 5_000,
    app: 'api',
    source: 'worker',
    level: 'ERROR',
    event: 'request.failed',
    traceId: 'tr_2',
    userId: 'user_verified',
  }),
  event({
    timestamp: NOW - 4_000,
    app: 'api',
    source: 'worker',
    level: 'ERROR',
    event: 'client_reported',
    // A browser-forwarded event: self-asserted identity, not verified.
    data: { clientReported: { userId: 'user_spoofed' } },
  }),
];

const baseQuery: LogQuery = { app: 'api', mode: 'local' };

// ── Duration parsing ─────────────────────────────────────────────────────────

describe('parseDuration', () => {
  test('parses each supported unit', () => {
    expect(parseDuration('45s')?.ms).toBe(45_000);
    expect(parseDuration('30m')?.ms).toBe(1_800_000);
    expect(parseDuration('2h')?.ms).toBe(7_200_000);
    expect(parseDuration('1d')?.ms).toBe(86_400_000);
    expect(parseDuration('1w')?.ms).toBe(604_800_000);
  });

  test('accepts fractions and surrounding whitespace', () => {
    expect(parseDuration('  1.5h ')?.ms).toBe(5_400_000);
  });

  test('returns null rather than guessing', () => {
    // A silent 0 turns "the last 30 minutes" into "everything" or "nothing".
    for (const input of ['30', '30x', 'abc', '', '-5m', undefined]) {
      expect(parseDuration(input)).toBeNull();
    }
  });
});

// ── Filter application ───────────────────────────────────────────────────────

describe('buildFilter', () => {
  const capable = { userIdFilter: true, traceIdFilter: true };

  test('applies the level threshold', () => {
    const decision = buildFilter({ ...baseQuery, level: 'ERROR' }, capable);
    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      return;
    }

    const matched = FIXTURES.filter(decision.predicate);
    expect(matched.map((e) => e.event)).toEqual([
      'notes.create_failed',
      'request.failed',
      'client_reported',
    ]);
  });

  test('applies the trace filter', () => {
    const decision = buildFilter({ ...baseQuery, trace: 'tr_2' }, capable);
    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      return;
    }

    expect(FIXTURES.filter(decision.predicate).map((e) => e.event)).toEqual(['request.failed']);
  });

  test('applies the source filter', () => {
    const decision = buildFilter({ ...baseQuery, source: 'browser' }, capable);
    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      return;
    }

    expect(FIXTURES.filter(decision.predicate).every((e) => e.source === 'browser')).toBe(true);
  });

  test('applies the since window relative to now', () => {
    const decision = buildFilter({ ...baseQuery, since: '15m' }, capable);
    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      return;
    }

    // FIXTURES are timestamped relative to a fixed NOW, so compare against that.
    const predicate = decision.predicate;
    const matched = FIXTURES.filter((candidate) => {
      const original = Date.now;
      Date.now = () => NOW;
      try {
        return predicate(candidate);
      } finally {
        Date.now = original;
      }
    });
    expect(matched.every((e) => NOW - e.timestamp <= 900_000)).toBe(true);
    expect(matched.map((e) => e.event)).not.toContain('notes.ancient');
  });

  test('matches a user only on a server-verified id', () => {
    const decision = buildFilter({ ...baseQuery, uid: 'user_spoofed' }, capable);
    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      return;
    }

    // The spoofed id lives under clientReported and must not match --uid.
    expect(FIXTURES.filter(decision.predicate)).toHaveLength(0);
  });

  test('matches a verified user id', () => {
    const decision = buildFilter({ ...baseQuery, uid: 'user_verified' }, capable);
    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      return;
    }

    expect(FIXTURES.filter(decision.predicate).map((e) => e.event)).toEqual(['request.failed']);
  });

  test('refuses --uid when the adapter cannot filter by it', () => {
    const decision = buildFilter({ ...baseQuery, uid: 'u' }, capabilitiesFor('wrangler-tail'));
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      return;
    }
    expect(decision.unsupported).toContain('cannot filter by user id');
  });

  test('refuses --trace when the adapter cannot filter by it', () => {
    const decision = buildFilter({ ...baseQuery, trace: 't' }, capabilitiesFor('wrangler-tail'));
    expect(decision.ok).toBe(false);
  });

  test('rejects an unparseable --before returning a predicate', () => {
    const decision = buildFilter({ ...baseQuery, since: 'soon' }, capable);
    expect(decision.ok).toBe(false);
  });
});

// ── Tail envelope parsing ─────────────────────────────────────────────────────

describe('parseEnvelopeEvent', () => {
  // The bare event form, and the `event`-wrapped form — the two this parser reads
  // (it takes `envelope.event ?? envelope.logs ?? envelope`).
  const bare = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      timestamp: NOW,
      level: 'ERROR',
      message: 'notes.create_failed',
      source: 'worker',
      ...overrides,
    });

  const envelope = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({ event: { ...JSON.parse(bare(overrides)) } });

  test('accepts the numeric timestamp wrangler emits', () => {
    // `LogEvent.timestamp` is a number, and `wrangler tail --format json` sends
    // one. Requiring a string rejected every real event.
    expect(parseEnvelopeEvent(bare())?.timestamp).toBe(NOW);
    expect(parseEnvelopeEvent(envelope())?.timestamp).toBe(NOW);
  });

  test('converts an ISO timestamp string to epoch milliseconds', () => {
    // A string that was accepted before, but handed on as a string — and
    // `event.timestamp < Date.now() - since` is false for every string, so `--since`
    // silently excluded nothing.
    const parsed = parseEnvelopeEvent(bare({ timestamp: new Date(NOW).toISOString() }));
    expect(parsed?.timestamp).toBe(NOW);
  });

  test('refuses a timestamp that is neither a number nor a date', () => {
    // Not converted to `Date.now()` and not passed through: either would be a
    // timestamp that looks real and is not.
    expect(parseEnvelopeEvent(bare({ timestamp: 'yesterday' }))).toBeNull();
    expect(parseEnvelopeEvent(bare({ timestamp: null }))).toBeNull();
    expect(parseEnvelopeEvent(bare({ timestamp: Number.NaN }))).toBeNull();
  });

  test('still refuses a non-JSON line and a banner', () => {
    expect(parseEnvelopeEvent('Connected to Cloudflare')).toBeNull();
    expect(parseEnvelopeEvent('[ERROR] A worker threw')).toBeNull();
  });
});

describe('buildHistoricalRequest', () => {
  test('carries the narrowing and the limit', () => {
    // `uid` is narrowed server-side by the historical adapter, which is the one
    // path where a verified user id is filterable.
    const request = buildHistoricalRequest({
      ...baseQuery,
      mode: 'production',
      level: 'WARNING',
      uid: 'user_verified',
    });
    expect(request.ok).toBe(true);
    if (request.ok) {
      // Structured filters, per the endpoint contract. See observability.test.ts
      // for why this cannot be a filter string.
      expect(request.request.parameters.filters).toContainEqual({
        key: 'userId',
        operation: 'eq',
        type: 'string',
        value: 'user_verified',
      });
      expect(request.request.limit).toBe(50);
    }
  });

  test('the historical adapter narrows by verified user id', () => {
    // The refusal for a live tail happens where the *resolved* adapter is consulted
    // — `buildFilter` against `capabilitiesFor('wrangler-tail')`, asserted above.
    // Here the point is the opposite: this path does narrow, so `--uid` is honoured
    // rather than silently dropped from the provider request.
    const request = buildHistoricalRequest({ ...baseQuery, uid: 'user_verified' });
    expect(request.ok).toBe(true);
    if (request.ok) {
      expect(request.request.parameters.filters).toContainEqual({
        key: 'userId',
        operation: 'eq',
        type: 'string',
        value: 'user_verified',
      });
      expect(JSON.stringify(request.request)).not.toContain('clientReported');
    }
  });
});

// ── Registry / capability honesty ────────────────────────────────────────────

describe('app registry', () => {
  test('browser logs have no staging or production adapter', () => {
    // This is the "browser logs are not server logs" rule, enforced in data.
    const staging = resolveLogAdapter('client', 'staging');
    expect('unsupported' in staging).toBe(true);
  });

  test('the API has a local adapter', () => {
    const local = resolveLogAdapter('api', 'local');
    expect(local).toEqual({ kind: 'local-file' });
  });

  test('the live tail declares it cannot filter by user or trace', () => {
    const capabilities = capabilitiesFor('wrangler-tail');
    expect(capabilities.userIdFilter).toBe(false);
    expect(capabilities.traceIdFilter).toBe(false);
    expect(capabilities.historicalQuery).toBe(false);
    expect(capabilities.liveTail).toBe(true);
  });

  test('the live tail has a hard duration ceiling', () => {
    // A `--follow` with no bound holds a wrangler process and its workerd child.
    expect(MAX_TAIL_MS).toBe(15 * 60_000);
  });

  test('--duration is clamped to that ceiling before the adapter sees it', () => {
    const parsed = parseArgs(['api', '--follow', '--duration', '1h']);
    const query = toQuery(parsed);
    expect(query.ok).toBe(true);
    if (!query.ok) {
      return;
    }
    expect(query.query.followBudgetMs).toBe(MAX_TAIL_MS);
  });

  test('an unparseable --duration is a usage error, not a silent default', () => {
    expect(toQuery(parseArgs(['api', '--follow', '--duration', 'soon'])).ok).toBe(false);
  });
});

// ── NDJSON parsing ───────────────────────────────────────────────────────────

describe('parseNdjson', () => {
  test('parses a well-formed file', () => {
    const ndjson = FIXTURES.map((e) => JSON.stringify(e)).join('\n');
    expect(parseNdjson(ndjson)).toHaveLength(FIXTURES.length);
  });

  test('skips a truncated final line instead of failing the read', () => {
    const ndjson = `${FIXTURES.map((e) => JSON.stringify(e)).join('\n')}\n{"partial":`;
    expect(parseNdjson(ndjson)).toHaveLength(FIXTURES.length);
  });

  test('every fixture validates against the canonical schema', () => {
    for (const fixture of FIXTURES) {
      expect(Value.Check(LogEventSchema, fixture)).toBe(true);
    }
  });
});

// ── Argument parsing ─────────────────────────────────────────────────────────

describe('parseArgs / toQuery', () => {
  test('parses a documented invocation', () => {
    const parsed = parseArgs([
      'client',
      '--mode',
      'local',
      '--source',
      'browser',
      '--level',
      'debug',
    ]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.app).toBe('client');

    const query = toQuery(parsed);
    expect(query.ok).toBe(true);
    if (!query.ok) {
      return;
    }
    expect(query.query.mode).toBe('local');
    expect(query.query.source).toBe('browser');
    expect(query.query.level).toBe('DEBUG');
  });

  test('accepts --flag=value', () => {
    const parsed = parseArgs(['api', '--since=30m', '--limit=10']);
    const query = toQuery(parsed);
    expect(query.ok).toBe(true);
    if (!query.ok) {
      return;
    }
    expect(query.query.since).toBe('30m');
    expect(query.query.limit).toBe(10);
  });

  test('caps --limit at the hard maximum', () => {
    const parsed = parseArgs(['api', '--limit=99999']);
    const query = toQuery(parsed);
    expect(query.ok).toBe(true);
    if (!query.ok) {
      return;
    }
    expect(query.query.limit).toBe(500);
  });

  test('rejects an unknown flag rather than ignoring it', () => {
    const parsed = parseArgs(['api', '--nope']);
    expect(parsed.errors).toContain('Unknown flag "--nope". Run with --help.');
  });

  test('rejects a flag with a missing value', () => {
    const parsed = parseArgs(['api', '--since']);
    expect(parsed.errors).toContain('--since needs a value.');
  });

  test('rejects an invalid mode, level, source and limit', () => {
    expect(toQuery(parseArgs(['api', '--mode', 'prod'])).ok).toBe(false);
    expect(toQuery(parseArgs(['api', '--level', 'LOUD'])).ok).toBe(false);
    expect(toQuery(parseArgs(['api', '--source', 'satellite'])).ok).toBe(false);
    expect(toQuery(parseArgs(['api', '--limit', '0'])).ok).toBe(false);
  });

  test('rejects a second positional argument', () => {
    expect(parseArgs(['api', 'client']).errors).toHaveLength(1);
  });
});
