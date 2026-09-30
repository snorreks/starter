// .pi/extensions/logs.ts
//
// Gives the agent the same log operations a human has, as a tool.
//
// This file is an **entrypoint**. It registers one tool and holds no logic that
// can be tested on its own: the argv translation lives in `.pi/lib/logs_args.ts`
// and the subprocess handling in `.pi/lib/process.ts`.
//
// That separation is not stylistic. `.pi/extensions` is discovery input: Pi
// loads every module it finds there as an extension. `logs.test.ts` used to live
// in this directory, imported `bun:test`, and was loaded as an extension on every
// start. Helpers and tests now live under `.pi/lib` and `.pi/tests`.
//
// The tool calls `bun run logs` — the same CLI, the same adapters, the same
// capability rules a human gets. An agent with its own quieter log path is an
// agent that debugs against different data than you do.
//
// It shells out deliberately. A tool that imports the CLI's internals and a tool
// that runs the CLI drift apart the first time the CLI gains an option, and only
// one of them gets updated.

import { fileURLToPath } from 'node:url';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { buildArgs, type LogCallDetails, type LogParams, MAX_LINES } from '../lib/logs_args.ts';
import { runBounded } from '../lib/process.ts';

// `fileURLToPath`, not `new URL(...).pathname`: the latter percent-encodes, so a
// checkout under a directory with a space in it resolves to a path that does not
// exist and the tool fails with "bun: command not found" from the wrong cwd.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Bounds. All three are real ceilings, not advisory.
 *
 * A tool with no byte limit and no timeout is a way for a misbehaving CLI to
 * consume the agent's memory and its turn, and neither failure is visible in the
 * transcript as anything other than "the model stopped responding".
 */
const LIMITS = {
  /** Hard wall on the whole call, including a `--follow` that respects its own duration. */
  timeoutMs: 330_000,
  /** Bytes of stdout + stderr retained. The log CLI's own output is far smaller. */
  maxBytes: 512 * 1024,
} as const;

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
      { description: 'Minimum level to include.' },
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

const usage = (args: readonly string[]): string => `bun ${args.join(' ')}`;

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
      const command = usage(args);

      let result: Awaited<ReturnType<typeof runBounded>>;
      try {
        result = await runBounded('bun', args, {
          cwd: REPO_ROOT,
          timeoutMs: LIMITS.timeoutMs,
          maxBytes: LIMITS.maxBytes,
        });
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Could not run bun: ${(error as Error).message}` }],
          details: { command, exitCode: -1, truncated: false },
        };
      }

      const notices: string[] = [];
      if (result.timedOut) {
        notices.push(
          `The command exceeded its ${Math.round(LIMITS.timeoutMs / 1000)}s budget and was stopped.`,
        );
      }
      if (result.truncated) {
        notices.push(
          `Output exceeded ${LIMITS.maxBytes} bytes and was truncated.` +
            (result.artifactPath === undefined
              ? ''
              : ` The full output was written to ${result.artifactPath}.`),
        );
      }

      // stderr first when there is any: the CLI's refusal messages are the useful
      // part, and they arrive on stderr.
      const body =
        result.code === 0 ? result.stdout.trim() : result.stderr.trim() || result.stdout.trim();

      const text = [
        body.length > 0 ? body : `${command} produced no output (exit ${result.code}).`,
        ...notices,
      ].join('\n');

      return {
        content: [{ type: 'text', text }],
        details: {
          command,
          exitCode: result.code,
          truncated: result.truncated,
          ...(result.artifactPath === undefined ? {} : { artifactPath: result.artifactPath }),
        },
      };
    },
  });
}
