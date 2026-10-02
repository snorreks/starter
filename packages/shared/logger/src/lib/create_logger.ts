// packages/shared/logger/src/lib/create_logger.ts
//
// Factory for the app's logger singleton. Exists so that context (app,
// environment, release, source) is established in exactly one place and every
// consumer gets the same sinks.
//
// What this factory does **not** do, stated here because it was load-bearing and
// wrong once: it adds no implicit platform destination. `silent` suppresses the
// human-formatted console render and nothing else — it is not "structured output
// is handled elsewhere", and a logger built with `silent: true` and no sinks emits
// nowhere at all. In workerd that combination meant every record was silently
// dropped while the application looked healthy. A server logger that has to reach
// the platform console says so explicitly: register a structured emitter from
// `structured_output.ts` as a sink, and render nothing itself.

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
  // A caller who asks for silence *and* registers no sink has asked for a logger
  // that goes nowhere. That combination was the workerd defect, so it is refused
  // here rather than discovered later as missing logs in production: the one
  // caller that genuinely wants it is a test, and it can pass a memory sink.
  if (
    options.silent === true &&
    (options.sinks === undefined || options.sinks.length === 0) &&
    options.memory === undefined
  ) {
    throw new Error(
      'createLogger was asked to be silent with no sink to emit to. A silent logger ' +
        'with no destination drops every record. Register a sink (for example ' +
        'createStructuredConsoleEmitter or createNdjsonStdoutEmitter), or pass a memory ' +
        'sink if silence is genuinely the intent.',
    );
  }
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
