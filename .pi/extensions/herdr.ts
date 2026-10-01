// .pi/extensions/herdr.ts
//
// Isolated worktree setup, as an optional capability that can be absent.
//
// This file is an **entrypoint**. Everything it decides lives in
// `.pi/lib/herdr_cli.ts`; the bounded subprocess is `.pi/lib/process.ts`.
//
// 🔴 Absence is a value, not an exception. A machine without `herdr` is the
// normal case for anyone who cloned this template. Nothing here runs at module
// load and nothing here throws on import, because an extension that fails to
// load takes the whole agent down with it — so Pi starts on a machine that has
// never heard of Herdr. `probe()` answers "is this capability present", and the
// answer is reported as a named unavailable capability rather than swallowed.
//
// 🔴 Flags come from the installed binary, not from this file. Herdr's own guide
// says the installed CLI is the authority for syntax, and the `help` action
// exists so that claim is checkable at runtime rather than trusted from a
// comment. An upgrade that renames a flag surfaces as text.

import { fileURLToPath } from 'node:url';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  BOUNDS,
  buildHelpArgs,
  buildWorktreeArgs,
  HERDR_BIN,
  HERDR_GROUPS,
  parseEnvelope,
  probe,
  validateWorktreeParams,
  type WorktreeAction,
  type WorktreeParams,
} from '../lib/herdr_cli.ts';
import type { BoundedRunResult } from '../lib/process.ts';
import { runBounded } from '../lib/process.ts';
import { defineAction, registerNamespace } from '../lib/tool_namespace.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const fail = (text: string, details: unknown): AgentToolResult<unknown> =>
  ({ content: [{ type: 'text', text }], isError: true, details }) as AgentToolResult<unknown>;

/**
 * The one text every refusal leads with.
 *
 * The distinction this preserves is the one the task turns on: an **absent**
 * capability is not a **failed** command. Only the second is worth retrying, and
 * a model that cannot tell them apart either retries forever or gives up on
 * something that would have worked.
 */
const unavailable = (
  reason: string,
  details: Record<string, unknown> = {},
): AgentToolResult<unknown> =>
  fail(
    `Capability "herdr" is UNAVAILABLE.\n${reason}\n\n` +
      'Normal application development does not need Herdr. `repo_task`, `dev_process` and ' +
      '`read_logs` are unaffected — use those instead.',
    { capability: 'herdr', available: false, ...details },
  );

/** Run a herdr subcommand, mapping every failure mode to a distinguishable answer. */
const invoke = async (
  args: readonly string[],
): Promise<
  { ok: true; stdout: string } | { ok: false; kind: 'unavailable' | 'failed'; reason: string }
> => {
  let result: BoundedRunResult;
  try {
    result = await runBounded(HERDR_BIN, args, { cwd: REPO_ROOT, ...BOUNDS });
  } catch (error) {
    // A spawn failure. Node reports a missing binary by throwing here rather than
    // by emitting an `error` event on the child, so this is the absent-capability
    // path — and it must not be conflated with a herdr that ran and refused.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: 'unavailable',
      reason: `\`${HERDR_BIN}\` is not on PATH (${reason}).`,
    };
  }

  if (result.code === 0) {
    return { ok: true, stdout: result.stdout };
  }

  // 127 is the shell's "command not found". spawn reports it as a child exit
  // when the binary is missing on some platforms, so it is treated as absence
  // rather than as a herdr failure.
  const detail = (result.stderr.trim() || result.stdout.trim() || 'no output').slice(0, 400);
  return {
    ok: false,
    kind: result.code === 127 ? 'unavailable' : 'failed',
    reason: `\`${HERDR_BIN} ${args.join(' ')}\` exited ${result.code}: ${detail}`,
  };
};

