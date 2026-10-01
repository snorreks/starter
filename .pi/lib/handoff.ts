// .pi/lib/handoff.ts
//
// Durable handoff notes, kept **outside tracked source**.
//
// 🔴 Why not a tracked file: a handoff note is evidence about one moment in one
// worktree. Committed, it lands in the repository's history, gets picked up by
// `bun run guard`'s source checks, appears in every clone, and goes stale the
// moment anyone else pushes. So these live under `.pi/handoffs/`, which is
// gitignored — durable for the machine that produced them, invisible to git.
//
// 🔴 The rule that makes resuming safe: **old evidence is a claim, not a fact.**
// `readForResume()` returns a note *and* a list of the specific claims that no
// longer hold — the head moved, the branch changed, the worktree is gone. A
// resuming agent is told to re-derive state before believing any of it. Without
// that check the failure mode is precise and nasty: the agent reads "3 tests
// passing" from three hours ago, the code underneath has changed since, and it
// reports a pass it never observed.
//
// This is a written brief on purpose. The repository has a dormant autonomous
// contract runner under `docs/contracts/`; the maintained answer to "how does an
// agent pick work up where another left off" is a short note plus a state check,
// not a second pipeline.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Repo-relative directory, **without** a trailing separator.
 *
 * No trailing slash, and that is load-bearing: `.gitignore` matches `.pi/handoffs/`
 * as a *directory* pattern, which only matches paths git has resolved as
 * directories. `git check-ignore -q .pi/handoffs` (no slash) therefore exits 1 —
 * "not ignored" — for a directory that is ignored, and a tool gating on that
 * result refuses every write while the rule sits correctly in `.gitignore`.
 */
export const HANDOFF_DIR = '.pi/handoffs';

export const handoffDir = (root: string): string => join(root, HANDOFF_DIR);

/** One completed action, with what it actually produced. */
export interface HandoffEntry {
  what: string;
  /** Command run, and its exit code. `null` when the command did not exit. */
  command?: string;
  exitCode?: number;
}

/** A failure that was observed and is still outstanding. */
export interface HandoffFailure {
  what: string;
  /** Why it is still outstanding — never assume the next agent can tell. */
  reason?: string;
}

export interface HandoffNote {
  /** Slug, safe as a filename. */
  name: string;
  /** Epoch ms. */
  writtenAt: number;
  /** One sentence: what this work is trying to achieve. */
  objective: string;
  /** Commit this work started from. */
  base?: string;
  /** Commit this work is at. */
  head?: string;
  branch?: string;
  /** Absolute path of the checkout this belongs to. */
  worktree?: string;
  completed: HandoffEntry[];
  /** Failures observed and not fixed. Empty means "none observed", not "all fine". */
  failures: HandoffFailure[];
  /** Exactly one next action. Not a list — a list is not a handoff. */
  nextStep: string;
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class HandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandoffError';
  }
}

const notePath = (root: string, name: string): string => join(handoffDir(root), `${name}.md`);

/**
 * Render a note as Markdown.
 *
 * Markdown rather than JSON because a human is expected to read one of these
 * during a handoff conversation, and because it stays legible in a terminal
 * without a viewer.
 */
export const renderNote = (note: HandoffNote): string => {
  const lines = [
    `# Handoff — ${note.name}`,
    '',
    `Written: ${new Date(note.writtenAt).toISOString()}`,
    '',
    '## Objective',
    '',
    note.objective,
    '',
    '## Position',
    '',
    `- base: \`${note.base ?? 'unrecorded'}\``,
    `- head: \`${note.head ?? 'unrecorded'}\``,
    `- branch: \`${note.branch ?? 'unrecorded'}\``,
    `- worktree: \`${note.worktree ?? 'unrecorded'}\``,
    '',
    '## Completed',
    '',
  ];

  if (note.completed.length === 0) {
    lines.push('_Nothing recorded._');
  }
  for (const entry of note.completed) {
    const proof =
      entry.command === undefined
        ? ''
        : ` — \`${entry.command}\`${entry.exitCode === undefined ? '' : ` → exit ${entry.exitCode}`}`;
    lines.push(`- ${entry.what}${proof}`);
  }

  lines.push('', '## Outstanding failures', '');
  if (note.failures.length === 0) {
    // Deliberately not "all checks pass". An empty list means nobody recorded a
    // failure, which is a different claim.
    lines.push('_None observed. This is not the same as "verified"._');
  }
  for (const failure of note.failures) {
    lines.push(`- ${failure.what}${failure.reason === undefined ? '' : ` — ${failure.reason}`}`);
  }

  lines.push('', '## Next step', '', note.nextStep, '');
  return lines.join('\n');
};

