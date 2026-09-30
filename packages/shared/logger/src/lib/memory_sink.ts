// packages/shared/logger/src/lib/memory_sink.ts
//
// Bounded in-memory ring of recent structured events.
//
// This is what makes `bun run logs client --mode local` and the browser
// telemetry test possible without any external service: local dev processes
// write NDJSON *and* keep a ring, and the ring is what a test asserts against.

import type { LogEvent, LogSink } from '@starter/schemas/logging';

export class MemoryLogSink implements LogSink {
  readonly name = 'memory';
  readonly #capacity: number;
  #events: LogEvent[] = [];

  constructor(capacity = 500) {
    this.#capacity = capacity;
  }

  write(): void {
    // Overridden below via `record`; kept for interface conformance.
  }

  record(event: LogEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.#capacity) {
      this.#events.splice(0, this.#events.length - this.#capacity);
    }
  }

  /** A copy, so a caller cannot mutate the ring. */
  snapshot(): LogEvent[] {
    return [...this.#events];
  }

  /** Newest first. */
  recent(limit = 50): LogEvent[] {
    return this.#events.slice(-limit).reverse();
  }

  clear(): void {
    this.#events = [];
  }
}
