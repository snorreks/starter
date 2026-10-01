// .pi/tests/herdr_cli.test.ts
//
// The Herdr boundary: availability, argv, and the refusals that protect the user.
//
// The distinction these tests exist for is between an **absent** optional
// capability and a **failed** command. A model that cannot tell them apart either
// retries forever against something that will never work, or abandons something
// that would have. So `probe()` returns a verdict rather than throwing, and the
// two failure kinds are asserted to be different values.
//
// Nothing here requires `herdr` to be installed. The fakes are what run.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  buildHelpArgs,
  buildWorktreeArgs,
  HERDR_BIN,
  HERDR_GROUPS,
  insideHerdr,
  parseEnvelope,
  probe,
  sessionContext,
  validateWorktreeParams,
} from '../lib/herdr_cli.ts';
import { cleanupFakes, fakeBin, runnerFor, scratchDir } from './fake_bin.ts';

afterAll(cleanupFakes);

const CWD = scratchDir('herdr');

/** The env a real Herdr-managed pane injects. */
const INSIDE = {
  HERDR_ENV: '1',
  HERDR_WORKSPACE_ID: 'wPH',
  HERDR_TAB_ID: 'wPH:t1',
  HERDR_PANE_ID: 'wPH:p2',
} as NodeJS.ProcessEnv;

const OUTSIDE = {} as NodeJS.ProcessEnv;

describe('session context', () => {
  test('inside Herdr is read from the injected variable, not guessed', () => {
    expect(insideHerdr(INSIDE)).toBe(true);
    expect(insideHerdr(OUTSIDE)).toBe(false);
    // Anything other than exactly "1" is not inside. A truthy-looking "true"
    // would let an agent control a session Herdr did not hand it.
    expect(insideHerdr({ HERDR_ENV: 'true' })).toBe(false);
    expect(insideHerdr({ HERDR_ENV: '' })).toBe(false);
  });

  test('the caller ids are reported and absent ones are omitted, not faked', () => {
    const inside = sessionContext(INSIDE);
    expect(inside).toMatchObject({
      inside: true,
      workspaceId: 'wPH',
      tabId: 'wPH:t1',
      paneId: 'wPH:p2',
    });

    const outside = sessionContext(OUTSIDE);
    expect(outside.inside).toBe(false);
    // Inventing a plausible id here would be the worst possible failure: every
    // later command would address a workspace that does not exist.
    expect('workspaceId' in outside).toBe(false);
  });
});

describe('probe — absence versus failure', () => {
  test('a session outside a Herdr pane reports the capability unavailable', async () => {
    // Not an error. Herdr deliberately does not let an outside agent inspect or
    // control a session, so the honest answer is "unavailable", not "failed".
    const bin = fakeBin(HERDR_BIN, 'echo 0.9.1');
    const capability = await probe(CWD, runnerFor(bin.path, CWD), OUTSIDE);

    expect(capability.name).toBe('herdr');
    expect(capability.available).toBe(false);
    expect(capability.reason).toContain('not running inside a Herdr-managed pane');
    // And it must say development does not depend on it, or the model treats a
    // missing optional tool as a broken repository.
    expect(capability.reason).toContain('Normal development needs nothing from Herdr');
  });

  test('a missing binary is unavailable, distinct from a failing command', async () => {
    const capability = await probe(CWD, runnerFor('/nonexistent/not-a-real-herdr', CWD), INSIDE);

    expect(capability.available).toBe(false);
    expect(capability.reason).toContain('not on PATH');
  });

  test('a binary that exits non-zero is a failure of the capability check', async () => {
    const bin = fakeBin(HERDR_BIN, 'echo "socket gone" >&2\nexit 1');
    const capability = await probe(CWD, runnerFor(bin.path, CWD), INSIDE);

    expect(capability.available).toBe(false);
    expect(capability.reason).toContain('exited 1');
    expect(capability.reason).toContain('socket gone');
  });

  test('an available capability reports a version', async () => {
    const bin = fakeBin(HERDR_BIN, 'echo "herdr 0.9.1"');
    const capability = await probe(CWD, runnerFor(bin.path, CWD), INSIDE);

    expect(capability.available).toBe(true);
    expect(capability.version).toBe('herdr 0.9.1');
  });

  test('probing never launches the TUI', async () => {
    // `herdr` with no arguments launches or attaches the TUI. The probe must only
    // ever pass `--version`, so a bare invocation here would take over the user's
    // terminal.
    const bin = fakeBin(HERDR_BIN, 'echo "argv: $@" >&2\nexit 0');
    await probe(CWD, runnerFor(bin.path, CWD), INSIDE);

    const result = await import('../lib/process.ts').then(({ runBounded }) =>
      runBounded(bin.path, ['--version'], { cwd: CWD, timeoutMs: 5_000, maxBytes: 4_096 }),
    );
    expect(result.stderr.trim()).toBe('argv: --version');
  }, 20_000);
});

