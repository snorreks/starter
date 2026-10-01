// .pi/tests/handoff.test.ts
//
// Durable handoff notes, and the staleness check that makes resuming safe.
//
// The failure this file exists to prevent is precise and expensive: a resuming
// agent reads "3 tests passing" from a note written three hours ago, the code
// underneath has changed since, and it reports a pass it never observed. The
// guard is that old evidence is a *claim*, and the claim is checked against live
// state before anything believes it.

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  HANDOFF_DIR,
  HandoffError,
  type HandoffNote,
  handoffDir,
  listHandoffs,
  readHandoff,
  renderNote,
  renderResumeWarning,
  staleClaims,
  writeHandoff,
} from '../lib/handoff.ts';
import { cleanupFakes, scratchDir } from './fake_bin.ts';

afterAll(cleanupFakes);

const note = (overrides: Partial<HandoffNote> = {}): HandoffNote => ({
  name: 'pr-f-agent-integration',
  writtenAt: 1_760_000_000_000,
  objective: "Integrate agent tooling around the repository's real commands.",
  base: '4ca9d1bd6ae1bac3d23479be900868e25017cd53',
  head: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
  branch: 'pr-f-agent-integration',
  worktree: '/home/u/.herdr/worktrees/starter/pr-f-agent-integration',
  completed: [{ what: 'Bounded subprocess runner', command: 'bun run typecheck', exitCode: 0 }],
  failures: [],
  nextStep: 'Rebase onto main, then re-run the loader smoke test.',
  ...overrides,
});