/**
 * Write a note atomically.
 *
 * Temp + rename: a half-written note read by a resuming agent is worse than no
 * note, because its absence is obvious and its corruption is not.
 */
export const writeHandoff = (root: string, note: HandoffNote): string => {
  if (!SLUG.test(note.name)) {
    throw new HandoffError(
      `handoff name "${note.name}" must match ${SLUG} — lowercase, no spaces, safe as a filename.`,
    );
  }
  if (note.objective.trim() === '') {
    throw new HandoffError(
      'a handoff needs an objective; an empty one tells the next agent nothing.',
    );
  }
  if (note.nextStep.trim() === '') {
    throw new HandoffError('a handoff needs one next step; a list of options is not a handoff.');
  }

  mkdirSync(handoffDir(root), { recursive: true });
  const path = notePath(root, note.name);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, renderNote(note));
  renameSync(temp, path);
  return path;
};

export const readHandoff = (root: string, name: string): string | undefined => {
  const path = notePath(root, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};

/** Note names, newest first. Empty when there are none — an absence, not an error. */
export const listHandoffs = (root: string): string[] => {
  const dir = handoffDir(root);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .map((name) => name.replace(/\.md$/, ''))
    .sort();
};

/**
 * The live repository facts a note is allowed to claim something about.
 *
 * Supplied by the caller rather than read from git here, so this module stays a
 * pure note store and the comparison itself is testable without a repository.
 */
export interface ObservedState {
  head?: string;
  branch?: string;
  worktreeExists?: boolean;
}

/** One claim in a note that current state contradicts. */
export interface StaleClaim {
  field: 'head' | 'branch' | 'worktree';
  said: string;
  now: string;
  /** What the difference means for resuming. */
  consequence: string;
}

/**
 * Compare a note's claims against live state.
 *
 * Returns the contradictions. An empty array only means none were detected —
 * unrecorded claims and unavailable observations cannot establish agreement,
 * which is why the caller must still re-derive state rather than trust the note.
 */
export const staleClaims = (note: HandoffNote, observed: ObservedState): StaleClaim[] => {
  const claims: StaleClaim[] = [];

  if (note.head !== undefined && observed.head !== undefined && note.head !== observed.head) {
    claims.push({
      field: 'head',
      said: note.head,
      now: observed.head,
      consequence:
        'the branch moved since the note was written, so every result it records was ' +
        'observed on different code. Re-run them before repeating them.',
    });
  }

  if (
    note.branch !== undefined &&
    observed.branch !== undefined &&
    note.branch !== observed.branch
  ) {
    claims.push({
      field: 'branch',
      said: note.branch,
      now: observed.branch,
      consequence:
        'the checkout is on a different branch than the note describes; it may not even ' +
        'contain this work.',
    });
  }

  if (note.worktree !== undefined && observed.worktreeExists === false) {
    claims.push({
      field: 'worktree',
      said: note.worktree,
      now: 'missing',
      consequence:
        'the worktree this note describes no longer exists. Nothing in it can be resumed; ' +
        'the branch has to be re-created from a base ref instead.',
    });
  }

  return claims;
};

/**
 * The preamble a resuming agent reads before believing a note.
 *
 * Returns a refusal-worthy explanation rather than a summary, because the whole
 * point is that the note is not self-validating.
 */
export const renderResumeWarning = (note: HandoffNote, claims: StaleClaim[]): string => {
  if (claims.length === 0) {
    return (
      `Note "${note.name}" was written ${new Date(note.writtenAt).toISOString()} and no ` +
      'position contradictions were detected. That is NOT evidence that its results still hold. ' +
      'Re-derive current state with ' +
      '`repo_task list` / `git status` before trusting any command result in it.'
    );
  }

  const lines = [
    `Note "${note.name}" is STALE. ${claims.length} claim(s) it makes no longer match this checkout:`,
    '',
  ];
  for (const claim of claims) {
    lines.push(`  • ${claim.field}: note said ${claim.said}; now ${claim.now}`);
    lines.push(`    → ${claim.consequence}`);
  }
  lines.push('', 'Do not repeat a command result from this note without re-running it.');
  return lines.join('\n');
};