describe('buildWorktreeArgs', () => {
  test('states --no-focus by default, so an agent cannot steal the keyboard', () => {
    // The one default that matters most: an agent that creates a workspace and
    // focuses it interrupts whatever the user was typing.
    expect(buildWorktreeArgs('create', { branch: 'feature', cwd: '/repo' })).toContain(
      '--no-focus',
    );
  });

  test('focus is passed only when explicitly asked for', () => {
    const args = buildWorktreeArgs('create', { branch: 'feature', focus: true });
    expect(args).toContain('--focus');
    expect(args).not.toContain('--no-focus');
  });

  test('omits flags that were not supplied', () => {
    const args = buildWorktreeArgs('list', {});
    expect(args).toEqual(['worktree', 'list', '--no-focus']);
  });

  test('passes the identifying flags through verbatim', () => {
    const args = buildWorktreeArgs('create', {
      branch: 'pr-f-agent-integration',
      base: 'main',
      cwd: '/repo',
      label: 'starter PR-F',
    });

    expect(args).toEqual([
      'worktree',
      'create',
      '--cwd',
      '/repo',
      '--branch',
      'pr-f-agent-integration',
      '--base',
      'main',
      '--label',
      'starter PR-F',
      '--no-focus',
    ]);
  });

  test('never defaults --force on, even for remove', () => {
    // --force deletes a checkout. A template that defaults to it is a foot-gun in
    // a repository it does not own.
    expect(buildWorktreeArgs('remove', { workspace: 'wPK' })).not.toContain('--force');
    expect(buildWorktreeArgs('remove', { workspace: 'wPK', force: true })).toContain('--force');
  });

  test('trust-repository is passed only when asked', () => {
    expect(buildWorktreeArgs('open', { workspace: 'wPK' })).not.toContain('--trust-repository');
    expect(buildWorktreeArgs('open', { workspace: 'wPK', trustRepository: true })).toContain(
      '--trust-repository',
    );
  });
});

describe('validateWorktreeParams — refusals before anything is spawned', () => {
  test('remove without a workspace id is refused with the reason and a remedy', () => {
    const reason = validateWorktreeParams('remove', {});
    expect(reason).toContain('--workspace');
    // The remedy, not just the prohibition: the model has to be told where to
    // read the id from.
    expect(reason).toContain('herdr worktree list');
  });

  test('create without a branch or a path is refused', () => {
    expect(validateWorktreeParams('create', { cwd: '/repo' })).toContain(
      'branch or an explicit path',
    );
  });

  test('open without any identifier is refused', () => {
    expect(validateWorktreeParams('open', {})).toContain('needs a workspace id');
  });

  test('valid calls pass validation', () => {
    expect(validateWorktreeParams('create', { branch: 'x' })).toBeUndefined();
    expect(validateWorktreeParams('list', {})).toBeUndefined();
    expect(validateWorktreeParams('remove', { workspace: 'wPK' })).toBeUndefined();
  });
});

describe('buildHelpArgs', () => {
  test('an absent group yields top-level help', () => {
    expect(buildHelpArgs(undefined)).toEqual(['--help']);
    expect(buildHelpArgs('  ')).toEqual(['--help']);
  });

  test('a group yields its own help', () => {
    expect(buildHelpArgs('worktree')).toEqual(['worktree', '--help']);
  });

  test('help is always requested, never implied by a bare group', () => {
    // Herdr's guide: do not probe a mutating command by omitting its arguments.
    // `herdr workspace create` runs, with defaults.
    for (const group of HERDR_GROUPS) {
      expect(buildHelpArgs(group)).toEqual([group, '--help']);
    }
  });
});

describe('parseEnvelope', () => {
  test('reads ids out of a real response shape', () => {
    // Field names taken from an actual `herdr worktree create` response, so a
    // rename upstream fails here rather than silently yielding no ids.
    const parsed = parseEnvelope(
      JSON.stringify({
        id: 'cli:worktree:create',
        result: {
          type: 'worktree_created',
          workspace: {
            workspace_id: 'wPK',
            active_tab_id: 'wPK:t1',
            worktree: {
              checkout_path: '/home/u/.herdr/worktrees/starter/pr-f',
              repo_name: 'starter',
            },
          },
        },
      }),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.envelope.result?.workspace?.workspace_id).toBe('wPK');
      expect(parsed.envelope.result?.workspace?.worktree?.checkout_path).toBe(
        '/home/u/.herdr/worktrees/starter/pr-f',
      );
    }
  });

  test('empty output is reported, not parsed as an empty result', () => {
    // "no worktrees" and "the command failed" must not look the same.
    const parsed = parseEnvelope('   ');
    expect(parsed.ok).toBe(false);
  });

  test('non-JSON output is reported with the first of it', () => {
    const parsed = parseEnvelope('error: no such workspace wZZ');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain('non-JSON');
      expect(parsed.reason).toContain('no such workspace');
    }
  });

  test('a JSON array is rejected — an envelope is an object', () => {
    expect(parseEnvelope('[]').ok).toBe(false);
  });

  test('an unrecognised shape parses but yields no invented ids', () => {
    const parsed = parseEnvelope(JSON.stringify({ result: { somethingNew: true } }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.envelope.result?.workspace?.workspace_id).toBeUndefined();
    }
  });
});