describe('writing a note', () => {
  test('lands outside tracked source', () => {
    const dir = scratchDir('handoff');
    const path = writeHandoff(dir, note());

    // The property, not just the path: a handoff committed to the repository ends
    // up in history, in every clone, and goes stale the moment anyone else pushes.
    expect(path.startsWith(join(dir, HANDOFF_DIR))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test('records every field a resuming agent needs to orient itself', () => {
    const dir = scratchDir('handoff');
    writeHandoff(dir, note());
    const rendered = readHandoff(dir, 'pr-f-agent-integration') as string;

    for (const heading of [
      '## Objective',
      '## Position',
      '## Completed',
      '## Outstanding failures',
      '## Next step',
    ]) {
      expect(rendered).toContain(heading);
    }
    expect(rendered).toContain('4ca9d1bd6ae1bac3d23479be900868e25017cd53');
    expect(rendered).toContain('pr-f-agent-integration');
    expect(rendered).toContain('exit 0');
  });

  test('an empty failure list does not read as a clean bill of health', () => {
    // "Nobody recorded a failure" and "everything was verified" are different
    // claims, and only the second one is usually false.
    const rendered = renderNote(note());
    expect(rendered).toContain('None observed');
    expect(rendered).toContain('not the same as "verified"');
  });

  test('refuses a note with no objective or no next step', () => {
    const dir = scratchDir('handoff');
    // A note that says nothing about the goal, or offers a menu instead of an
    // action, is not a handoff — it is a way of avoiding the handoff.
    expect(() => writeHandoff(dir, note({ objective: '  ' }))).toThrow(HandoffError);
    expect(() => writeHandoff(dir, note({ nextStep: '' }))).toThrow(HandoffError);
  });

  test('refuses a name that is not safe as a filename', () => {
    const dir = scratchDir('handoff');
    expect(() => writeHandoff(dir, note({ name: '../escape' }))).toThrow(HandoffError);
    expect(() => writeHandoff(dir, note({ name: 'Has Spaces' }))).toThrow(HandoffError);
  });

  test('a rewrite replaces the note atomically, leaving no partial file', () => {
    // A half-written note read by a resuming agent is worse than none, because
    // its absence is obvious and its corruption is not.
    const dir = scratchDir('handoff');
    writeHandoff(dir, note());
    expect(readHandoff(dir, 'pr-f-agent-integration')).toContain('Rebase onto main');

    writeHandoff(dir, note({ nextStep: 'A different next step.' }));
    const rewritten = readHandoff(dir, 'pr-f-agent-integration') as string;
    expect(rewritten).toContain('A different next step');
    expect(rewritten).not.toContain('Rebase onto main');

    // No `.tmp` left over, which is what a failed rename would leave.
    const leftovers = listHandoffs(dir).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('reading notes', () => {
  test('an absent note is undefined, and an empty set is empty', () => {
    const dir = scratchDir('handoff');
    expect(readHandoff(dir, 'nope')).toBeUndefined();
    expect(listHandoffs(dir)).toEqual([]);
  });

  test('lists the notes that exist', () => {
    const dir = scratchDir('handoff');
    writeHandoff(dir, note({ name: 'first' }));
    writeHandoff(dir, note({ name: 'second' }));

    expect(listHandoffs(dir).sort()).toEqual(['first', 'second']);
    expect(handoffDir(dir).startsWith(dir)).toBe(true);
  });
});

describe('staleness — old evidence is a claim, not a fact', () => {
  const current = note();

  test('a matching checkout still produces no blank cheque', () => {
    // Even with nothing contradicting it, the note must not be self-certifying.
    const claims = staleClaims(current, {
      head: current.head,
      branch: current.branch,
      worktreeExists: true,
    });
    expect(claims).toEqual([]);

    const warning = renderResumeWarning(current, claims);
    expect(warning).toContain('NOT evidence');
    expect(warning).toContain('Re-derive current state');
  });

  test('a moved head marks every recorded result as suspect', () => {
    const claims = staleClaims(current, { head: 'ffffffffffffffffffffffffffffffffffffffff' });

    expect(claims).toHaveLength(1);
    expect(claims[0]?.field).toBe('head');
    // The consequence, not just the fact: the model has to know that the results
    // were observed on different code.
    expect(claims[0]?.consequence).toContain('Re-run them');
    expect(renderResumeWarning(current, claims)).toContain('STALE');
  });

  test('a different branch means the work may not be here at all', () => {
    const claims = staleClaims(current, { head: current.head, branch: 'main' });

    expect(claims.map((claim) => claim.field)).toEqual(['branch']);
    expect(claims[0]?.consequence).toContain('may not even');
  });

  test('a vanished worktree means nothing in it can be resumed', () => {
    const claims = staleClaims(current, {
      head: current.head,
      branch: current.branch,
      worktreeExists: false,
    });

    expect(claims.map((claim) => claim.field)).toEqual(['worktree']);
    expect(claims[0]?.consequence).toContain('no longer exists');
  });

  test('several contradictions are all reported, each with its consequence', () => {
    const claims = staleClaims(current, {
      head: 'ffffffffffffffffffffffffffffffffffffffff',
      branch: 'main',
      worktreeExists: false,
    });

    expect(claims.map((claim) => claim.field)).toEqual(['head', 'branch', 'worktree']);
    expect(claims.every((claim) => claim.consequence.length > 20)).toBe(true);
  });

  test('a note that recorded nothing is not treated as stale', () => {
    // Absence of a claim is not a false claim. Otherwise every note without a
    // recorded branch would report itself stale.
    const bare = note({ head: undefined, branch: undefined, worktree: undefined });
    expect(staleClaims(bare, { head: 'x', branch: 'y', worktreeExists: false })).toEqual([]);
  });

  test('unknown state is not treated as contradiction', () => {
    // `worktreeExists` undefined means "not observed", which is different from
    // observed-false. Conflating them would mark every note stale on a machine
    // where the check could not run.
    expect(staleClaims(current, { head: current.head, branch: current.branch })).toEqual([]);
  });

  test('the stale warning tells the model not to repeat an unverified result', () => {
    const claims = staleClaims(current, { head: 'ffffffffffffffffffffffffffffffffffffffff' });
    expect(renderResumeWarning(current, claims)).toContain(
      'Do not repeat a command result from this note without re-running it.',
    );
  });
});

describe('rendering is readable without a viewer', () => {
  test('the note is Markdown a human can read mid-conversation', () => {
    const rendered = renderNote(note());
    expect(rendered).toContain('# Handoff — pr-f-agent-integration');
    // Timestamped in ISO, so two notes can be ordered by eye and by machine.
    expect(rendered).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('a failure carries the reason it is still outstanding', () => {
    const rendered = renderNote(
      note({
        failures: [
          { what: 'test:browser cannot find chromium_headless_shell', reason: 'store path absent' },
        ],
      }),
    );

    expect(rendered).toContain('test:browser cannot find');
    expect(rendered).toContain('store path absent');
  });
});
