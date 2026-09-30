// packages/shared/logger/src/lib/file_sink.ts
//
// Node-only: appends NDJSON to a file.
//
// Kept out of the package barrel on purpose — see src/index.ts.
//
// A **browser cannot write a local file**, which is worth stating plainly
// because it is easy to assume otherwise. Local capture for browser events
// therefore works like this:
//
//     browser  --POST /api/telemetry-->  Worker (wrangler dev)
//                                          |
//                                    stdout, redirected by
//                                    \`bun run dev:api\` into
//                                    /tmp/starter-logs/api.ndjson
//
// and `bun run logs --mode local` reads that file. This sink is for *Node-side*
// producers — the CLI, tests, scripts.

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

    // Serialized through a promise chain: concurrent appends to one descriptor
    // interleave and produce un-parseable lines, which would turn a diagnostic
    // tool into a source of misleading evidence.
    this.#queue = this.#queue.then(async () => {
      if (this.#failed) {
        return;
      }
      try {
        await mkdir(dirname(this.#path), { recursive: true });
        await appendFile(this.#path, line, 'utf8');
      } catch {
        // A failing log sink must never become a request failure. Stop trying,
        // so the failure cannot escalate into repeated write attempts.
        this.#failed = true;
      }
    });
  }

  /** Resolve once every queued write has settled. */
  async flush(): Promise<void> {
    await this.#queue;
  }

  /** Parse NDJSON, tolerating a truncated final line. */
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
        // Expected while a producer is still writing.
      }
    }
    return events;
  }
}
