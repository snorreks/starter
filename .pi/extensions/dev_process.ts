// .pi/extensions/dev_process.ts
//
// Start, watch and stop long-running processes this checkout owns.
//
// This file is an **entrypoint**. The job lifecycle lives in `.pi/lib/jobs.ts`
// and the bounded subprocess in `.pi/lib/process.ts`.
//
// 🔴 What Pi lacks and why this exists: `bash` returns when the command returns,
// so a dev server, a preview build or a long verification run has to be
// backgrounded with a shell `&` and then *inferred* from its log output. That
// inference is where it goes wrong in the worst direction — a linking phase that
// has printed nothing for thirty seconds is indistinguishable from a finished
// build, and a model that reads silence as success reports a pass that never
// happened.
//
// So this returns a **handle**, and completion is only ever the process's own
// exit status. Output that stopped changing is reported as an observation and
// never as a state transition.
//
// It shells out rather than importing: a tool that links the CLI's internals and
// a tool that runs the CLI drift apart the first time the CLI gains an option.

import { fileURLToPath } from 'node:url';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { sessionContext } from '../lib/herdr_cli.ts';
import { type JobSnapshot, listJobs, readJob, startJob, stopJob, tailJobLog } from '../lib/jobs.ts';
import { defineAction, registerNamespace } from '../lib/tool_namespace.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Bounds for an owned job.
 *
 * Generous, because a dev server legitimately runs for hours. It is a ceiling
 * rather than an expectation: `start` returns immediately with a handle, and the
 * ceiling only matters for a job nobody ever stops.
 *
 * The log budget is the in-memory tail `wait` hands back. The complete stream
 * always goes to disk, so truncation here costs a model the *convenience* of a
 * tail, never the evidence.
 */
const LIMITS = {
  defaultTimeoutMs: 4 * 60 * 60 * 1000,
  maxTimeoutMs: 12 * 60 * 60 * 1000,
  maxBytes: 64 * 1024,
  logTailBytes: 32 * 1024,
  stopGraceMs: 3_000,
} as const;

/** Tasks in this repository that do not exit, i.e. what this tool is for. */
const LONG_RUNNING = {
  dev: 'bun run dev',
} as const;

const fail = (text: string, details: unknown): AgentToolResult<unknown> =>
  ({ content: [{ type: 'text', text }], isError: true, details }) as AgentToolResult<unknown>;

/**
 * Render a snapshot so the exit status is never ambiguous.
 *
 * `state` and `exitCode` are stated separately and the "still running" line says
 * outright that silence is not completion — because the single most expensive
 * mistake available here is reading a quiet log as a finished job.
 */
const renderSnapshot = (job: JobSnapshot): string => {
  const lines = [
    `job ${job.id}  ${job.command} ${job.args.join(' ')}`.trimEnd(),
    `  cwd:     ${job.cwd}`,
    `  state:   ${job.state}${job.exitCode === undefined ? '' : ` (exit ${job.exitCode})`}`,
  ];

  if (job.state === 'running') {
    lines.push(
      `  pid:     ${job.pid ?? 'unknown'}`,
      `  log:     ${tailHint(job.id)}`,
      '',
      '  It is still running. No output for a while is NOT completion — poll ' +
        '`dev_process { action: "status" }`, or stop it with `stop`.',
    );
  } else {
    const age = job.finishedAt === undefined ? 0 : Date.now() - job.finishedAt;
    lines.push(`  ended:   ${Math.round(age / 1000)}s ago`);
  }

  return lines.join('\n');
};

const tailHint = (id: string): string =>
  `.pi/background-tasks/${id}.log (read it with action "logs")`;