const WORKTREE_PARAMS = Type.Object({
  workspace: Type.Optional(
    Type.String({
      description:
        'Herdr workspace id, read from `herdr worktree list`. Never guessed: ids are opaque ' +
        'handles the server allocates. Required for `remove`.',
    }),
  ),
  cwd: Type.Optional(Type.String({ description: 'Repository the worktree belongs to.' })),
  branch: Type.Optional(Type.String({ description: 'Branch to create or open.' })),
  base: Type.Optional(
    Type.String({
      description: 'Base ref for `create`, e.g. "main". Recorded so a handoff can name it.',
    }),
  ),
  path: Type.Optional(Type.String({ description: 'Explicit checkout path.' })),
  label: Type.Optional(Type.String({ description: 'Human-readable workspace label.' })),
  focus: Type.Optional(
    Type.Boolean({
      description:
        "Move the user's terminal focus to the new workspace. Defaults to false so an agent " +
        'starting a workspace does not steal focus mid-sentence.',
    }),
  ),
  force: Type.Optional(
    Type.Boolean({
      description: 'Pass --force on `remove`. Never defaulted on: it deletes a checkout.',
    }),
  ),
  trustRepository: Type.Optional(
    Type.Boolean({
      description:
        'Pass --trust-repository, which Herdr requires before acting on a checkout. The ' +
        'repository must be one you have looked at.',
    }),
  ),
});

