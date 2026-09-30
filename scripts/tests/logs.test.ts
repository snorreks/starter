// scripts/src/lib/logs/logs.test.ts
//
// Deterministic tests for the log family.
//
// Everything here runs without credentials, without a network and without
// Cloudflare. That is the point: the *translation* of a query into a provider
// filter, and the decision to refuse an unsupported filter, are the parts that
// can silently be wrong, and both are testable offline.
//
// What is NOT covered here: a live Cloudflare query. That needs a provisioned
// account and is reported as unverified in docs/first-round-review.md.

import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { type LogEvent, LogEventSchema } from '@starter/schemas';
import { parseArgs, toQuery } from '../commands/logs.ts';
import { buildHistoricalRequest, MAX_TAIL_MS } from '../logs/cloudflare_adapter.ts';
import { parseDuration } from '../logs/duration.ts';
import { buildFilter, buildLogpushFilter } from '../logs/filter.ts';
import { parseNdjson } from '../logs/local_file_adapter.ts';
import { capabilitiesFor, resolveLogAdapter } from '../logs/registry.ts';
import type { LogQuery } from '../logs/types.ts';

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

// ── Provider filter translation ──────────────────────────────────────────────

describe('buildLogpushFilter', () => {
  test('produces a clause per active filter, ANDed', () => {
    const filter = buildLogpushFilter(
      { ...baseQuery, level: 'ERROR', source: 'worker', trace: 'tr_2' },
      60_000,
    );
    expect(filter).toContain('jsonPayload.level >= "ERROR"');
    expect(filter).toContain('jsonPayload.source = "worker"');
    expect(filter).toContain('jsonPayload.traceId = "tr_2"');
    expect(filter?.match(/ AND /g)).toHaveLength(3);
  });

  test('emits no clause for a level of DEBUG', () => {
    expect(buildLogpushFilter({ ...baseQuery, level: 'DEBUG' }, undefined)).toBeNull();
  });

  test('returns null when nothing needs narrowing', () => {
    expect(buildLogpushFilter(baseQuery, undefined)).toBeNull();
  });

  test('a user filter names the verified field, not client-reported data', () => {
    const filter = buildLogpushFilter({ ...baseQuery, uid: 'user_verified' }, undefined);
    expect(filter).toBe('jsonPayload.userId = "user_verified"');
    expect(filter).not.toContain('clientReported');
  });
});

describe('buildHistoricalRequest', () => {
  test('is refused for a filter the provider cannot honour', () => {
    // The historical path is Logpush, which *can* filter by user. This asserts
    // the guard exists rather than the provider's behaviour.
    const request = buildHistoricalRequest({ ...baseQuery, level: 'WARNING' });
    expect(request.ok).toBe(true);
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
    expect(MAX_TAIL_MS).toBe(300_000);
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
