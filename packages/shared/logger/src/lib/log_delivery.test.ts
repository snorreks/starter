// packages/shared/logger/src/lib/log_delivery.test.ts
//
// Where a record goes, and which records there are in the first place.
//
// Two defects are pinned here, and both of them are invisible to a test that only
// inspects return values:
//
//   1. **A silent logger with no sink emits nowhere.** `createLogger` built one for
//      workerd — `silent: true`, nothing registered — and every record was dropped
//      after being formatted. The factory now refuses that combination outright.
//   2. **The level filter was inverted.** `configured > entry` meant a logger at the
//      default `INFO` level emitted `DEBUG` and dropped `ERROR`. A deployed Worker
//      at its default level reported almost nothing, and the records that did appear
//      were the ones nobody was looking for.
//
// The level table is asserted as a table, not as two examples, because an inverted
// comparison and an off-by-one both pass a spot check that only uses INFO.

import { describe, expect, test } from 'bun:test';
import type { LogEntry, LogEvent, LogLevel } from '@starter/schemas/logging';
import { ConsoleLogger } from './console_logger.ts';
import { createLogger, createMemorySink } from './create_logger.ts';
import { type LogContext, toLogEvent } from './event_log.ts';
import {
  type ConsoleTarget,
  createNdjsonStdoutEmitter,
  createStructuredConsoleEmitter,
} from './structured_output.ts';

const context: LogContext = {
  app: 'web',
  environment: 'staging',
  source: 'worker',
  release: 'abc1234',
};

const entry = (overrides: Partial<LogEntry> = {}): LogEntry => ({
  logLevel: 'INFO',
  logType: 'info',
  event: 'notes.create',
  ...overrides,
});

/** A console that records which method was called and with what. */
const recordingConsole = (): {
  target: ConsoleTarget;
  calls: { method: string; line: string }[];
} => {
  const calls: { method: string; line: string }[] = [];
  const record =
    (method: string) =>
    (...data: unknown[]): void => {
      calls.push({ method, line: String(data[0]) });
    };

  return {
    calls,
    target: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
  };
};

describe('the factory refuses a logger that goes nowhere', () => {
  test('a silent logger with no sink and no memory sink is refused', () => {
    expect(() => createLogger({ ...context, silent: true })).toThrow(/silent/);
    expect(() => createLogger({ ...context, silent: true, sinks: [] })).toThrow(/no sink/);
  });

  test('a silent logger with a destination is fine', () => {
    const { target } = recordingConsole();
    const logger = createLogger({
      ...context,
      silent: true,
      sinks: [createStructuredConsoleEmitter(context, { target })],
    });
    expect(logger).toBeInstanceOf(ConsoleLogger);
  });

  test('a silent logger with a memory sink is fine, because a test asked for it', () => {
    const memory = createMemorySink();
    const logger = createLogger({ ...context, silent: true, memory });
    logger.write(entry());

    // The ring is the destination, so the record is observable — which is what
    // makes this the honest exception to the refusal above.
    expect(memory.snapshot()).toHaveLength(1);
  });
});

describe('the configured level is the lowest severity emitted', () => {
  const loggerAt = (logLevel: LogLevel): ConsoleLogger =>
    new ConsoleLogger(context, { logLevel, silent: true });

  const accepted: [LogLevel, LogLevel, boolean][] = [
    // configured, entry, emitted
    ['INFO', 'DEBUG', false],
    ['INFO', 'INFO', true],
    ['INFO', 'WARNING', true],
    ['INFO', 'ERROR', true],
    ['DEBUG', 'DEBUG', true],
    ['WARNING', 'INFO', false],
    ['WARNING', 'WARNING', true],
    ['ERROR', 'WARNING', false],
    ['ERROR', 'ERROR', true],
    ['NONE', 'ERROR', false],
  ];

  for (const [configured, entryLevel, emitted] of accepted) {
    test(`at ${configured}, a ${entryLevel} record is ${emitted ? 'emitted' : 'dropped'}`, () => {
      expect(loggerAt(configured).willLog({ logLevel: entryLevel, logType: 'info' })).toBe(emitted);
    });
  }
});

