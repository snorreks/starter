// packages/shared/logger/src/lib/browser_logger.ts
//
// Browser logger: console rendering plus optional forwarding of structured
// events to the API's telemetry endpoint.
//
// Forwarding is opt-in and explicitly *not* a server log. A browser event only
// exists on the provider once a forwarder accepted and stored it, and until a
// deployment enables forwarding there is nothing to query. The `logs` registry
// encodes that, so `bun run logs client --mode staging` reports
// `capability_unsupported` rather than pretending the data is there.

import type { LogEvent, LogLevel, LogSink } from '@starter/schemas/logging';
import { ConsoleLogger } from './console_logger.ts';
import { type LogContext, toLogEvent } from './event_log.ts';

export interface TelemetryTransport {
  send(event: LogEvent): void;
}

export type BrowserLoggerOptions = LogContext & {
  logLevel?: LogLevel;
  silent?: boolean;
  /** Extra sinks (e.g. the local NDJSON file). */
  sinks?: readonly LogSink[];
  transport?: TelemetryTransport;
  /** Flush at most this many queued events per tick. */
  batchSize?: number;
};

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 25;

export class BrowserLogger extends ConsoleLogger {
  readonly #transport: TelemetryTransport | undefined;
  readonly #batchSize: number;
  #queue: LogEvent[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: BrowserLoggerOptions) {
    super(options, { logLevel: options.logLevel, silent: options.silent });
    for (const sink of options.sinks ?? []) {
      this.addSink(sink);
    }
    this.#transport = options.transport;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#timer = setInterval(() => this.flush(), DEFAULT_FLUSH_INTERVAL_MS);
  }

  override write(entry: Parameters<ConsoleLogger['write']>[0], ...data: unknown[]): void {
    super.write(entry, ...data);
    if (!this.willLog(entry)) {
      return;
    }

    // Recursion guard: a transport that throws must not produce new log events.
    this.#queue.push(toLogEvent(entry, this.context, ...data));
    if (this.#queue.length >= this.#batchSize) {
      this.flush();
    }
  }

  /** Send everything queued. Never throws. */
  flush(): void {
    if (!this.#transport || this.#queue.length === 0) {
      return;
    }

    const batch = this.#queue.splice(0, this.#batchSize);
    try {
      for (const event of batch) {
        this.#transport.send(event);
      }
    } catch {
      this.#queue = [];
    }
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.flush();
  }

  /** Events captured so far; used by the browser telemetry tests. */
  pending(): LogEvent[] {
    return [...this.#queue];
  }
}
