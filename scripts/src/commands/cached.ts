// scripts/src/commands/cached.ts
//
// Run Moon with the cache mode this tree can justify.
//
// Moon decides whether to reuse a cached result *before* any task's `pre`
// command runs, so nothing inside a moon.yml can widen or narrow the key. The
// decision therefore has to sit in front of `moon`, which is what this command
// is. It is the implementation behind every root script that fans out to Moon:
//
//   bun run test   ->  bun run scripts/src/cli.ts cached -- :test
//
// The mode comes from `resolveCacheMode`, which fingerprints the files Moon
// cannot put in a key. When they are unchanged Moon runs `--cache read-write`
// and a warm hit is a real statement about this tree. When they moved, Moon runs
// `--cache off` and every task re-runs.

import { spawnSync } from 'node:child_process';
import { purgeMoonCache, resolveCacheMode, writeStamp } from '../ci/cache_scope.ts';
import type { Command } from '../shared/command.ts';
import { EXIT, fail, wantsHelp } from '../shared/command.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { resolveWorkspaceBin } from '../shared/tools.ts';

const USAGE = `cached [--] <moon targets...>

Runs Moon over the given targets with a cache mode chosen from the files Moon
cannot see. Any argument after -- is passed to Moon unchanged.

  bun run scripts/src/cli.ts cached -- :test
  bun run scripts/src/cli.ts cached -- client:test-browser
  bun run scripts/src/cli.ts cached -- --affected :typecheck`;

const run = async (args: readonly string[]): Promise<number> => {
  if (wantsHelp(args)) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }

  const separator = args.indexOf('--');
  const targets = (separator === -1 ? [...args] : args.slice(separator + 1)).filter(
    (arg) => arg !== '',
  );
  if (targets.length === 0) {
    return fail(USAGE, EXIT.usage);
  }

  const moon = resolveWorkspaceBin('moon');
  if (moon === null) {
    return fail(
      'moon is not in this workspace, so the cache gate cannot run.\n' +
        '  Install the workspace dependencies first: bun install',
      EXIT.unavailable,
    );
  }

  const scope = resolveCacheMode();

  // A changed fingerprint means Moon holds entries computed against a tree that no
  // longer exists. `--cache off` for this run does not remove them, so the *next*
  // run — which sees a matching stamp — would restore them. Measured before this
  // was added: warm at F1, edit `bun.lock`, run (`off`, re-runs), run again
  // (`read-write`, restores the F1 result). The entries go before the stamp
  // advances, so there is no window in which the gate agrees with itself while the
  // cache holds a result it has already disowned.
  //
  // Keyed on the reason rather than on `mode === 'off'`, because a cold cache is
  // also `off` and there is nothing stored to discard.
  if (scope.mode === 'off' && scope.reason.includes('changed')) {
    const { purged } = purgeMoonCache(REPO_ROOT);
    if (purged.length > 0) {
      process.stderr.write(
        `discarded Moon's ${purged.join(' and ')} cache: computed against a tree that no longer exists\n`,
      );
    }
  }

  // The stamp is written whatever the mode. Writing it only on a hit would make
  // the second consecutive cold run look like a hit, and writing it only on a
  // miss would mean the run that first warms the cache never records the tree it
  // warmed against.
  if (scope.fingerprint !== '') {
    writeStamp(REPO_ROOT, scope.fingerprint);
  }

  process.stderr.write(`moon --cache ${scope.mode}: ${scope.reason}\n`);

  // `run` before the flag, not after: `--cache` is a global option, so
  // `moon --cache off client:test-browser` parses `client:test-browser` as the
  // subcommand and exits 2 with "unrecognized subcommand". `moon run --cache off
  // …` is the shape Moon accepts.
  //
  // `stdio: 'inherit'` so the lane's own output and its exit status are the
  // command's. A wrapper that captured and reformatted output would swallow the
  // exit status, which is the one thing the caller needs.
  const result = spawnSync(moon, ['run', '--cache', scope.mode, ...targets], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error !== undefined) {
    return fail(`could not run moon: ${result.error.message}`, EXIT.unavailable);
  }

  // A signalled process reports `status: null`; `0` would certify a lane that was
  // killed.
  return result.status ?? EXIT.failed;
};

export const cachedCommand: Command = {
  name: 'cached',
  summary: 'Run Moon targets with a cache mode justified by the files it cannot see',
  usage: USAGE,
  run,
};