describe('the console emitter', () => {
  test('writes exactly one JSON object per record, through the level’s method', () => {
    const { calls, target } = recordingConsole();
    const emitter = createStructuredConsoleEmitter(context, { target });
    emitter.emit(entry({ message: 'created' }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('info');

    const event = JSON.parse(calls[0]?.line ?? '') as LogEvent;
    expect(event.event).toBe('notes.create');
    expect(event.environment).toBe('staging');
    expect(event.release).toBe('abc1234');
  });

  test('an error reaches the error method, because that is what a filter uses', () => {
    const { calls, target } = recordingConsole();
    const emitter = createStructuredConsoleEmitter(context, { target });
    emitter.emit(entry({ logLevel: 'ERROR', logType: 'error', event: 'notes.update' }));

    expect(calls[0]?.method).toBe('error');
    expect((JSON.parse(calls[0]?.line ?? '') as LogEvent).level).toBe('ERROR');
  });

  test('a warning reaches warn', () => {
    const { calls, target } = recordingConsole();
    createStructuredConsoleEmitter(context, { target }).emit(
      entry({ logLevel: 'WARNING', logType: 'warn' }),
    );
    expect(calls[0]?.method).toBe('warn');
  });

  test('respects the configured level', () => {
    const { calls, target } = recordingConsole();
    createStructuredConsoleEmitter(context, { target, logLevel: 'WARNING' }).emit(
      entry({ logLevel: 'INFO', logType: 'info' }),
    );
    createStructuredConsoleEmitter(context, { target, logLevel: 'WARNING' }).emit(
      entry({ logLevel: 'ERROR', logType: 'error' }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('error');
  });

  test('redacts before the record is written', () => {
    const { calls, target } = recordingConsole();
    createStructuredConsoleEmitter(context, { target }).emit(entry(), {
      password: 'hunter2',
      noteId: 'nt_1',
    });

    expect(calls[0]?.line).not.toContain('hunter2');
    expect(calls[0]?.line).toContain('[redacted]');
  });

  test('stamps its trace id on records that have none, and never overwrites one', () => {
    const { calls, target } = recordingConsole();
    const emitter = createStructuredConsoleEmitter(context, { target, traceId: 'tr_1' });

    emitter.emit(entry());
    emitter.recordEvent({ ...toLogEvent(entry(), context), traceId: 'tr_own' });

    expect((JSON.parse(calls[0]?.line ?? '') as LogEvent).traceId).toBe('tr_1');
    expect((JSON.parse(calls[1]?.line ?? '') as LogEvent).traceId).toBe('tr_own');
  });

  test('a console that throws costs the record, not the caller', () => {
    const exploding: ConsoleTarget = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => {
        throw new Error('console is gone');
      },
    };
    const emitter = createStructuredConsoleEmitter(context, { target: exploding });

    expect(() => emitter.emit(entry({ logLevel: 'ERROR', logType: 'error' }))).not.toThrow();
  });

  test('a record that cannot be serialized is replaced, not thrown', () => {
    const { calls, target } = recordingConsole();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const emitter = createStructuredConsoleEmitter(context, { target });
    emitter.recordEvent({
      ...toLogEvent(entry(), context),
      data: { circular },
    });

    expect(calls).toHaveLength(1);
    expect((JSON.parse(calls[0]?.line ?? '') as LogEvent).data).toEqual({
      serialization: 'failed',
    });
  });
});

describe('the NDJSON emitter', () => {
  test('writes one line per record, and nothing else', () => {
    const lines: string[] = [];
    const emitter = createNdjsonStdoutEmitter(context, { write: (line) => lines.push(line) });

    emitter.emit(entry({ message: 'one' }));
    emitter.emit(entry({ message: 'two' }));

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      // One line per record is the whole contract: a pretty-printed JSON record
      // would make the file unparseable and `bun run logs` would find nothing.
      expect(line.split('\n')).toHaveLength(2);
      expect(JSON.parse(line)).toBeDefined();
    }
  });

  test('a throwing writer costs the record, not the caller', () => {
    const emitter = createNdjsonStdoutEmitter(context, {
      write: () => {
        throw new Error('stdout closed');
      },
    });
    expect(() => emitter.emit(entry())).not.toThrow();
  });
});

describe('a record written through a logger reaches one destination once', () => {
  test('silent plus one emitter emits one record, not a console line and a line', () => {
    const { calls, target } = recordingConsole();
    const lines: string[] = [];

    const logger = createLogger({
      ...context,
      logLevel: 'INFO',
      silent: true,
      sinks: [
        createStructuredConsoleEmitter(context, { target }),
        // A second destination is the caller's choice and would duplicate; the point
        // is that the *logger* adds none of its own.
        createNdjsonStdoutEmitter(context, { write: (line) => lines.push(line) }),
      ],
    });

    logger.write(entry());

    expect(calls).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });
});
