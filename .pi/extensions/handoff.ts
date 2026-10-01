// .pi/extensions/handoff.ts
//
// Durable handoff notes, written and read through one tool.
//
// This file is an **entrypoint**. Note storage, rendering and the staleness
// comparison live in `.pi/lib/handoff.ts`; git facts come from the bounded
// runner in `.pi/lib/process.ts`.
//
// 🔴 Why a tool rather than a file an agent writes by hand: the whole value of a
// note is the field list and the staleness check. Written by hand, it drifts into
// free-form prose, omits the head SHA, and then the next session has nothing to
// compare against — which is precisely the case `renderResumeWarning` exists for.
//
// 🔴 Why outside tracked source: notes live in `.pi/handoffs/`, which is
// gitignored. A committed handoff lands in history, in every clone, and goes
// stale the moment anyone else pushes. `write` checks that the directory really is
// ignored, so a checkout that has un-gitignored it says so instead of quietly
// creating a tracked file that will outlive the branch it describes.

import { fileURLToPath } from 'node:url';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  HANDOFF_DIR,
  type HandoffEntry,
  type HandoffFailure,
  type HandoffNote,
  handoffDir,
  listHandoffs,
  type ObservedState,
  readHandoff,
  renderResumeWarning,
  staleClaims,
  writeHandoff,
} from '../lib/handoff.ts';
import { runBounded } from '../lib/process.ts';
import { defineAction, registerNamespace } from '../lib/tool_namespace.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const GIT_BOUNDS = { timeoutMs: 15_000, maxBytes: 64 * 1024 } as const;

const fail = (text: string, details: unknown): AgentToolResult<unknown> =>
  ({ content: [{ type: 'text', text }], isError: true, details }) as AgentToolResult<unknown>;

