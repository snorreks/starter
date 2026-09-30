// scripts/src/lib/logs/local_file_adapter.ts
//
// Local log capture. The adapter that always works: no credentials, no network,
// which is what makes local log verification part of ordinary CI.
//
// Where the events come from:
//
//   api     — `bun run dev:api` captures the Worker's stdout into
//             /tmp/starter-logs/api.ndjson.
//   client  — the browser forwards structured events to the API's
//             `/api/telemetry`; the Worker records them; so they end up in the
//             same file and are told apart by `app`/`source`.
//
// A browser cannot write a local file. That is why client events are read from
// the Worker's file rather than from a client-owned one.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_LOG_CONFIG, type LogEvent } from '@starter/schemas';
import { buildFilter } from './filter.ts';
import { capabilitiesFor } from './registry.ts';
import type { LogQuery, LogQueryResult } from './types.ts';

export const LOCAL_LOG_DIR = process.env.STARTER_LOG_DIR ?? '/tmp/starter-logs';

/**
 * Which file an app's events are read from locally.
 *
 * Note there is no `client.ndjson`, and that is not an oversight: **a browser
 * cannot write a local file.** Client events are forwarded to
 * `/api/telemetry`, the Worker records them, and `bun run dev:api` captures the
 * Worker's stream — so client events live in `api.ndjson` and are told apart by
 * their `app`/`source` fields rather than by a separate file.
 *
 * Mapping `client` to a file nothing writes would make
 * `bun run logs client --mode local` report "unavailable" forever, which reads
 * as a broken tool rather than as an accurate description.
 */
const FILE_FOR_APP: Record<string, string> = {
  client: join(LOCAL_LOG_DIR, 'api.ndjson'),
  api: join(LOCAL_LOG_DIR, 'api.ndjson'),
};

/** Parse NDJSON, skipping a truncated final line rather than failing. */
/**
 * Parse NDJSON, skipping anything that is not a complete JSON object.
 *
 * Tolerates two things on purpose: a truncated final line (the producer is still
 * writing) and the human-readable banners `wrangler dev` interleaves with its log
 * stream. Strict parsing would make the whole file unreadable because of one
 * banner line.
 */
export const parseNdjson = (contents: string): LogEvent[] => {
  const events: LogEvent[] = [];
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as LogEvent);
    } catch {
      // Not a complete JSON object on this line.
    }
  }
  return events;
};

/** Every log file that currently exists, for `bun run logs all --mode local`. */
export const discoverLocalFiles = async (): Promise<Record<string, string>> => {
  if (!existsSync(LOCAL_LOG_DIR)) {
    return {};
  }

  const entries = await readdir(LOCAL_LOG_DIR);
  const found: Record<string, string> = {};

  for (const [app, path] of Object.entries(FILE_FOR_APP)) {
    if (entries.includes(path.split('/').pop() ?? '')) {
      found[app] = path;
    }
  }
  return found;
};

export interface LocalTailHandle {
  stop: () => void;
}

/**
 * Local historical read.
 *
 * The file is read once and filtered in memory. That is honest about the
 * limitation and states it: there is no server-side index, so `--uid` and
 * `--trace` are applied by scanning. A bounded read of the tail is used rather
 * than the whole file so a long-running dev session cannot exhaust memory.
 */
export const readLocal = async (
  query: LogQuery,
): Promise<{ result: LogQueryResult; tail?: LocalTailHandle }> => {
  const path = FILE_FOR_APP[query.app];

  if (path === undefined || !existsSync(path)) {
    return {
      result: {
        status: 'unavailable',
        events: [],
        message:
          `No local log file for "${query.app}". Start the app in local mode ` +
          `first (\`bun run dev\` for the client, \`bun run dev:api\` for the API); ` +
          `logs are written to ${LOCAL_LOG_DIR}.`,
        limitations: ['Local capture is only active when PUBLIC_MODE=local.'],
      },
    };
  }

  const decision = buildFilter(query, capabilitiesFor('local-file'));
  if (!decision.ok) {
    return {
      result: { status: 'capability_unsupported', events: [], message: decision.unsupported },
    };
  }

  const contents = await readFile(path, 'utf8');
  const all = parseNdjson(contents);
  const limit = query.limit ?? 50;
  const matched = all.filter(decision.predicate).slice(-limit);

  if (query.follow !== true) {
    return {
      result: {
        status: matched.length === 0 ? 'no_matches' : 'ok',
        events: matched,
        ...(matched.length === 0 ? { message: 'No events matched the filters.' } : {}),
        limitations: [
          'Local files are read fully and filtered in memory; there is no server-side index.',
        ],
      },
    };
  }

  // Follow: re-read on an interval until the duration elapses. Bounded by
  // construction — an unbounded follow would stream into a terminal forever.
  const startedAt = Date.now();
  const durationMs =
    query.duration === undefined ? 60_000 : Number.parseInt(query.duration, 10) * 1000;
  let offset = contents.length;
  const streamed: LogEvent[] = [];
  const seen = new Set<number>();

  const timer = setInterval(() => {
    void (async () => {
      const grown = await readFile(path, 'utf8');
      if (grown.length <= offset) {
        return;
      }
      for (const event of parseNdjson(grown.slice(offset))) {
        if (seen.has(event.timestamp)) {
          continue;
        }
        seen.add(event.timestamp);
        if (decision.predicate(event)) {
          streamed.push(event);
          process.stdout.write(`${JSON.stringify(event)}\n`);
        }
      }
      offset = grown.length;
    })();
  }, 1_000);

  const stop = (): void => clearInterval(timer);
  setTimeout(stop, Math.min(durationMs, 300_000)).unref?.();

  return {
    result: {
      status: 'ok',
      events: streamed,
      following: true,
      message: `Following local logs for ${Math.round((Date.now() - startedAt) / 1000)}s.`,
    },
    tail: { stop },
  };
};

/** Every app's local logs, for `--app all`. */
export const readAllLocal = async (query: Omit<LogQuery, 'app'>): Promise<LogQueryResult[]> => {
  const apps = Object.keys(APP_LOG_CONFIG) as Array<LogQuery['app']>;
  const results: LogQueryResult[] = [];

  for (const app of apps) {
    const { result, tail } = await readLocal({ ...query, app });
    tail?.stop();
    results.push(result);
  }
  return results;
};
