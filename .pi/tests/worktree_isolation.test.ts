// .pi/tests/worktree_isolation.test.ts
//
// Two worktrees on one machine must not share agent state.
//
// 🔴 Why this needs proving rather than asserting: the failure is invisible from
// inside either worktree. Worktrees share the repository's `.git`, so anything
// keyed on a path relative to the *repository* — a journal, a notes directory, a
// lockfile — is shared too. Two agents then stop jobs belonging to each other, or
// resume from a note describing a branch the reader is not on.
//
// What is deliberately NOT tested here: git's own worktree mechanism, `bun
// install`, or whether Herdr creates worktrees correctly. Those belong to git, bun
// and herdr. What is tested is that this project's state is keyed on the
// **checkout path**, not on the repository.
//
// No worktree is created here. The check is structural plus a real-filesystem
// probe in a second directory, because creating a worktree to prove a path is
// path-keyed would be a slow way to ask a simple question.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { handoffDir, listHandoffs, writeHandoff } from '../lib/handoff.ts';
import { jobDir, jobJsonPath, listJobs } from '../lib/jobs.ts';
import { cleanupFakes, scratchDir } from './fake_bin.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const note = (name: string) => ({
  name,
  writtenAt: Date.now(),
  objective: 'An objective, so the note is not refused.',
  completed: [],
  failures: [],
  nextStep: 'A next step.',
});

describe('state is keyed on the checkout, not the repository', () => {
  test('a second checkout gets its own job journal', async () => {
    // Two directories, both with a job recorded. If the journal were keyed on the
    // repository rather than the path, `listJobs` would return both entries for
    // either directory.
    const a = scratchDir('iso-jobs-a');
    const b = scratchDir('iso-jobs-b');

    for (const root of [a, b]) {
      mkdirSync(jobDir(root), { recursive: true });
      writeFileSync(
        jobJsonPath(root, 'job-only-here'),
        JSON.stringify({
          id: 'job-only-here',
          command: 'bun',
          args: ['run', 'dev'],
          cwd: root,
          pid: 4242,
          token: 't',
          startedAt: 1,
          state: 'running',
          lastOutputAt: 1,
        }),
      );
    }

    expect(listJobs(a).map((job) => job.id)).toEqual(['job-only-here']);
    expect(listJobs(b).map((job) => job.id)).toEqual(['job-only-here']);
    // And the cwd each one recorded is its own, which is what makes the entries
    // distinguishable in practice.
    expect(listJobs(a)[0]?.cwd).toBe(a);
    expect(listJobs(b)[0]?.cwd).toBe(b);
  });

  test('a second checkout gets its own notes directory', () => {
    const a = scratchDir('iso-notes-a');
    const b = scratchDir('iso-notes-b');

    writeHandoff(a, note('work-in-a'));

    expect(listHandoffs(a)).toEqual(['work-in-a']);
    // The failure this prevents: agent B reads agent A's note, sees a base and a
    // next step for a branch it does not have, and acts on it.
    expect(listHandoffs(b)).toEqual([]);
    expect(handoffDir(b).startsWith(b)).toBe(true);
  });

  test('a note records the checkout it belongs to', () => {
    // The caller supplies `worktree`, because the note store does not know where it
    // is being written from — it is handed a directory. The tool supplies
    // `REPO_ROOT`; this asserts the field survives into the rendered note, which is
    // the part a reader actually sees.
    const root = scratchDir('iso-cwd');
    writeHandoff(root, { ...note('with-cwd'), worktree: root });

    const rendered = readFileSync(join(handoffDir(root), 'with-cwd.md'), 'utf8');
    // Without this, a note read from the wrong worktree names no path and gives a
    // reader nothing to check.
    expect(rendered).toContain(root);
  });

  test('a note without a recorded checkout says so, rather than showing a blank', () => {
    // "unrecorded" is deliberate over an empty field: a reader can tell the
    // difference between "I did not record this" and "there is nothing here".
    const root = scratchDir('iso-noworktree');
    writeHandoff(root, note('no-worktree'));

    const rendered = readFileSync(join(handoffDir(root), 'no-worktree.md'), 'utf8');
    expect(rendered).toContain('- worktree: `unrecorded`');
  });

  test('the real checkout already has its journal directory ignored', () => {
    // Both runtime directories must be untracked, or a journal entry describing
    // somebody's dev server lands in git.
    expect(existsSync(join(REPO_ROOT, '.gitignore'))).toBe(true);
    const ignored = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(ignored).toContain('.pi/background-tasks/');
    expect(ignored).toContain('.pi/handoffs/');
  });
});

describe('the loader uses an isolated agentDir', () => {
  test('so a developer trust decision cannot change the result', async () => {
    // The loader tests pass a throwaway `agentDir` for this reason: a machine
    // where this project happens to be trusted in `~/.pi` would otherwise produce
    // a different result from CI's, and the difference would look like a layout
    // defect.
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');

    const here = mkdtempSync(join(tmpdir(), 'pi-iso-here-'));
    const there = mkdtempSync(join(tmpdir(), 'pi-iso-there-'));
    try {
      const extension = join(here, 'only-here.ts');
      writeFileSync(extension, 'export default function () {}');
      writeFileSync(join(here, 'settings.json'), JSON.stringify({ extensions: [extension] }));
      const hereSettings = SettingsManager.create(REPO_ROOT, here);
      const thereSettings = SettingsManager.create(REPO_ROOT, there);
      const hereLoader = new DefaultResourceLoader({
        cwd: REPO_ROOT,
        agentDir: here,
        settingsManager: hereSettings,
      });
      const thereLoader = new DefaultResourceLoader({
        cwd: REPO_ROOT,
        agentDir: there,
        settingsManager: thereSettings,
      });
      await hereLoader.reload();
      await thereLoader.reload();

      expect(hereLoader.getExtensions().errors).toEqual([]);
      expect(thereLoader.getExtensions().errors).toEqual([]);
      expect(hereLoader.getExtensions().extensions.map((entry) => entry.path)).toContain(extension);
      expect(thereLoader.getExtensions().extensions.map((entry) => entry.path)).not.toContain(
        extension,
      );
    } finally {
      rmSync(here, { recursive: true, force: true });
      rmSync(there, { recursive: true, force: true });
    }
  });
});

afterEach(() => cleanupFakes());
