// scripts/src/commands/logs.ts
//
// The one log command family.
//
//   bun run logs client --mode local --source browser --level debug
//   bun run logs api --mode staging --since 30m --level error
//   bun run logs all --mode production --trace TRACE_ID --json
//   bun run logs client --mode production --uid USER_ID --since 15m
//   bun run logs api --mode staging --follow --duration 60s
//
// Design rules this implements, all of which exist because their absence caused
// a real problem in the source project:
//
//   * **No silently ignored flags.** Every flag is either applied or produces
//     `capability_unsupported` with a reason. `--uid` against `wrangler tail`
//     is an error, not a full-dump.
//   * **Explicit statuses.** `ok`, `no_matches`, `credentials_unavailable`,
//     `capability_unsupported`, `retrieval_failed`, `unavailable`. A command
//     that finds nothing says so, rather than exiting 0 with empty output.
//   * **Bounded results.** Every path has a limit, and a follow has a duration.
//   * **Log content is data, not instruction.** Events are printed through a
//     renderer that never interpolates them into a prompt.

import { isDeploymentEnvironment, isLogLevel, type LogApp, type LogSource } from '@starter/schemas';
import { APP_LOG_CONFIG, isAppId } from '../registry/app_registry.ts';
import {
  DEFAULT_TAIL_MS,
  MAX_TAIL_MS,
  queryCloudflareHistory,
  tailCloudflare,
} from '../logs/cloudflare_adapter.ts';
import { describeDurationUnits, parseDuration } from '../logs/duration.ts';
import { buildFilter } from '../logs/filter.ts';
import { readAllLocal, readLocal } from '../logs/local_file_adapter.ts';
import { capabilitiesFor, resolveLogAdapter } from '../logs/registry.ts';
import type { FlagDoc, LogQuery, LogQueryResult } from '../logs/types.ts';
import type { Command } from '../shared/command.ts';

const HARD_LIMIT_CAP = 500;

const FLAG_DOCS: readonly FlagDoc[] = [
  {
    flag: '--mode',
    arg: 'local|staging|production',
    description: 'Environment to read. Default: local.',
  },
  { flag: '--level', arg: 'DEBUG|INFO|WARNING|ERROR', description: 'Minimum severity.' },
  {
    flag: '--source',
    arg: 'browser|worker|native|cli',
    description: 'Restrict to a producer source.',
  },
  { flag: '--trace', arg: '<trace-id>', description: 'Correlate to one request.' },
  {
    flag: '--uid',
    arg: '<user-id>',
    description: 'Filter by a server-verified user id.',
    adapters: ['local-file', 'cloudflare-observability'],
  },
  {
    flag: '--since',
    arg: '<duration>',
    description: `How far back to read. Units: ${describeDurationUnits()}.`,
  },
  { flag: '--limit', arg: '<n>', description: 'Maximum events. Default 50, hard cap 500.' },
  { flag: '--follow', arg: '', description: 'Stream live instead of reading history.' },
  {
    flag: '--duration',
    arg: '<duration>',
    description: `Stop following after this long. Default ${DEFAULT_TAIL_MS / 1000}s, max ${MAX_TAIL_MS / 1000}s.`,
  },
  { flag: '--json', arg: '', description: 'Machine-readable output.' },
];

export const helpText = (): string => {
  const lefts = FLAG_DOCS.map((doc) => (doc.arg === '' ? doc.flag : `${doc.flag} ${doc.arg}`));
  const width = Math.min(Math.max(...lefts.map((left) => left.length)) + 2, 42);
  const lines = FLAG_DOCS.map((doc, index) => {
    const left = (lefts[index] ?? doc.flag).padEnd(width);
    const scope = doc.adapters ? `  [${doc.adapters.join(', ')} only]` : '';
    return `  ${left}${doc.description}${scope}`;
  });

  return [
    'Usage: bun run logs <client|api|all> [flags]',
    '',
    'Read structured logs from local capture or Cloudflare.',
    '',
    'Flags:',
    ...lines,
    '',
    'Examples:',
    '  bun run logs client --mode local --source browser --level debug',
    '  bun run logs api --mode staging --since 30m --level error',
    '  bun run logs all --mode production --trace TRACE_ID --json',
    '  bun run logs client --mode production --uid USER_ID --since 15m',
    '  bun run logs api --mode staging --follow --duration 60s',
    '',
    'Notes:',
    '  Browser and native logs are NOT server logs. They only exist in an',
    '  environment where client telemetry forwarding is enabled, and round 1',
    '  does not enable it. `bun run logs client --mode staging` will say so',
    '  rather than pretending otherwise.',
    '  Cloudflare queries need CLOUDFLARE_API_TOKEN or `wrangler login`, and a',
    '  configured Worker name. Until both are present, that path reports',
    '  `credentials_unavailable`.',
  ].join('\n');
};

