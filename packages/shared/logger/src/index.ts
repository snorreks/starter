// packages/shared/logger/src/index.ts
//
// Structured logging for every plane.
//
// **This barrel is browser-safe.** Everything re-exported here must be
// loadable in a browser bundle with no Node built-ins. `NdjsonFileSink` uses
// `node:fs` and is therefore deliberately NOT exported here — import it from
// `@starter/logger/file` in scripts and tests instead. Leaving it in the barrel
// breaks any browser build that imports the logger, which is every build.
//
// Subpath entrypoints keep the rest of the graph small too: a CLI should not
// pull in the browser forwarder.

export { BaseLoggerService } from './lib/base.ts';
export { BrowserLogger, type BrowserLoggerOptions } from './lib/browser_logger.ts';
export { type TelemetryTransport } from './lib/browser_logger.ts';
export { ConsoleLogger } from './lib/console_logger.ts';
export { createDefaultLogger, getLogger, resetLogger, setLogger } from './lib/default_logger.ts';
export { createLogger, createMemorySink, type CreateLoggerOptions } from './lib/create_logger.ts';
export { type LogContext, resolveRelease, toLogEvent } from './lib/event_log.ts';
export { MemoryLogSink } from './lib/memory_sink.ts';
export {
  DEFAULT_REDACTED_KEYS,
  REDACTED,
  isRedactedKey,
  type RedactOptions,
  redactValue,
} from './lib/redaction.ts';
export {
  createHttpTelemetryTransport,
  type HttpTelemetryTransportOptions,
  type TelemetryPayload,
} from './lib/telemetry_transport.ts';
export { Timer } from './lib/timer.ts';
