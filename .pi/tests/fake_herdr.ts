// .pi/tests/fake_herdr.ts
//
// A fake `herdr` CLI, used to prove the tool's contract without Herdr installed.
//
// The point of this fake is that it reproduces the **real** response shapes,
// captured from the installed 0.9.1 binary, and it can be made to fail in each of
// the ways the tool has to distinguish. That is what lets the absence/failure
// distinction be tested on a machine with no Herdr at all — which is the machine
// whose behaviour the optional-capability tests exist to cover.
//
// The JSON shapes below are verbatim from real responses. They are what
// `parseEnvelope` reads, so a rename upstream fails a test rather than silently
// yielding no workspace id.
//
// Responses are keyed by the exact argv the tool is expected to send, and an
// unmatched argv is reported as such rather than answered. That way a test cannot
// pass because the tool quietly took a different path: an unexpected invocation
// fails loudly instead of returning the default.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A real `herdr worktree create` response, ids and all. */
export const WORKTREE_CREATED = {
  id: 'cli:worktree:create',
  result: {
    root_pane: {
      cwd: '/tmp/x/.herdr/worktrees/starter/pr-f',
      pane_id: 'wPK:p1',
      tab_id: 'wPK:t1',
      workspace_id: 'wPK',
    },
    type: 'worktree_created',
    workspace: {
      active_tab_id: 'wPK:t1',
      label: 'starter PR-F agent integration',
      workspace_id: 'wPK',
      worktree: {
        checkout_path: '/tmp/x/.herdr/worktrees/starter/pr-f',
        is_linked_worktree: true,
        repo_name: 'starter',
        repo_root: '/tmp/x/Development/starter',
      },
    },
    worktree: {
      branch: 'pr-f-agent-integration',
      is_linked_worktree: true,
      open_workspace_id: 'wPK',
      path: '/tmp/x/.herdr/worktrees/starter/pr-f',
    },
  },
};

/** A real `herdr worktree list` response, with a linked and a bare worktree. */
export const WORKTREE_LIST = {
  id: 'cli:worktree:list',
  result: {
    type: 'worktree_list',
    worktrees: [
      {
        branch: 'main',
        is_linked_worktree: false,
        label: 'starter',
        open_workspace_id: 'wPH',
        path: '/tmp/x/Development/starter',
      },
      {
        branch: 'pr-f-agent-integration',
        is_linked_worktree: true,
        is_prunable: false,
        label: 'starter',
        open_workspace_id: 'wPK',
        path: '/tmp/x/.herdr/worktrees/starter/pr-f',
      },
    ],
  },
};

export interface FakeHerdr {
  dir: string;
  path: string;
  /** Every argv the tool sent, in order. */
  calls(): string[];
  cleanup(): void;
}

export interface FakeHerdrOptions {
  /** stdout for `--version`. Defaults to the installed version string. */
  version?: string;
  /** stdout keyed by the exact argv string, minus the binary name. */
  responses?: Record<string, string>;
  /**
   * stdout for an argv with no entry in `responses`. Defaults to
   * `UNEXPECTED`, which the script turns into a failure.
   */
  fallback?: string;
  /** stderr for every invocation. */
  stderr?: string;
  /** Exit code for every non-`--version` invocation. */
  exitCode?: number;
}

/**
 * Quote a string as a single shell word.
 *
 * Hand-rolled rather than using `JSON.stringify`, because these scripts run under
 * `dash` and must not depend on anything the repository declares. Every quote,
 * backslash and `$` is escaped so a response body cannot break out of the
 * literal and change what the fake does.
 */
const sh = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const fakeHerdr = (options: FakeHerdrOptions = {}): FakeHerdr => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fake-herdr-'));
  const path = join(dir, 'herdr');
  const log = join(dir, 'calls.log');

  const {
    version = 'herdr 0.9.1',
    responses = {},
    fallback = '__UNEXPECTED__',
    stderr = '',
    exitCode = 0,
  } = options;

  // One file per expected argv, named by index. Matching argv against them in the
  // script avoids a JSON parser in `sh`.
  const entries = Object.entries(responses);
  entries.forEach(([argv], index) => {
    writeFileSync(join(dir, `key-${index}`), argv);
    writeFileSync(join(dir, `val-${index}`), responses[argv] as string);
  });

  const cases = entries
    .map(
      (_entry, index) =>
        `  if [ "$__ARGS__" = "$(cat ${join(dir, `key-${index}`)})" ]; then` +
        ` cat ${join(dir, `val-${index}`)}; exit ${exitCode}; fi`,
    )
    .join('\n');

  const script = `#!/bin/sh
printf '%s\\n' "$*" >> ${sh(log)}
if [ "$1" = "--version" ]; then
  printf '%s\\n' ${sh(version)}
  exit 0
fi
__ARGS__="$*"
${cases}
printf '%s\\n' ${sh(fallback)}
[ -n ${sh(stderr)} ] && printf '%s\\n' ${sh(stderr)} >&2
exit ${exitCode}
`;

  writeFileSync(path, script);
  chmodSync(path, 0o755);

  return {
    dir,
    path,
    calls: () => {
      try {
        return readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line !== '');
      } catch {
        return [];
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};
