// packages/shared/logger/src/lib/create_logger.ts
//
// Factory for the app's logger singleton. Exists so that context (app,
// environment, release, source) is established in exactly one place and every
// consumer gets the same sinks.

import type { LogEvent, LogLevel, LogSink } from '@starter/schemas/logging';
import { ConsoleLogger } from './console_logger.ts';
import { type LogContext, toLogEvent } from './event_log.ts';
import { MemoryLogSink } from './memory_sink.ts';

/** A logger plus the structured event it produced, for sinks that need both. */
export type StructuredSink = LogSink & {
  recordEvent(event: LogEvent): void;
};

export const createMemorySink = (capacity?: number): MemoryLogSink => new MemoryLogSink(capacity);

export type CreateLoggerOptions = LogContext & {
  logLevel?: LogLevel;
  silent?: boolean;
  sinks?: readonly LogSink[];
  /** Also record into an in-memory ring (tests, local inspection). */
  memory?: MemoryLogSink;
};

export const createLogger = (options: CreateLoggerOptions): ConsoleLogger => {
  const memory = options.memory;
  const logger = new ConsoleLogger(options, {
    logLevel: options.logLevel,
    silent: options.silent,
  });

  if (memory) {
    // Bridge: the console logger owns event normalization, the ring just stores.
    const original = logger.write.bind(logger);
    logger.write = (entry, ...data) => {
      original(entry, ...data);
      if (logger.willLog(entry)) {
        memory.record(toLogEvent(entry, options, ...data));
      }
    };
  }

  for (const sink of options.sinks ?? []) {
    logger.addSink(sink);
  }

  return logger;
};
