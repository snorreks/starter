// .pi/extensions/repo_task.ts
//
// Discover and run this repository's own tasks.
//
// This file is an **entrypoint**. It registers one tool and holds no logic worth
// testing on its own: task discovery and argv construction live in
// `.pi/lib/tasks.ts`, and the bounded subprocess in `.pi/lib/process.ts`.
//
// That separation is not stylistic. `.pi/extensions/` is Pi's discovery input —
// Pi loads every module it finds there as an extension on every start, so a
// helper or a test placed here is executed as code. Helpers live in `lib/`,
// tests in `tests/`, and `.pi/tests/pi_loader.test.ts` enforces that against the
// real loader.
//
// It shells out to the repository's own task runner rather than importing it. A
// tool that links the task graph and a tool that runs `moon` drift apart the
// first time a task is renamed, and only one of them gets updated.

import { fileURLToPath } from 'node:url';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { runBounded } from '../lib/process.ts';
import {
  buildRunArgs,
  filterTasks,
  type MoonTask,
  queryTasks,
  renderTaskTable,
  resolveTask,
  suggestTasks,
  TASK_BOUNDS,
} from '../lib/tasks.ts';
import { defineAction, registerNamespace } from '../lib/tool_namespace.ts';
import { invokeStarterAgent, responseToolResult } from '../lib/workflow_bridge.ts';

// `fileURLToPath`, not `new URL(...).pathname`: the latter percent-encodes, so a
// checkout under a directory containing a space resolves to a path that does not
// exist, and the tool fails from the wrong working directory.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Bounds. Both are real ceilings, and both are stated in the tool description so
 * a model that hits one is not surprised by it.
 *
 * The task graph is tens of KB; a runaway dump is bounded rather than trusted. A
 * task's own output can be a full test suite, so it gets its own, larger budget.
 */
const LIMITS = {
  queryTimeoutMs: 60_000,
  queryMaxBytes: 4 * 1024 * 1024,
  runTimeoutMs: TASK_BOUNDS.timeoutMs,
  runMaxBytes: TASK_BOUNDS.maxBytes,
} as const;

const QUERY = { timeoutMs: LIMITS.queryTimeoutMs, maxBytes: LIMITS.queryMaxBytes };
const VISUAL_CAPTURE_TIMEOUT_MS = 30 * 60_000;
const VISUAL_REVIEW_TIMEOUT_MS = 20 * 60_000;
const FULL_COMPUTE_TIMEOUT_MS = 35 * 60_000;

const fail = (text: string, details: unknown): AgentToolResult<unknown> =>
  ({
    content: [{ type: 'text', text }],
    isError: true,
    details,
  }) as AgentToolResult<unknown>;

/**
 * The task graph, or a refusal that says why it could not be read.
 *
 * Never an empty list on failure: a model told "no tasks" about a broken
 * workspace concludes the repository has none, which is a confident wrong answer
 * rather than a visible error.
 */
const loadTasks = async (): Promise<MoonTask[] | AgentToolResult<unknown>> => {
  try {
    return await queryTasks(REPO_ROOT, runBounded, QUERY);
  } catch (error) {
    return fail(
      `Could not read the task graph: ${(error as Error).message}\n` +
        'This is a failure to report, not an empty result — the repository does have tasks.',
      { error: 'query_failed' },
    );
  }
};

const isResult = (
  value: MoonTask[] | AgentToolResult<unknown>,
): value is AgentToolResult<unknown> => !Array.isArray(value);