export default function devProcessExtension(pi: ExtensionAPI): void {
  registerNamespace(pi, {
    name: 'dev_process',
    label: 'Dev Process',
    promptSnippet:
      'Start and stop long-running dev/verification processes; read their bounded logs',
    description:
      'Start, inspect and stop long-running processes this checkout owns — dev servers, ' +
      'preview builds, long verification runs. Use this when a command does not exit; use ' +
      '`repo_task` for anything that terminates on its own. `start` returns immediately with a ' +
      'handle and a log path rather than blocking. A job is finished only when its process has ' +
      'exited: quiet output is never treated as completion. `stop` signals the whole process ' +
      "group, and only after checking a token planted in that process's own environment, so it " +
      'cannot kill an unrelated process that inherited a recycled pid.',

    actions: [
      defineAction({
        action: 'start',
        summary: `Start a long-running process. Returns a handle immediately. Common: "${LONG_RUNNING.dev}".`,
        parameters: Type.Object({
          command: Type.Optional(
            Type.String({
              description:
                'The command to run, as a single string, split on whitespace — e.g. "bun run dev". ' +
                'Omit to use the web dev server.',
            }),
          ),
          args: Type.Optional(
            Type.Array(Type.String(), {
              description:
                'Explicit argv. Preferred over `command`: no quoting or splitting to get wrong.',
            }),
          ),
          timeoutMs: Type.Optional(
            Type.Number({
              description: `Wall-clock ceiling in ms before the process is stopped. Default ${LIMITS.defaultTimeoutMs}.`,
            }),
          ),
        }),

        async execute(_toolCallId, params) {
          // Prefer argv. Splitting a string on whitespace is what turns a quoted
          // path with a space in it into two arguments and a confusing failure.
          const argv =
            params.args !== undefined && params.args.length > 0
              ? params.args
              : (params.command ?? LONG_RUNNING.dev).trim().split(/\s+/).filter(Boolean);

          const binary = argv[0];
          if (binary === undefined) {
            return fail('Nothing to start: no command and no args.', { error: 'empty_command' });
          }

          const timeoutMs = Math.min(
            Math.max(params.timeoutMs ?? LIMITS.defaultTimeoutMs, 1_000),
            LIMITS.maxTimeoutMs,
          );

          const { snapshot, logPath } = startJob(binary, argv.slice(1), {
            cwd: REPO_ROOT,
            timeoutMs,
            maxBytes: LIMITS.maxBytes,
            killGraceMs: LIMITS.stopGraceMs,
          });

          return {
            content: [
              {
                type: 'text',
                text: [
                  `Started ${binary} ${argv.slice(1).join(' ')}`.trimEnd(),
                  `  job:  ${snapshot.id}`,
                  `  pid:  ${snapshot.pid ?? 'unknown'}`,
                  `  log:  ${logPath}`,
                  `  cwd:  ${REPO_ROOT}`,
                  '',
                  'It is running. This tool has not verified anything yet. Follow it with ' +
                    '`dev_process { action: "logs" }`, and stop it with `stop` when finished.',
                ].join('\n'),
              },
            ],
            details: { jobId: snapshot.id, pid: snapshot.pid, logPath },
          };
        },
      }),

      defineAction({
        action: 'status',
        summary: 'Report state and exit status for one job, or list every job.',
        parameters: Type.Object({
          job: Type.Optional(
            Type.String({ description: 'Job id from `start`. Omit to list every job.' }),
          ),
        }),

        async execute(_toolCallId, params) {
          if (params.job === undefined) {
            const jobs = listJobs(REPO_ROOT);
            if (jobs.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text:
                      'No jobs recorded for this checkout. (A running job is not a passed one — ' +
                      'start one if you meant to.)',
                  },
                ],
                details: { count: 0 },
              };
            }
            const running = jobs.filter((job) => job.state === 'running').length;
            return {
              content: [
                {
                  type: 'text',
                  text: [
                    `${jobs.length} job(s), ${running} running:`,
                    ...jobs.map(
                      (job) =>
                        `  ${job.id}  ${job.state}${job.exitCode === undefined ? '' : ` (exit ${job.exitCode})`}  ${job.command}`,
                    ),
                  ].join('\n'),
                },
              ],
              details: { count: jobs.length, running },
            };
          }

          const job = readJob(REPO_ROOT, params.job);
          if (job === undefined) {
            return fail(
              `No job with id "${params.job}". Run \`dev_process { action: "status" }\` with no job ` +
                'to list the ones that exist.',
              { error: 'unknown_job' },
            );
          }

          return {
            content: [{ type: 'text', text: renderSnapshot(job) }],
            details: { jobId: job.id, state: job.state, exitCode: job.exitCode },
          };
        },
      }),

      defineAction({
        action: 'logs',
        summary: 'Read the last bytes of a job log.',
        parameters: Type.Object({
          job: Type.String({ description: 'Job id from `start`.' }),
          maxBytes: Type.Optional(
            Type.Number({
              description: `Tail size in bytes. Default and cap ${LIMITS.logTailBytes}.`,
            }),
          ),
        }),

        async execute(_toolCallId, params) {
          const job = readJob(REPO_ROOT, params.job);
          const bytes = Math.min(
            Math.max(params.maxBytes ?? LIMITS.logTailBytes, 256),
            LIMITS.logTailBytes,
          );

          const tail = tailJobLog(REPO_ROOT, params.job, bytes);
          if (tail === undefined) {
            return fail(
              `No log for job "${params.job}".` +
                (job === undefined
                  ? ' No such job.'
                  : ` (${job.state}; a job that just started may not have written yet.)`),
              { error: 'no_log' },
            );
          }

          const notices: string[] = [];
          if (job?.state === 'running') {
            notices.push('This job is still running. What you have read so far is not its result.');
          }
          if (tail.trim() === '') {
            notices.push(
              'The log is empty. An empty log is not a clean run — check `status` for the exit status.',
            );
          }

          return {
            content: [
              { type: 'text', text: [tail.trimEnd(), ...notices].filter(Boolean).join('\n') },
            ],
            details: { jobId: params.job, state: job?.state, bytes },
          };
        },
      }),

      defineAction({
        action: 'stop',
        summary: 'Stop a job this checkout owns, after verifying it still owns the pid.',
        parameters: Type.Object({
          job: Type.String({ description: 'Job id from `start`.' }),
        }),

        async execute(_toolCallId, params) {
          const outcome = await stopJob(REPO_ROOT, params.job, LIMITS.stopGraceMs);

          if (outcome.stopped) {
            return {
              content: [
                {
                  type: 'text',
                  text: [
                    `Stopped ${outcome.snapshot?.id ?? params.job}: ${outcome.reason}.`,
                    'The exit status is a kill (124), not a failure of the process itself — ' +
                      'do not report it as a test failure.',
                  ].join('\n'),
                },
              ],
              details: { jobId: params.job, stopped: true },
            };
          }

          // A refusal, not a crash. "Already finished" and "that pid is not ours" are
          // different answers and the caller has to be able to tell them apart.
          return fail(
            outcome.snapshot === undefined
              ? outcome.reason
              : `${outcome.reason}. Job ${outcome.snapshot.id} is ${outcome.snapshot.state}` +
                  (outcome.snapshot.exitCode === undefined
                    ? ''
                    : ` (exit ${outcome.snapshot.exitCode})`),
            { jobId: params.job, stopped: false },
          );
        },
      }),

      defineAction({
        action: 'context',
        summary: 'Report the session context, so a handoff can record where it is running.',
        parameters: Type.Object({}),

        async execute() {
          const context = sessionContext();
          return {
            content: [
              {
                type: 'text',
                text: [
                  `cwd:        ${REPO_ROOT}`,
                  `inside herdr: ${context.inside ? 'yes' : 'no'}`,
                  `workspace:  ${context.workspaceId ?? 'unrecorded'}`,
                  `tab:        ${context.tabId ?? 'unrecorded'}`,
                  `pane:       ${context.paneId ?? 'unrecorded'}`,
                  '',
                  "These ids are Herdr's, and they are read-only context. Record them in a " +
                    'handoff note; never close or restart the session they belong to.',
                ].join('\n'),
              },
            ],
            details: context,
          };
        },
      }),
    ],
  });
}
