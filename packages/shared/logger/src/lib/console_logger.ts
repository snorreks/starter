// packages/shared/logger/src/lib/console_logger.ts
//
// The default logger: a console renderer plus a structured `LogEvent` handed to
// every sink. Used unchanged in the browser, the Worker and the CLI, so local
// output is the same shape the remote adapters parse.

import type { LogEntry, LogLevel } from '@starter/schemas/logging';
import { BaseLoggerService } from './base.ts';
import { type LogContext, toLogEvent } from './event_log.ts';

const LEVEL_STYLE: Record<LogLevel, string> = {
  NONE: '',
  DEBUG: 'color:#64748b',
  INFO: 'color:#0f172a',
  WARNING: 'color:#b45309;font-weight:600',
  ERROR: 'color:#b91c1c;font-weight:600',
};

export class ConsoleLogger extends BaseLoggerService {
  readonly #context: LogContext;
  #silent: boolean;

  constructor(context: LogContext, options?: { logLevel?: LogLevel; silent?: boolean }) {
    super({ logLevel: options?.logLevel });
    this.#context = context;
    this.#silent = options?.silent ?? false;
  }

  /** Suppress console output while keeping sink delivery (used by tests). */
  setSilent(silent: boolean): void {
    this.#silent = silent;
  }

  get context(): LogContext {
    return this.#context;
  }

  write(entry: LogEntry, ...data: unknown[]): void {
    if (!this.willLog(entry)) {
      return;
    }

    if (!this.#silent) {
      const style = LEVEL_STYLE[entry.logLevel] ?? '';
      const body = [entry.message, ...data.filter((value) => value !== undefined)].filter(
        (value) => value !== undefined,
      );

      // Errors and warnings keep the full payload; debug/info are collapsed so
      // the console stays readable at DEBUG in a browser.
      const renderer =
        entry.logLevel === 'ERROR'
          ? console.error
          : entry.logLevel === 'WARNING'
            ? console.warn
            : entry.logLevel === 'DEBUG'
              ? console.debug
              : console.info;

      renderer.call(console, `%c${entry.logLevel}`, style, ...body);
    }

    this.flushSinks(entry, ...data);
  }

  /** Build the structured event for a raw entry (used by structured sinks). */
  toEvent(entry: LogEntry, ...data: unknown[]) {
    return toLogEvent(entry, this.#context, ...data);
  }
}