export interface ParsedArgs {
  app: 'client' | 'api' | 'all' | undefined;
  flags: Map<string, string | true>;
  errors: string[];
}

const VALUE_FLAGS = new Set([
  '--mode',
  '--level',
  '--source',
  '--trace',
  '--uid',
  '--since',
  '--limit',
  '--duration',
]);
const BOOLEAN_FLAGS = new Set(['--follow', '--json', '--help', '-h']);

/** Parse argv. Returns errors instead of exiting so the parser is testable. */
export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const flags = new Map<string, string | true>();
  const errors: string[] = [];
  let app: ParsedArgs['app'];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === undefined) {
      continue;
    }

    if (!token.startsWith('-')) {
      if (app === undefined) {
        app = token as ParsedArgs['app'];
      } else {
        errors.push(`Unexpected argument "${token}".`);
      }
      continue;
    }

    const [flag, inlineValue] = token.split('=', 2) as [string, string | undefined];

    if (VALUE_FLAGS.has(flag)) {
      const value = inlineValue ?? argv[++index];
      if (value === undefined || value.startsWith('-')) {
        errors.push(`${flag} needs a value.`);
        continue;
      }
      flags.set(flag, value);
      continue;
    }

    if (BOOLEAN_FLAGS.has(flag)) {
      flags.set(flag, true);
      continue;
    }

    errors.push(`Unknown flag "${flag}". Run with --help.`);
  }

  return { app, flags, errors };
};

