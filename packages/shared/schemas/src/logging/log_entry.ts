// packages/shared/schemas/src/logging/log_entry.ts
//
// Internal logger plumbing types. `LogEntry` is what a producer hands to a sink;
// `LogEvent` (log_event.ts) is the normalized shape once an environment/release
// have been attached. Keeping them separate means a bare `console`-style call
// site never has to invent a release string.

import type { LogEvent } from './log_event.ts';
import type { LogLevel } from './log_event.ts';

export type LogType = 'log' | 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
  logLevel: LogLevel;
  logType: LogType;
  /** Optional already-formatted message. */
  message?: string;
  /** Structured event name; when absent, derived from `logType`. */
  event?: string;
  /** Correlation identifiers supplied by the call site. */
  traceId?: string;
  requestId?: string;
  userId?: string;
  sessionId?: string;
  /** Field names that must be redacted before this entry leaves the process. */
  redactedKeys?: readonly string[];
};

/** A destination for log entries. Implementations must never throw. */
export interface LogSink {
  readonly name: string;
  write(entry: LogEntry, ...data: unknown[]): void | Promise<void>;
  /** Called once when the logger is reconfigured or the process shuts down. */
  flush?(): void | Promise<void>;
}

export interface TimerInterface {
  readonly elapsedMs: number;
  end(): number;
  reset(): void;
}

export interface LoggerInterface {
  logLevel: LogLevel;
  setLogLevel(logLevel: LogLevel): void;
  addSink(sink: LogSink): void;
  log(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Content-deduplicated logging for high-frequency call sites. */
  spam(id: string, ...args: unknown[]): void;
  write(entry: LogEntry, ...data: unknown[]): void;
  createTimer(): TimerInterface;
}

/** Result of a bounded log query. Explicit statuses instead of empty guesses. */
export type LogQueryStatus =
  | 'ok'
  | 'no_matches'
  | 'credentials_unavailable'
  | 'capability_unsupported'
  | 'retrieval_failed'
  | 'unavailable';

export type LogQueryResult = {
  status: LogQueryStatus;
  events: LogEvent[];
  /** Human-readable explanation. Never contains credential material. */
  message?: string;
  /** Whether more history exists beyond `cursor`. */
  hasMore?: boolean;
  cursor?: string;
  /** True when a live tail is currently attached. */
  following?: boolean;
  /** Human-readable notes about retention, sampling or truncation. */
  limitations?: string[];
};
