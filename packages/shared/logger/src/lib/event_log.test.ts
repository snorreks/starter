// packages/shared/logger/src/lib/event_log.test.ts
//
// Event shape, level filtering, sinks and timing.
//
// `toLogEvent` is the single place a `LogEntry` becomes the structured event
// every other consumer reads: the log CLI, the telemetry endpoint, the tests.
// A field renamed or dropped here is invisible everywhere at once, so the shape
// is pinned rather than assumed.

import { describe, expect, test } from 'bun:test';
import { LOG_LEVELS, type LogEntry, type LogEvent } from '@starter/schemas/logging';
import { toLogEvent, resolveRelease, type LogContext } from './event_log.ts';
import { MemoryLogSink } from './memory_sink.ts';
import { Timer } from './timer.ts';

const context: LogContext = {
  app: 'api',
  environment: 'local',
  source: 'worker',
  release: 'test',
};

const entry = (overrides: Partial<LogEntry> = {}): LogEntry => ({
  logLevel: 'INFO',
  logType: 'info',
  message: 'hello',
  ...overrides,
});

describe('resolveRelease', () => {
  test('uses an injected build id', () => {
    expect(resolveRelease('a1b2c3d')).toBe('a1b2c3d');
  });

  test('falls back to dev when nothing was injected', () => {
    expect(resolveRelease()).toBe('dev');
    expect(resolveRelease('')).toBe('dev');
    expect(resolveRelease('   ')).toBe('dev');
  });

  test('trims, so a build step cannot produce " abc " as a release id', () => {
    expect(resolveRelease('  a1b2c3d  ')).toBe('a1b2c3d');
  });
});

describe('toLogEvent', () => {
  test('carries the context onto every event', () => {
    const event = toLogEvent(entry(), context);

    expect(event.app).toBe('api');
    expect(event.environment).toBe('local');
    expect(event.source).toBe('worker');
    expect(event.release).toBe('test');
  });

  test('stamps a timestamp', () => {
    const before = Date.now();
    const event = toLogEvent(entry(), context);

    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(Date.now());
  });

  test('preserves the level and message', () => {
    const event = toLogEvent(entry({ logLevel: 'ERROR', logType: 'error', message: 'boom' }), context);

    expect(event.level).toBe('ERROR');
    expect(event.message).toContain('boom');
  });

  test('redacts a secret passed as structured data', () => {
    // The path that matters: a caller logging `{ password }` must not leak it
    // just because it used the structured form instead of a string.
    const event = toLogEvent(entry({ message: 'sign in' }), context, { password: 'hunter2' });

    expect(event.message).not.toContain('hunter2');
    expect(event.message).toContain('[redacted]');
  });

  test('appends string data as-is, so a message reads naturally', () => {
    const event = toLogEvent(entry({ message: 'note created' }), context, 'note_1');

    expect(event.message).toContain('note_1');
  });

  test('skips undefined data rather than printing "undefined"', () => {
    const event = toLogEvent(entry({ message: 'x' }), context, undefined, 'y');

    expect(event.message).not.toContain('undefined');
    expect(event.message).toContain('y');
  });

  test('survives a cyclic payload without throwing', () => {
    // A telemetry endpoint that crashes on its input turns a client bug into a
    // server outage.
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    expect(() => toLogEvent(entry(), context, cyclic)).not.toThrow();
  });

  test('honours caller-supplied redaction keys', () => {
    const scoped: LogContext = { ...context, extraRedactedKeys: ['userPin'] };
    const event = toLogEvent(entry(), scoped, { userPin: '4821' });

    expect(event.message).not.toContain('4821');
  });

  test('produces JSON-serializable output for every level', () => {
    // `console.log` in a Worker receives the object; an unserializable field
    // would show up as `[object Object]` in the captured stream.
    for (const level of LOG_LEVELS) {
      const event = toLogEvent(entry({ logLevel: level }), context, { detail: 1 });
      expect(JSON.parse(JSON.stringify(event))).toMatchObject({ level, app: 'api' });
    }
  });
});

describe('MemoryLogSink', () => {
  /** An event whose `message` is the given string. */
  const makeEvent = (message: string): LogEvent =>
    toLogEvent(entry({ message }), context) as LogEvent;

  const messagesOf = (events: readonly LogEvent[]): (string | undefined)[] =>
    events.map((event) => event.message);

  test('keeps events in arrival order', () => {
    const sink = new MemoryLogSink();
    sink.record(makeEvent('first'));
    sink.record(makeEvent('second'));

    expect(messagesOf(sink.snapshot())).toEqual(['first', 'second']);
  });

  test('evicts the oldest once capacity is exceeded', () => {
    // A bounded ring, not an unbounded array: a long-running Worker that logs
    // every request would otherwise grow without limit.
    const sink = new MemoryLogSink(3);
    for (const message of ['a', 'b', 'c', 'd', 'e']) {
      sink.record(makeEvent(message));
    }

    expect(messagesOf(sink.snapshot())).toEqual(['c', 'd', 'e']);
  });

  test('recent returns newest first', () => {
    const sink = new MemoryLogSink();
    sink.record(makeEvent('old'));
    sink.record(makeEvent('new'));

    expect(messagesOf(sink.recent())).toEqual(['new', 'old']);
  });

  test('recent respects its limit', () => {
    const sink = new MemoryLogSink();
    for (const message of ['a', 'b', 'c']) {
      sink.record(makeEvent(message));
    }

    expect(messagesOf(sink.recent(2))).toEqual(['c', 'b']);
  });

  test('snapshot returns a copy, so a caller cannot mutate the ring', () => {
    const sink = new MemoryLogSink();
    sink.record(makeEvent('real'));

    sink.snapshot().push(makeEvent('injected'));

    expect(sink.snapshot()).toHaveLength(1);
  });

  test('clear empties the ring', () => {
    const sink = new MemoryLogSink();
    sink.record(makeEvent('x'));

    sink.clear();

    expect(sink.snapshot()).toEqual([]);
    expect(sink.recent()).toEqual([]);
  });

  test('write is a no-op, so a sink is always callable', () => {
    // The LogSink interface requires it; the ring is fed by `record`. If `write`
    // silently dropped events, a caller using the interface path would see an
    // empty log and no error.
    const sink = new MemoryLogSink();
    expect(() => sink.write()).not.toThrow();
  });
});

describe('Timer', () => {
  test('reports elapsed time and freezes it at end()', () => {
    const timer = new Timer();
    expect(timer.elapsedMs).toBeGreaterThanOrEqual(0);

    const elapsed = timer.end();

    expect(elapsed).toBeGreaterThanOrEqual(0);
    // A timer that kept counting after end() would report a request's duration
    // as however long you happened to look at it.
    expect(timer.elapsedMs).toBe(elapsed);
  });

  test('reset restarts measurement', () => {
    const timer = new Timer();
    timer.end();

    timer.reset();

    expect(timer.elapsedMs).toBeLessThan(1_000);
  });
});