export default function herdrExtension(pi: ExtensionAPI): void {
  registerNamespace(pi, {
    name: 'herdr',
    label: 'Herdr Worktree',
    description:
      'Isolated worktree setup and inspection through the Herdr CLI, as an OPTIONAL capability. ' +
      'Use it to give a piece of work its own checkout, branch and workspace so it cannot disturb ' +
      "the session in progress. Herdr's identifiers are opaque and are read from responses, never " +
      'predicted. When Herdr is not installed or this session is not inside a managed pane, every ' +
      'action reports a named unavailable capability — that is an absence, not a failure, and it ' +
      'never blocks ordinary development. This tool never closes, stops or detaches a session that ' +
      'belongs to you.',

    actions: [
      defineAction({
        action: 'status',
        summary: "Report whether the herdr capability is present, and this session's ids.",
        parameters: Type.Object({}),

        async execute() {
          const capability = await probe(REPO_ROOT, runBounded);
          if (!capability.available) {
            return unavailable(capability.reason, { version: capability.version });
          }
          return {
            content: [
              {
                type: 'text',
                text:
                  `Capability "herdr" is AVAILABLE.\n${capability.reason}\n` +
                  `version: ${capability.version}`,
              },
            ],
            details: { capability: 'herdr', available: true, version: capability.version },
          };
        },
      }),

      defineAction({
        action: 'help',
        summary: "Print the installed CLI's own help for a group — the authority on syntax.",
        parameters: Type.Object({
          // A plain string, checked against the installed CLI at runtime rather
          // than pinned to an enum here: Herdr adds command groups, and a
          // hardcoded enum turns a new group into a validation error instead of
          // a readable help dump.
          group: Type.Optional(
            Type.String({
              description:
                `Command group, e.g. "${HERDR_GROUPS.join('", "')}", or a worktree subcommand ` +
                'like "worktree create". Omit for top-level help. Always passed `--help`, which ' +
                'cannot execute anything — the documented alternative to probing a mutating ' +
                'command by omitting its arguments.',
            }),
          ),
        }),

        async execute(_toolCallId, params) {
          const group = params.group?.trim() ?? '';
          // `worktree create` is a two-word group, so split before dispatching.
          // A bare `--help` in every branch: a mutating subcommand omitted its
          // arguments would run, with defaults.
          const args = group.startsWith('worktree ')
            ? ['worktree', group.slice('worktree '.length), '--help']
            : buildHelpArgs(group);

          const result = await invoke(args);
          if (!result.ok) {
            return result.kind === 'unavailable'
              ? unavailable(result.reason)
              : fail(result.reason, { error: 'herdr_failed' });
          }
          return {
            content: [{ type: 'text', text: result.stdout.trim() }],
            details: { command: `${HERDR_BIN} ${args.join(' ')}` },
          };
        },
      }),

      defineAction({
        action: 'worktree_list',
        summary: 'List worktree workspaces, with their real workspace ids and paths.',
        parameters: Type.Object({
          cwd: Type.Optional(Type.String({ description: 'Repository to list worktrees of.' })),
        }),

        async execute(_toolCallId, params) {
          const capability = await probe(REPO_ROOT, runBounded);
          if (!capability.available) {
            return unavailable(capability.reason);
          }

          const args = buildWorktreeArgs('list', {
            ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
          });
          const result = await invoke(args);
          if (!result.ok) {
            return result.kind === 'unavailable'
              ? unavailable(result.reason)
              : fail(result.reason, { error: 'herdr_failed' });
          }

          const parsed = parseEnvelope(result.stdout);
          if (!parsed.ok) {
            return fail(`${parsed.reason}\nNothing was listed.`, { error: 'bad_response' });
          }

          const worktrees = parsed.envelope.result?.worktrees ?? [];
          if (worktrees.length === 0) {
            return {
              content: [
                { type: 'text', text: 'Herdr reports no worktree workspaces for this repository.' },
              ],
              details: { count: 0 },
            };
          }

          const rows = worktrees.map((tree) =>
            [
              `  ${tree.open_workspace_id ?? '(no open workspace)'}`,
              `  path:   ${tree.path ?? 'unrecorded'}`,
              `  branch: ${tree.branch ?? 'detached'}`,
              `  linked: ${tree.is_linked_worktree === true ? 'yes' : 'no'}`,
            ].join('\n'),
          );
          return {
            content: [
              {
                type: 'text',
                text:
                  `${worktrees.length} worktree workspace(s):\n\n${rows.join('\n\n')}\n\n` +
                  'Use these ids verbatim. They are opaque: a workspace id from another session ' +
                  'does not resolve here.',
              },
            ],
            details: { count: worktrees.length },
          };
        },
      }),

      defineAction({
        action: 'worktree_create',
        summary: 'Create a worktree on a new branch. Returns its real path and workspace id.',
        parameters: WORKTREE_PARAMS,

        async execute(_toolCallId, params) {
          return runWorktree('create', params);
        },
      }),

      defineAction({
        action: 'worktree_open',
        summary: 'Open an existing worktree checkout as a workspace.',
        parameters: WORKTREE_PARAMS,

        async execute(_toolCallId, params) {
          return runWorktree('open', params);
        },
      }),

      defineAction({
        action: 'worktree_remove',
        summary: 'Remove a worktree checkout. Requires an explicit workspace id.',
        parameters: WORKTREE_PARAMS,

        async execute(_toolCallId, params) {
          return runWorktree('remove', params);
        },
      }),
    ],
  });

  async function runWorktree(
    action: WorktreeAction,
    params: WorktreeParams,
  ): Promise<AgentToolResult<unknown>> {
    const refusal = validateWorktreeParams(action, params);
    if (refusal !== undefined) {
      // A refusal before anything was spawned. Nothing was changed.
      return fail(refusal, { error: 'refused', action });
    }

    const capability = await probe(REPO_ROOT, runBounded);
    if (!capability.available) {
      return unavailable(capability.reason);
    }

    const args = buildWorktreeArgs(action, params);
    const result = await invoke(args);
    if (!result.ok) {
      return result.kind === 'unavailable'
        ? unavailable(result.reason)
        : fail(result.reason, { error: 'herdr_failed', action });
    }

    const parsed = parseEnvelope(result.stdout);
    if (!parsed.ok) {
      return fail(
        `${parsed.reason}\nThe command ran but its result could not be read, so treat the state as unknown.`,
        { error: 'bad_response', action },
      );
    }

    const workspace = parsed.envelope.result?.workspace;
    const path = workspace?.worktree?.checkout_path ?? parsed.envelope.result?.worktree?.path;

    // Ids come out of the response and go nowhere else. Predicting one would be
    // the failure mode Herdr's own guide warns about.
    return {
      content: [
        {
          type: 'text',
          text: [
            `herdr worktree ${action} succeeded.`,
            `  checkout:      ${path ?? 'unrecorded — read it from the response above'}`,
            `  workspace id:  ${workspace?.workspace_id ?? parsed.envelope.result?.worktree?.open_workspace_id ?? 'unrecorded'}`,
            `  active tab id: ${workspace?.active_tab_id ?? 'unrecorded'}`,
            '',
            'A fresh worktree has no dependencies installed. Run `bun install` in the checkout ' +
              'path above before any task, and record the path in a handoff note.',
          ].join('\n'),
        },
      ],
      details: { action, checkoutPath: path },
    };
  }
}