const readString = (flags: Map<string, string | true>, name: string): string | undefined => {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

const readBool = (flags: Map<string, string | true>, name: string): boolean =>
  flags.get(name) === true;

/** Turn argv into a validated `LogQuery`, or report why it cannot. */
export const toQuery = (
  parsed: ParsedArgs,
): { ok: true; query: Omit<LogQuery, 'app'> } | { ok: false; message: string } => {
  if (parsed.errors.length > 0) {
    return { ok: false, message: parsed.errors.join('\n') };
  }

  const mode = readString(parsed.flags, '--mode') ?? 'local';
  if (!isDeploymentEnvironment(mode)) {
    return { ok: false, message: `--mode must be local, staging or production (got "${mode}").` };
  }

  const level = readString(parsed.flags, '--level');
  if (level !== undefined && !isLogLevel(level.toUpperCase())) {
    return { ok: false, message: `--level must be DEBUG, INFO, WARNING, ERROR or NONE.` };
  }

  const source = readString(parsed.flags, '--source');
  const validSources: LogSource[] = ['browser', 'worker', 'native', 'cli'];
  if (source !== undefined && !validSources.includes(source as LogSource)) {
    return { ok: false, message: `--source must be one of ${validSources.join(', ')}.` };
  }

  const limitRaw = readString(parsed.flags, '--limit');
  const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  if (limitRaw !== undefined && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
    return { ok: false, message: '--limit must be a positive number.' };
  }

  const follow = readBool(parsed.flags, '--follow');
  const duration = readString(parsed.flags, '--duration');

  // Parsed here rather than in the adapter so a typo is a usage error at the
  // command line, and so the adapter receives a number it cannot forget to bound.
  let followBudgetMs: number | undefined;
  if (follow) {
    if (duration !== undefined) {
      const parsedDuration = parseDuration(duration);
      if (parsedDuration === null) {
        return {
          ok: false,
          message: `--duration must be a number followed by s, m, h, d or w (got "${duration}").`,
        };
      }
      followBudgetMs = Math.min(parsedDuration.ms, MAX_TAIL_MS);
    }
  }

  return {
    ok: true,
    query: {
      mode,
      ...(level === undefined ? {} : { level: level.toUpperCase() as LogQuery['level'] }),
      ...(source === undefined ? {} : { source: source as LogSource }),
      ...(readString(parsed.flags, '--trace') === undefined
        ? {}
        : { trace: readString(parsed.flags, '--trace') as string }),
      ...(readString(parsed.flags, '--uid') === undefined
        ? {}
        : { uid: readString(parsed.flags, '--uid') as string }),
      ...(readString(parsed.flags, '--since') === undefined
        ? {}
        : { since: readString(parsed.flags, '--since') as string }),
      ...(limit === undefined ? {} : { limit: Math.min(limit, HARD_LIMIT_CAP) }),
      follow,
      ...(duration === undefined ? {} : { duration }),
      ...(followBudgetMs === undefined ? {} : { followBudgetMs }),
      json: readBool(parsed.flags, '--json'),
    },
  };
};

/** Render one result for a human. */
const renderHuman = (app: string, result: LogQueryResult): string => {
  const header = `[${app}] status=${result.status}`;
  const lines = [header];

  if (result.message) {
    lines.push(result.message);
  }
  if (result.limitations && result.limitations.length > 0) {
    lines.push('limitations:');
    for (const note of result.limitations) {
      lines.push(`  - ${note}`);
    }
  }
  for (const event of result.events) {
    lines.push(
      `${new Date(event.timestamp).toISOString()} ${event.level.padEnd(7)} ` +
        `[${event.source}/${event.release}] ${event.event}${event.message === undefined ? '' : ` — ${event.message}`}` +
        `${event.traceId === undefined ? '' : ` (trace=${event.traceId})`}` +
        `${event.userId === undefined ? '' : ` (user=${event.userId})`}`,
    );
  }
  if (result.status === 'no_matches') {
    lines.push('(no events matched)');
  }

  return lines.join('\n');
};

const renderJson = (app: string, result: LogQueryResult): string =>
  JSON.stringify({ app, ...result }, null, 2);

/** Run one query. Exported so the Pi log tool and tests call the same path. */
export const runQuery = async (query: LogQuery): Promise<LogQueryResult[]> => {
  const resolution = resolveLogAdapter(query.app, query.mode);

  if ('unsupported' in resolution) {
    return [{ status: 'capability_unsupported', events: [], message: resolution.unsupported }];
  }

  if (resolution.kind === 'local-file') {
    return [(await readLocal(query)).result];
  }

  if (query.follow === true) {
    // Live events go to stdout as they arrive. The final result object comes back
    // too, so `--json` still produces exactly one document at the end.
    return [await tailCloudflare(query)];
  }

  return [await queryCloudflareHistory(query)];
};

/**
 * CLI entry point.
 *
 * Prints one block per app and sets a non-zero exit code for any status that is
 * not a success, so a script wrapping this can trust the exit code.
 */
export const main = async (argv: readonly string[]): Promise<number> => {
  const parsed = parseArgs(argv);

  if (readBool(parsed.flags, '--help') || readBool(parsed.flags, '-h')) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }

  const app = parsed.app;
  if (app === undefined) {
    process.stderr.write('Which app? client, api or all.\n\n');
    process.stderr.write(`${helpText()}\n`);
    return 2;
  }
  if (app !== 'all' && !isAppId(app)) {
    process.stderr.write(`Unknown app "${app}". Expected client, api or all.\n`);
    return 2;
  }

  const validated = toQuery(parsed);
  if (!validated.ok) {
    process.stderr.write(`${validated.message}\n`);
    return 2;
  }

  const targets: Array<'client' | 'api'> = app === 'all' ? ['client', 'api'] : [app];
  const results: string[] = [];
  let worst = 0;

  for (const target of targets) {
    const query: LogQuery = { ...validated.query, app: target };

    // Pre-flight the filter so an unsupported flag is reported before any
    // provider work, and identically for every adapter.
    const resolution = resolveLogAdapter(target, query.mode);
    if ('unsupported' in resolution) {
      const result: LogQueryResult = {
        status: 'capability_unsupported',
        events: [],
        message: resolution.unsupported,
      };
      results.push(query.json === true ? renderJson(target, result) : renderHuman(target, result));
      worst = Math.max(worst, 1);
      continue;
    }

    const capabilities = capabilitiesFor(resolution.kind);
    const decision = buildFilter(query, capabilities);
    if (!decision.ok) {
      const result: LogQueryResult = {
        status: 'capability_unsupported',
        events: [],
        message: decision.unsupported,
      };
      results.push(query.json === true ? renderJson(target, result) : renderHuman(target, result));
      worst = Math.max(worst, 1);
      continue;
    }

    if (app === 'all' && query.mode === 'local') {
      const allResults = await readAllLocal(query);
      allResults.forEach((result, index) => {
        const name = targets[index] ?? target;
        results.push(query.json === true ? renderJson(name, result) : renderHuman(name, result));
        if (result.status !== 'ok') {
          worst = Math.max(worst, 1);
        }
      });
      continue;
    }

    const [result] = await runQuery(query);
    if (!result) {
      continue;
    }
    results.push(query.json === true ? renderJson(target, result) : renderHuman(target, result));
    if (result.status !== 'ok') {
      worst = Math.max(worst, 1);
    }
  }

  process.stdout.write(`${results.join('\n\n')}\n`);
  return worst;
};

/** Dispatcher descriptor. The argv work above is the whole implementation. */
export const logsCommand: Command = {
  name: 'logs',
  summary: 'read, follow and filter log events',
  usage: 'logs <client|api|all> [--mode local|staging|production] [filters]',
  run: main,
};

export type { LogApp };
export { APP_LOG_CONFIG };