export default function repoTaskExtension(pi: ExtensionAPI): void {
  registerNamespace(pi, {
    name: 'repo_task',
    label: 'Repository Task',
    promptSnippet: "Discover and run this repository's own tasks by id",
    description:
      "Discover and run this repository's own tasks through its declared task runner. Prefer " +
      'this over guessing a `bun run` script: several root scripts are aggregates over the task ' +
      'graph, and only the task ids know which project edge carries the inputs and the caching. ' +
      'A non-zero exit is a real answer, not a tool failure — relay its message instead of ' +
      'retrying. For something that does not exit — a dev server, a preview build — use ' +
      '`dev_process`, which returns a handle instead of blocking.',

    actions: [
      defineAction({
        action: 'list',
        summary: 'List task ids with the command each one runs.',
        parameters: Type.Object({
          query: Type.Optional(
            Type.String({
              description:
                'Case-insensitive substring matched against the task id, its command and its ' +
                'arguments. Omit to list everything.',
            }),
          ),
        }),

        async execute(_toolCallId, params) {
          const tasks = await loadTasks();
          if (isResult(tasks)) {
            return tasks;
          }

          const matched = filterTasks(tasks, params.query);
          const text = [
            renderTaskTable(matched),
            matched.length === tasks.length ? '' : `\n(${tasks.length} tasks total.)`,
          ]
            .filter((part) => part !== '')
            .join('\n');

          return {
            content: [{ type: 'text', text }],
            details: { total: tasks.length, matched: matched.length },
          };
        },
      }),

      defineAction({
        action: 'run',
        summary: 'Run one task by id and return its bounded output.',
        parameters: Type.Object({
          task: Type.String({
            description: 'A task id exactly as `list` reported it, e.g. "pi:test".',
          }),
          args: Type.Optional(
            Type.Array(Type.String({ description: 'One argument.' }), {
              description:
                'Extra arguments for the task itself. Passed after `--`, so they are never ' +
                'mistaken for options of the task runner.',
            }),
          ),
        }),

        async execute(_toolCallId, params) {
          const extra = params.args ?? [];
          const argv = buildRunArgs(params.task, extra);
          const command = `bun ${argv.join(' ')}`;

          const tasks = await loadTasks();
          if (isResult(tasks)) {
            return tasks;
          }

          // Checked against the real graph first. An unknown id reaches the task
          // runner as a generic failure, and the useful half of the answer —
          // "did you mean `pi:test`?" — can only come from here.
          if (resolveTask(tasks, params.task) === undefined) {
            const suggestions = suggestTasks(tasks, params.task);
            return fail(
              `No task named "${params.task}". ` +
                (suggestions.length > 0
                  ? `Closest ids: ${suggestions.join(', ')}. `
                  : 'Run `repo_task list` to see what exists. ') +
                'Nothing was executed.',
              { error: 'unknown_task', suggestions },
            );
          }

          const result = await runBounded('bun', argv, {
            cwd: REPO_ROOT,
            timeoutMs: LIMITS.runTimeoutMs,
            maxBytes: LIMITS.runMaxBytes,
          });

          const notices: string[] = [];
          if (result.timedOut) {
            notices.push(
              `Exceeded its ${Math.round(LIMITS.runTimeoutMs / 1000)}s budget and was stopped. ` +
                'Work that outlives that belongs in `dev_process`, which returns a handle.',
            );
          }
          if (result.truncated) {
            notices.push(
              `Output exceeded ${LIMITS.runMaxBytes} bytes and was truncated.` +
                (result.artifactPath === undefined ? '' : ` Full output: ${result.artifactPath}`),
            );
          }

          // stderr first on failure: the runner's refusals are the useful part and
          // they arrive on stderr.
          const body =
            result.code === 0 ? result.stdout.trim() : result.stderr.trim() || result.stdout.trim();

          return {
            content: [
              {
                type: 'text',
                text: [
                  body.length > 0
                    ? body
                    : `${command} produced no output (exit ${result.code}).` +
                      ' No output is not a pass — read the exit code.',
                  ...notices,
                ].join('\n'),
              },
            ],
            isError: result.code !== 0,
            details: { command, exitCode: result.code, truncated: result.truncated },
          };
        },
      }),

      defineAction({
        action: 'visual_capture',
        summary: 'Capture the declared visual matrix and return verified screenshot hashes.',
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, signal) {
          try {
            const { response, exitCode } = await invokeStarterAgent(
              ['visual', 'capture', '--json'],
              { operation: 'visual-capture', timeoutMs: VISUAL_CAPTURE_TIMEOUT_MS, signal },
            );
            return responseToolResult(response, exitCode);
          } catch (error) {
            return fail(`Visual capture failed: ${(error as Error).message}`, {
              operation: 'visual-capture',
            });
          }
        },
      }),

      defineAction({
        action: 'visual_import',
        summary:
          'Import a hash-verified exploratory browser screenshot for explicit visual review; it does not count as scenario coverage or a baseline.',
        parameters: Type.Object(
          {
            runId: Type.String({
              minLength: 1,
              maxLength: 64,
              pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',
            }),
            file: Type.String({ minLength: 1, maxLength: 2048 }),
            sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
            url: Type.String({ minLength: 1, maxLength: 2048 }),
            heading: Type.String({ minLength: 1, maxLength: 200 }),
            requirements: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
              minItems: 1,
              maxItems: 10,
            }),
            controls: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 20 }),
            ),
            content: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 20 }),
            ),
            viewport: Type.Union([Type.Literal('desktop'), Type.Literal('mobile')]),
            theme: Type.Union([Type.Literal('light'), Type.Literal('dark')]),
            crop: Type.Optional(
              Type.Object(
                {
                  x: Type.Number({ minimum: 0, maximum: 1 }),
                  y: Type.Number({ minimum: 0, maximum: 1 }),
                  width: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
                  height: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
                },
                { additionalProperties: false },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params, signal) {
          try {
            const { response, exitCode } = await invokeStarterAgent(
              ['visual', 'import', '--input-json', '--json'],
              {
                operation: 'visual-import',
                timeoutMs: 30_000,
                input: JSON.stringify(params),
                signal,
              },
            );
            return responseToolResult(response, exitCode);
          } catch (error) {
            return fail(`Interactive capture import failed: ${(error as Error).message}`, {
              operation: 'visual-import',
              runId: params.runId,
            });
          }
        },
      }),

      defineAction({
        action: 'visual_review',
        summary: 'Explicitly review one stored visual run through the configured provider.',
        parameters: Type.Object({
          runId: Type.String({
            minLength: 1,
            maxLength: 64,
            pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',
          }),
          gate: Type.Optional(Type.Boolean()),
          noCache: Type.Optional(Type.Boolean()),
        }),
        async execute(_toolCallId, params, signal) {
          const args = ['visual', 'review', '--run', params.runId, '--json'];
          if (params.noCache) {
            args.push('--no-cache');
          }
          if (params.gate) {
            args.push('--gate');
          }
          try {
            const { response, exitCode } = await invokeStarterAgent(args, {
              operation: 'review',
              timeoutMs: VISUAL_REVIEW_TIMEOUT_MS,
              signal,
            });
            return responseToolResult(response, exitCode);
          } catch (error) {
            return fail(`Visual review failed: ${(error as Error).message}`, {
              operation: 'review',
              runId: params.runId,
            });
          }
        },
      }),

      defineAction({
        action: 'compute_full',
        summary: 'Run the Docker-backed browser-to-FFmpeg journey and verify output evidence.',
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, signal) {
          try {
            const { response, exitCode } = await invokeStarterAgent(['compute', 'full', '--json'], {
              operation: 'compute-full',
              timeoutMs: FULL_COMPUTE_TIMEOUT_MS,
              signal,
            });
            return responseToolResult(response, exitCode);
          } catch (error) {
            return fail(`Full compute journey failed: ${(error as Error).message}`, {
              operation: 'compute-full',
            });
          }
        },
      }),
    ],
  });
}
