// packages/shared/logger/src/lib/structured_output.ts
//
// The two destinations a server record has, and the reason they are emitters
// rather than a `ConsoleLogger` flag.
//
// The defect this file exists for: in workerd, `buildRequestContext` built a
// logger with `silent: true` and registered no sink. `silent` means "do not render
// to the console" — it does not mean "the platform will capture it for you". In a
// Worker there is no stdout to redirect and no other destination, so every record
// was formatted, dispatched to zero sinks, and dropped. The function still returned
// a well-typed logger, and the deployed site looked healthy.
//
// So the destination is an explicit object with one job: take a record and put
// exactly one structured line somewhere the operator can read it.
//
//   * `createStructuredConsoleEmitter` — one JSON object per record, through the
//     console method for its level. That is what `wrangler tail`, Workers Logs and
//     Logpush index. The level has to reach the right method: a record that always
//     arrives as `info` makes an error page unfindable.
//   * `createNdjsonStdoutEmitter` — one JSON object per line on `process.stdout`,
//     which is what `bun run dev` redirects into `.wrangler/logs/app.ndjson` and
//     what `bun run logs web --mode local` reads.
//
// Both normalize through `toLogEvent`, so redaction and depth/size bounds apply on
// every path and no sink can become the leak. Both are sinks, so `createLogger`
// dispatches to them and the logger owns level filtering.
//
// Neither throws. A record that cannot be written is a missing record, and a
// logging failure must never be the error a request reports.

import type { LogEntry, LogEvent, LogLevel, LogSink } from '@starter/schemas/logging';
import { LogLevelIndex, LogLevelPriority } from '@starter/schemas/logging';
import { type LogContext, toLogEvent } from './event_log.ts';

/**
 * A destination for already-normalized structured records.
 *
 * `recordEvent` is what lets a server store a *forwarded* client record — one that
 * already has its own source, release and payload — without rebuilding it through
 * the server's context and losing the distinction between "this Worker said this"
 * and "a browser said this and we accepted it".
 */
export interface StructuredEmitter extends LogSink {
  readonly name: string;
  /** The server context stamped onto records that do not carry their own. */
  readonly context: LogContext;
  /** Normalize an entry with this emitter's context, then emit it once. */
  emit(entry: LogEntry, ...data: unknown[]): void;
  /** Emit a record whose fields are already decided. */
  recordEvent(event: LogEvent): void;
}

/** The console surface an emitter writes to. Injected so a test can observe it. */
export interface ConsoleTarget {
  debug(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
}

export interface StructuredEmitterOptions {
  /** Lowest level that is emitted. Defaults to emitting everything. */
  logLevel?: LogLevel;
  /**
   * Correlation id stamped on records that do not carry one.
   *
   * Set by a request's emitter, because forgetting `traceId` at a call site is the
   * kind of omission that only shows up later, as records that cannot be joined to
   * the request that produced them. A record that has its own id keeps it.
   */
  traceId?: string;
}

/**
 * Would this record be emitted at this emitter's level?
 *
 * The configured level is the lowest severity emitted, so the entry's own severity
 * decides — the same rule `BaseLoggerService.willLog` applies, and the same reason:
 * comparing the other way round suppresses the records the level exists to keep.
 */
const passesLevel = (level: LogLevel, minimum: LogLevel | undefined): boolean => {
  if (minimum === undefined) {
    return true;
  }
  if (minimum === 'NONE') {
    return false;
  }
  return LogLevelPriority[LogLevelIndex[level]] >= LogLevelPriority[LogLevelIndex[minimum]];
};

/** Fill in the emitter's trace id, if the record has none of its own. */
const stampTrace = (event: LogEvent, traceId: string | undefined): LogEvent =>
  traceId === undefined || event.traceId !== undefined ? event : { ...event, traceId };

/**
 * Serialize one record, once.
 *
 * A record that cannot be serialized is replaced by a minimal one that says so,
 * because a circular payload in a log call would otherwise be an unhandled throw
 * inside whatever request made it.
 */
const serialize = (event: LogEvent): string => {
  try {
    return JSON.stringify(event);
  } catch {
    return JSON.stringify({
      timestamp: event.timestamp,
      app: event.app,
      environment: event.environment,
      source: event.source,
      level: event.level,
      event: event.event,
      release: event.release,
      message: 'A log record could not be serialized.',
      data: { serialization: 'failed' },
    });
  }
};

/**
 * One structured record per event, through the platform console.
 *
 * A single string argument, not an interpolated message: the provider parses each
 * console call as one message, and a record spread over several arguments is one it
 * cannot group or filter by level.
 */
export const createStructuredConsoleEmitter = (
  context: LogContext,
  options: StructuredEmitterOptions & { target?: ConsoleTarget } = {},
): StructuredEmitter => {
  const target = options.target ?? (globalThis.console as unknown as ConsoleTarget);

  const recordEvent = (event: LogEvent): void => {
    if (!passesLevel(event.level, options.logLevel)) {
      return;
    }
    const line = serialize(stampTrace(event, options.traceId));
    try {
      switch (event.level) {
        case 'ERROR':
          target.error(line);
          return;
        case 'WARNING':
          target.warn(line);
          return;
        case 'DEBUG':
          target.debug(line);
          return;
        default:
          target.info(line);
      }
    } catch {
      // A console that refuses is a missing record, not a failed request.
    }
  };

  return {
    name: 'structured-console',
    context,
    write(entry: LogEntry, ...data: unknown[]): void {
      recordEvent(toLogEvent(entry, context, ...data));
    },
    emit(entry: LogEntry, ...data: unknown[]): void {
      recordEvent(toLogEvent(entry, context, ...data));
    },
    recordEvent,
  };
};

/** Where a line goes. Injected so a test can observe it without a terminal. */
export type LineWriter = (line: string) => void;

export interface NdjsonEmitterOptions extends StructuredEmitterOptions {
  /** Defaults to `process.stdout.write`. */
  write?: LineWriter;
}

const stdoutWriter = (): LineWriter => {
  const stdout = (globalThis as { process?: { stdout?: { write?: (chunk: string) => unknown } } })
    .process?.stdout;
  return (line: string) => {
    stdout?.write?.(line);
  };
};

/**
 * One NDJSON line per record on stdout.
 *
 * `bun run dev` redirects this stream into `.wrangler/logs/app.ndjson`, and the
 * log CLI parses those lines with the same schema the provider indexes remotely.
 * A human-formatted console line in the same stream would be a second record with
 * a different shape, which is why the server logger renders nothing itself and
 * emits only through one of these.
 */
export const createNdjsonStdoutEmitter = (
  context: LogContext,
  options: NdjsonEmitterOptions = {},
): StructuredEmitter => {
  const write = options.write ?? stdoutWriter();

  const recordEvent = (event: LogEvent): void => {
    if (!passesLevel(event.level, options.logLevel)) {
      return;
    }
    try {
      write(`${serialize(stampTrace(event, options.traceId))}\n`);
    } catch {
      // Same rule as the console emitter: never the reported error.
    }
  };

  return {
    name: 'ndjson-stdout',
    context,
    write(entry: LogEntry, ...data: unknown[]): void {
      recordEvent(toLogEvent(entry, context, ...data));
    },
    emit(entry: LogEntry, ...data: unknown[]): void {
      recordEvent(toLogEvent(entry, context, ...data));
    },
    recordEvent,
  };
};
