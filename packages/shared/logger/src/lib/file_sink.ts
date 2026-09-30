// packages/shared/logger/src/lib/file_sink.ts
//
// Appends NDJSON to a file. This is the local capture path that
// `bun run logs --mode local` reads.
//
// Writes are serialized through a promise chain: concurrent appends to the same
// descriptor interleave and produce un-parseable lines, which would turn a
// diagnostic tool into a source of misleading evidence.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LogEvent, LogSink } from '@starter/schemas/logging';

export class NdjsonFileSink implements LogSink {
  readonly name = 'ndjson-file';
  readonly #path: string;
  #queue: Promise<void> = Promise.resolve();
  #failed = false;

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  write(entry: unknown): void {
    const line = `${JSON.stringify(entry)}\n`;
    this.#queue = this.#queue.then(async () => {
      if (this.#failed) {
        return;
      }
      try {
        await mkdir(dirname(this.#path), { recursive: true });
        await appendFile(this.#path, line, 'utf8');
      } catch {
        // A failing log sink must never become a request failure. Stop trying so
        // the failure cannot escalate into repeated write attempts.
        this.#failed = true;
      }
    });
  }

  /** Resolve once every queued write has settled. */
  async flush(): Promise<void> {
    await this.#queue;
  }

  static parseNdjson(contents: string): LogEvent[] {
    const events: LogEvent[] = [];
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        events.push(JSON.parse(trimmed) as LogEvent);
      } catch {
        // A truncated final line is expected while a process is still writing.
      }
    }
    return events;
  }
}
