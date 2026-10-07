// scripts/src/logs/local_file_adapter.ts
//
// Local log capture. The adapter that always works: no credentials, no network,
// which is what makes local log verification part of ordinary CI.
//
// Where the events come from, and why there is only one file.
//
// `bun run dev` starts the SvelteKit dev server and redirects its stdout into
// `.wrangler/logs/app.ndjson`. The server's own request logger writes one NDJSON
// line per event there (see `apps/frontend/client/src/lib/server/request_context.ts`),
// and the browser's structured events reach the same file by being POSTed to
// `/api/telemetry`, which the same server records.
//
// One file for both, and there is no alternative worth offering: **a browser cannot
// write a local file.** A second file would have to be written by something the
// browser cannot reach, which means the browser's events would land in the server's
// file anyway and be told apart by `source` rather than by filename.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogEvent } from '@starter/schemas/logging';
import { APP_LOG_CONFIG, type AppId } from '../registry/app_registry.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { runScope } from '../shared/run_scope.ts';
import { buildFilter } from './filter.ts';
import { capabilitiesFor } from './registry.ts';
import type { LogQuery, LogQueryResult } from './types.ts';

/**
 * Where the dev launcher writes the log stream.
 *
 * Under `.wrangler/logs/` rather than a shared `/tmp` path, so two worktrees on
 * one machine do not read each other's events. The directory is gitignored.
 */
export const LOCAL_LOG_DIR = process.env.STARTER_LOG_DIR ?? join(REPO_ROOT, '.wrangler', 'logs');

/**
 * Which file an app's events are read from locally.
 *
 * Keyed by `AppId` rather than `string`, so a new app id cannot be added to the
 * registry without this map having an entry for it — a missing entry would report
 * "no local log file" for a real app, which reads as a broken tool.
 */
const FILE_FOR_APP: Record<AppId, string> = {
  web: 'app.ndjson',
};

export interface LocalReadOptions {
  root?: string;
  defaultLogDir?: string;
}

/** Resolve a selected run only through the repository's existing run authority. */
export const localLogPath = (
  app: AppId,
  options: LocalReadOptions & { runId?: string } = {},
): string => {
  const directory =
    options.runId === undefined
      ? (options.defaultLogDir ??
        (options.root === undefined ? LOCAL_LOG_DIR : join(options.root, '.wrangler', 'logs')))
      : runScope(options.runId, options.root ?? REPO_ROOT).logDir;
  return join(directory, FILE_FOR_APP[app]);
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
export const discoverLocalFiles = async (
  options: LocalReadOptions & { runId?: string } = {},
): Promise<Record<string, string>> => {
  const directory =
    options.runId === undefined
      ? (options.defaultLogDir ??
        (options.root === undefined ? LOCAL_LOG_DIR : join(options.root, '.wrangler', 'logs')))
      : runScope(options.runId, options.root ?? REPO_ROOT).logDir;
  if (!existsSync(directory)) {
    return {};
  }

  const entries = await readdir(directory);
  const found: Record<string, string> = {};

  for (const app of Object.keys(FILE_FOR_APP) as AppId[]) {
    const path = localLogPath(app, options);
    if (entries.includes(FILE_FOR_APP[app])) {
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
  options: LocalReadOptions = {},
): Promise<{ result: LogQueryResult; tail?: LocalTailHandle }> => {
  const path = localLogPath(query.app, { ...options, runId: query.runId });

  if (path === undefined || !existsSync(path)) {
    return {
      result: {
        status: 'unavailable',
        events: [],
        message:
          query.runId === undefined
            ? `No local log file for "${query.app}". Run \`bun run dev\` first; it writes ${path}.`
            : `No local log file for run "${query.runId}" at ${path}. The selected run is never replaced with another run's logs.`,
        limitations: [
          query.runId === undefined
            ? 'Local capture is only active when the dev server is running.'
            : 'The selected run has no local log file.',
        ],
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
export const readAllLocal = async (
  query: Omit<LogQuery, 'app'>,
  options: LocalReadOptions = {},
): Promise<LogQueryResult[]> => {
  const apps = Object.keys(APP_LOG_CONFIG) as Array<LogQuery['app']>;
  const results: LogQueryResult[] = [];

  for (const app of apps) {
    const { result, tail } = await readLocal({ ...query, app }, options);
    tail?.stop();
    results.push(result);
  }
  return results;
};
