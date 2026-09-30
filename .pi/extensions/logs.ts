/**
 * .pi/extensions/logs.ts
 *
 * Gives the agent the same log operations a human has, as a tool.
 *
 * The point is that it calls `bun run logs` — the same CLI, the same adapters,
 * the same registry — rather than reimplementing log reading. An agent with its
 * own quieter log path is an agent that debugs against different data than you
 * do, and the two eventually disagree about what happened.
 *
 * It shells out deliberately. `Bun.spawn` would be tidier, but a tool that
 * imports the CLI's internals and a tool that runs the CLI can drift apart the
 * first time the CLI gains an option, and only one of them gets updated.
 */

import { spawn } from 'node:child_process';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const REPO_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Bounded so a query can never become an unbounded dump: an agent that asks for
 * "all the logs" and gets a megabyte of NDJSON has lost the thread, and the
 * transcript is now mostly log lines.
 */
const MAX_LINES = 200;

const PARAMS = Type.Object({
  app: Type.Optional(
    Type.Union([Type.Literal('client'), Type.Literal('api'), Type.Literal('all')], {
      description: "Which app's logs to read. Defaults to all.",
    }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal('local'), Type.Literal('staging'), Type.Literal('production')], {
      description:
        "Where to read from. 'local' needs no credentials; the others need Cloudflare access " +
        'and will report clearly if they do not have it.',
    }),
  ),
  level: Type.Optional(
    Type.Union(
      [Type.Literal('DEBUG'), Type.Literal('INFO'), Type.Literal('WARNING'), Type.Literal('ERROR')],
      {
        description: 'Minimum level to include.',
      },
    ),
  ),
  uid: Type.Optional(
    Type.String({ description: 'Filter by user id, if the adapter supports it.' }),
  ),
  traceId: Type.Optional(Type.String({ description: 'Filter by trace id.' })),
  limit: Type.Optional(
    Type.Number({ description: `Maximum lines to return (default and cap: ${MAX_LINES}).` }),
  ),
  errorsOnly: Type.Optional(Type.Boolean({ description: 'Shorthand for level ERROR.' })),
});

interface LogParams {
  app?: 'client' | 'api' | 'all';
  mode?: 'local' | 'staging' | 'production';
  level?: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
  uid?: string;
  traceId?: string;
  limit?: number;
  errorsOnly?: boolean;
}

/** Recorded alongside the output so the model can see what was actually run. */
export interface LogCallDetails {
  command: string;
  exitCode: number;
}

/** Build the argv, rejecting anything the CLI does not accept. */
export const buildArgs = (params: LogParams): string[] => {
  const args = ['run', 'logs'];

  args.push(params.app ?? 'all');
  args.push('--mode', params.mode ?? 'local');

  const level = params.errorsOnly === true ? 'ERROR' : params.level;
  if (level !== undefined) {
    args.push('--level', level);
  }
  if (params.uid !== undefined && params.uid.length > 0) {
    args.push('--uid', params.uid);
  }
  if (params.traceId !== undefined && params.traceId.length > 0) {
    args.push('--trace', params.traceId);
  }

  const limit = params.limit ?? MAX_LINES;
  // Clamped rather than rejected: a model asking for 100000 lines has usually
  // made a mistake, and a bounded answer is more useful than an error.
  args.push('--limit', String(Math.max(1, Math.min(limit, MAX_LINES))));

  return args;
};

export default function logToolExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'read_logs',
    label: 'Read Logs',
    description:
      "Read this project's structured logs through `bun run logs`. Same CLI, same adapters, " +
      'same capability rules a human gets — including refusing a filter the active adapter ' +
      'cannot support rather than silently ignoring it. Use this instead of reading log ' +
      'files or guessing at what an API call did.',
    promptSnippet: "Read application logs via the project's own log CLI",
    promptGuidelines: [
      'Prefer read_logs over reading log files directly: it applies redaction, bounds, and ' +
        'the same capability checks the CLI applies.',
      'A non-zero exit from the CLI is a real answer, not a tool failure. The message says ' +
        'which prerequisite is missing — relay it rather than retrying.',
    ],
    parameters: PARAMS,
    async execute(_toolCallId, params: LogParams): Promise<AgentToolResult<LogCallDetails>> {
      const args = buildArgs(params);

      return await new Promise<AgentToolResult<LogCallDetails>>((resolve) => {
        const child = spawn('bun', args, { cwd: REPO_ROOT });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.on('error', (error) => {
          resolve({
            content: [{ type: 'text', text: `Could not run bun: ${error.message}` }],
            // No `isError` field exists on the result type. A tool failure is
            // communicated in the text, which is also what the model reads — so a
            // refusal from the CLI has to be phrased as an answer, not as an
            // exception, or the model retries instead of relaying the reason.
            details: { command: `bun ${args.join(' ')}`, exitCode: -1 },
          });
        });

        child.on('close', (code) => {
          // stderr first when there is any: the CLI's refusal messages are the
          // useful part, and they arrive on stderr.
          const text = code === 0 ? stdout.trim() : stderr.trim() || stdout.trim();

          resolve({
            content: [
              {
                type: 'text',
                text:
                  text.length > 0
                    ? text
                    : `bun run logs ${args.slice(2).join(' ')} produced no output (exit ${code}).`,
              },
            ],
            details: { command: `bun ${args.join(' ')}`, exitCode: code ?? -1 },
          });
        });
      });
    },
  });
}