/** One `git` call, bounded. A git that hangs must not hang the agent. */
const git = async (...args: string[]): Promise<string | undefined> => {
  try {
    const result = await runBounded('git', args, { cwd: REPO_ROOT, ...GIT_BOUNDS });
    return result.code === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The live facts a note's claims are checked against.
 *
 * Each is independently optional. A fact that could not be read is **absent**,
 * not false — conflating the two would mark every note stale on a machine where
 * git was unavailable, which trains people to ignore the warning.
 */
const observe = async (): Promise<ObservedState> => {
  const head = await git('rev-parse', 'HEAD');
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  // A detached HEAD has no branch, and `rev-parse` returns the literal string
  // "HEAD" for it — which must not be recorded as a branch name.
  const named = branch === undefined || branch === 'HEAD' ? undefined : branch;

  return {
    ...(head === undefined ? {} : { head }),
    ...(named === undefined ? {} : { branch: named }),
    worktreeExists: true,
  };
};

/**
 * Whether the notes directory is really ignored.
 *
 * `git check-ignore` asks git rather than reimplementing `.gitignore`, so the
 * answer stays correct when somebody adds an exclusion rule. A checkout that has
 * un-ignored the directory gets told, because a tracked handoff is a durable,
 * reviewable, stale-in-a-week artifact describing a branch that no longer exists.
 */
const isIgnored = async (): Promise<boolean> => {
  // `check-ignore -q` exits 0 when the path is ignored and 1 when it is not, so
  // the exit code is the answer and there is no output to parse.
  //
  // Asked about a *file inside* the directory rather than the directory itself:
  // `.gitignore` holds `.pi/handoffs/`, a directory pattern, and git only applies
  // it to paths it has resolved as directories. The directory does not exist yet
  // on a fresh checkout, so `check-ignore .pi/handoffs` exits 1 — "not ignored" —
  // and every write would be refused while the rule sat correctly in the file.
  try {
    const probe = await runBounded('git', ['check-ignore', '-q', `${HANDOFF_DIR}/probe.md`], {
      cwd: REPO_ROOT,
      ...GIT_BOUNDS,
    });
    return probe.code === 0;
  } catch {
    return false;
  }
};

const ENTRY = Type.Object({
  what: Type.String({ description: 'What was done, in one line.' }),
  command: Type.Optional(Type.String({ description: 'The command that proves it.' })),
  exitCode: Type.Optional(Type.Number({ description: "That command's exit code." })),
});

const FAILURE = Type.Object({
  what: Type.String({ description: 'What is broken.' }),
  reason: Type.Optional(
    Type.String({
      description:
        'Why it is still outstanding. A future reader cannot infer this, and ' +
        '"it did not work" is the reason they need.',
    }),
  ),
});

export default function handoffExtension(pi: ExtensionAPI): void {
  registerNamespace(pi, {
    name: 'handoff',
    label: 'Handoff Note',
    promptSnippet: 'Write and resume durable handoff notes for work that spans sessions',
    description:
      'Write and read durable handoff notes, kept outside tracked source in ' +
      `\`${HANDOFF_DIR}/\`. Use \`write\` before stopping on work too big for one session, and ` +
      '`read` when picking up what another session left. A note records the objective, base, ' +
      'head, branch, worktree, completed work with the commands that proved it, outstanding ' +
      'failures, and exactly one next step. 🔴 A note is a claim, not a fact: `read` compares it ' +
      'against the live repository and reports every claim that no longer holds, so a stale ' +
      'result is never repeated as if it had just been observed.',

    actions: [
      defineAction({
        action: 'write',
        summary: 'Record a handoff note. Requires an objective and exactly one next step.',
        parameters: Type.Object({
          name: Type.String({
            description:
              'Short lowercase slug, safe as a filename — e.g. "pr-f-agent-integration". ' +
              'Reusing a name replaces the previous note.',
          }),
          objective: Type.String({ description: 'One sentence: what is true when this is done.' }),
          nextStep: Type.String({
            description:
              'Exactly one action. A list of options is not a handoff, and an empty one is refused.',
          }),
          completed: Type.Optional(
            Type.Array(ENTRY, {
              description:
                'What is done, each with the command that proved it and its exit code. Empty is ' +
                'allowed and renders as "Nothing recorded".',
            }),
          ),
          failures: Type.Optional(
            Type.Array(FAILURE, {
              description:
                'Failures observed and STILL outstanding, each with why. An empty list renders ' +
                'as "None observed", which is deliberately not the same as "verified".',
            }),
          ),
        }),

        async execute(_toolCallId, params) {
          // Checked before writing. A tracked handoff is a stale artifact that
          // outlives the branch it describes, and it is reviewable.
          if (!(await isIgnored())) {
            return fail(
              `\`${HANDOFF_DIR}/\` is not gitignored in this checkout, so a note written there ` +
                'would be committed: it lands in history, appears in every clone, and goes stale ' +
                'the moment anyone else pushes.\n' +
                `Add \`${HANDOFF_DIR}/\` to .gitignore, or choose a different location. Nothing was written.`,
              { error: 'not_ignored', dir: handoffDir(REPO_ROOT) },
            );
          }

          const state = await observe();
          const note: HandoffNote = {
            name: params.name,
            writtenAt: Date.now(),
            objective: params.objective,
            completed: (params.completed ?? []) as HandoffEntry[],
            failures: (params.failures ?? []) as HandoffFailure[],
            nextStep: params.nextStep,
            worktree: REPO_ROOT,
            ...(state.head === undefined ? {} : { head: state.head }),
            ...(state.branch === undefined ? {} : { branch: state.branch }),
          };

          let path: string;
          try {
            path = writeHandoff(REPO_ROOT, note);
          } catch (error) {
            // A refusal from the note store — a bad slug, an empty objective.
            return fail((error as Error).message, { error: 'refused' });
          }

          return {
            content: [
              {
                type: 'text',
                text: [
                  `Handoff "${note.name}" written to ${path}`,
                  `  head:   ${note.head ?? 'unrecorded'}`,
                  `  branch: ${note.branch ?? 'unrecorded'}`,
                  '',
                  'It is outside tracked source, so it survives on this machine and in no clone. ' +
                    'Anyone resuming must re-derive current state before repeating a result in it.',
                ].join('\n'),
              },
            ],
            details: { name: note.name, path, head: note.head, branch: note.branch },
          };
        },
      }),

      defineAction({
        action: 'read',
        summary: 'Read a note, checked against the live repository for stale claims.',
        parameters: Type.Object({
          name: Type.Optional(
            Type.String({ description: 'Note name. Omit for the most recent note.' }),
          ),
        }),

        async execute(_toolCallId, params) {
          const names = listHandoffs(REPO_ROOT);
          if (names.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `No handoff notes in ${HANDOFF_DIR}/. (An empty set means nobody left one — ` +
                    'it does not mean there is nothing to find; check git state directly.)',
                },
              ],
              details: { count: 0 },
            };
          }

          const name = params.name ?? names[names.length - 1];
          if (name === undefined) {
            return fail(
              `No note named "${params.name}" in this checkout. Available: ${names.join(', ')}`,
              {
                error: 'unknown_note',
                available: names,
              },
            );
          }

          const text = readHandoff(REPO_ROOT, name);
          if (text === undefined) {
            return fail(
              `No note named "${name}". Available: ${names.join(', ')}. Nothing was resumed.`,
              { error: 'unknown_note', available: names },
            );
          }

          // The note is parsed for its position so it can be checked. Only the
          // fields the staleness comparison needs are read back, and a note
          // without them is reported as uncheckable rather than as fresh.
          const state = await observe();
          const parsed = {
            name,
            writtenAt: 0,
            objective: '',
            completed: [],
            failures: [],
            nextStep: '',
            worktree: handoffDir(REPO_ROOT),
            head: pick(text, 'head'),
            branch: pick(text, 'branch'),
          };

          const claims = staleClaims(parsed, state);
          return {
            content: [
              {
                type: 'text',
                text: [text, '', '─'.repeat(60), renderResumeWarning(parsed, claims)].join('\n'),
              },
            ],
            details: { name, stale: claims.length > 0, staleFields: claims.map((c) => c.field) },
          };
        },
      }),

      defineAction({
        action: 'list',
        summary: 'List the notes in this checkout.',
        parameters: Type.Object({}),

        async execute() {
          const names = listHandoffs(REPO_ROOT);
          return {
            content: [
              {
                type: 'text',
                text:
                  names.length === 0
                    ? `No handoff notes in ${HANDOFF_DIR}/.`
                    : `${names.length} note(s) in ${HANDOFF_DIR}/:\n${names
                        .map((entry) => `  ${entry}`)
                        .join('\n')}`,
              },
            ],
            details: { count: names.length },
          };
        },
      }),
    ],
  });
}

/** Read one `- \`value\`` bullet out of a rendered note's Position block. */
const pick = (text: string, field: 'head' | 'branch'): string | undefined => {
  const match = new RegExp(`^- \`${field}\`: \`([^\`]*)\``, 'm').exec(text);
  const value = match?.[1];
  // "unrecorded" is what the renderer writes when the field was absent, and it is
  // not a claim, so it must not become one.
  return value === undefined || value === 'unrecorded' ? undefined : value;
};
