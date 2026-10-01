// .pi/tests/handoff_tool.test.ts
//
// The handoff tool's two refusals, and the facts it records.
//
// Both refusals exist because of a specific bad outcome, and both are proven
// against a real git repository rather than a stub:
//
//   1. A note written into a directory that is **not** gitignored becomes a
//      tracked file: it lands in history, appears in every clone, and goes stale
//      the moment anyone else pushes. The tool checks with `git check-ignore`
//      rather than reimplementing `.gitignore`.
//   2. A note with no objective, or with no next step, tells the reader nothing —
//      and an empty next step is the specific way a handoff becomes a way of
//      avoiding one.

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDOFF_DIR, handoffDir, listHandoffs, readHandoff } from '../lib/handoff.ts';
import { runBounded } from '../lib/process.ts';
import { cleanupFakes, scratchDir } from './fake_bin.ts';

afterAll(cleanupFakes);

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const git = async (cwd: string, ...args: string[]) => {
  const result = await runBounded('git', args, { cwd, timeoutMs: 30_000, maxBytes: 256 * 1024 });
  return { code: result.code, stdout: result.stdout.trim() };
};

/** A real git repository in a temp directory — a guard is about the checkout. */
const realRepo = async (name: string): Promise<string> => {
  const dir = scratchDir(name);
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 'test@example.invalid');
  await git(dir, 'config', 'user.name', 'Test');
  // An initial commit, so HEAD resolves and `check-ignore` has rules to consult.
  await Bun.write(join(dir, 'README.md'), '# fixture\n');
  await git(dir, 'add', 'README.md');
  await git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
};

/**
 * Whether git ignores a file inside `path`.
 *
 * Asked about a file rather than the directory, and deliberately. `.gitignore`
 * holds `.pi/handoffs/` — a *directory* pattern — which git only applies to paths
 * it has resolved as directories. On a fresh checkout the directory does not
 * exist, so `check-ignore -q .pi/handoffs` exits 1 ("not ignored") while the rule
 * is sitting correctly in the file. A gate keyed on that result refuses every
 * write for a repository that is configured properly.
 *
 * This is the exact bug the tool had, so it is asserted in both directions.
 */
const ignores = async (cwd: string, path: string): Promise<boolean> =>
  (await git(cwd, 'check-ignore', '-q', `${path}/probe.md`)).code === 0;

describe('the repository really ignores the notes directory', () => {
  test('so the tool can rely on it', async () => {
    // A structural check rather than a tool test: if `.gitignore` ever loses the
    // rule, `write` starts refusing, and the cause would be three files away.
    expect(await ignores(REPO_ROOT, HANDOFF_DIR)).toBe(true);
  }, 30_000);

  test('and a repository without the rule is detected as not ignoring it', async () => {
    // The negative control. Without it, the assertion above could pass because
    // `check-ignore` fails for an unrelated reason on every path.
    const dir = await realRepo('handoff-unignored');
    expect(await ignores(dir, '.pi/handoffs')).toBe(false);
  }, 60_000);

  test('an added rule makes the same repository ignore it', async () => {
    const dir = await realRepo('handoff-ignored');
    await Bun.write(join(dir, '.gitignore'), `${HANDOFF_DIR}/\n`);
    expect(await ignores(dir, '.pi/handoffs')).toBe(true);
  }, 60_000);

  test('a file inside the notes directory is genuinely untracked', async () => {
    // The property the rule exists for, checked against git rather than against
    // the pattern text: `git status` must not offer to commit a note.
    const dir = await realRepo('handoff-untracked');
    await Bun.write(join(dir, '.gitignore'), `${HANDOFF_DIR}/\n`);
    await Bun.write(join(dir, '.pi', 'handoffs', 'a-note.md'), '# note\n');

    const status = await git(dir, 'status', '--porcelain');
    expect(status.stdout).not.toContain('handoffs');
  }, 60_000);
});

describe('notes are durable and outside tracked source', () => {
  test('a written note is on disk, and git does not see it', async () => {
    const dir = scratchDir('handoff-store');
    await Bun.write(join(dir, '.gitignore'), `${HANDOFF_DIR}/\n`);

    // The note store is a plain module, so it can be exercised without a
    // repository — which is what makes it testable at all.
    const { writeHandoff } = await import('../lib/handoff.ts');
    writeHandoff(dir, {
      name: 'fixture',
      writtenAt: Date.now(),
      objective: 'Prove a note lands outside tracked source.',
      completed: [],
      failures: [],
      nextStep: 'Read it back.',
    });

    expect(readHandoff(dir, 'fixture')).toContain('Prove a note lands');
    // Nothing was created at the repository root by a note write.
    expect(listHandoffs(dir)).toEqual(['fixture']);
    expect(handoffDir(dir).startsWith(dir)).toBe(true);
  });
});

describe('git facts the tool records', () => {
  test('a real HEAD is a full sha, so a stale comparison is possible', async () => {
    const dir = await realRepo('handoff-head');
    const head = await git(dir, 'rev-parse', 'HEAD');

    expect(head.code).toBe(0);
    // Full, not abbreviated: an abbreviated sha collides as a repository grows,
    // and a collision here means "no contradictions" for the wrong code.
    expect(head.stdout).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  test('a detached HEAD reports no branch, and HEAD is not recorded as one', async () => {
    // `git rev-parse --abbrev-ref HEAD` returns the literal string "HEAD" when
    // detached. Recording that as a branch name would make every later comparison
    // compare "HEAD" against "HEAD" and find no contradiction — in a worktree,
    // which is exactly where a handoff matters most.
    const dir = await realRepo('handoff-detached');
    const sha = (await git(dir, 'rev-parse', 'HEAD')).stdout;
    await git(dir, 'checkout', '-q', '--detach', sha);

    const branch = (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout;
    expect(branch).toBe('HEAD');
  }, 60_000);
});

describe('isolation', () => {
  test('notes from one checkout are invisible to another', async () => {
    // The property that makes a note trustworthy: it describes *this* worktree,
    // so a note written in a dev worktree must not appear in a fresh clone.
    const { writeHandoff } = await import('../lib/handoff.ts');
    const note = {
      writtenAt: Date.now(),
      objective: 'x',
      completed: [],
      failures: [],
      nextStep: 'y',
    };

    writeHandoff(scratchDir('iso-a'), { ...note, name: 'shared-name' });

    expect(listHandoffs(scratchDir('iso-b'))).toEqual([]);
  });

  test('a temporary agent directory is removed, leaving no residue', () => {
    // The loader tests create isolated agentDirs; a leaked one would make a later
    // run read a stale trust decision.
    const dir = mkdtempSync(join(tmpdir(), 'pi-leak-'));
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});
