// .pi/tests/fake_bin.ts
//
// A fake executable boundary, shared by the tests that need one.
//
// Why this exists: the helpers under `.pi/lib` shell out — to `bun`, to `herdr`,
// to a dev server. Mocking the spawn function would assert that the code calls
// the function the test expects it to call, which is a claim about the test, not
// about the behaviour. Writing an actual executable into a temporary directory
// and running it proves the argv, the exit status, the stream separation and the
// timeout behaviour for real.
//
// Every script here is a `/bin/sh` script: no toolchain, no network, no
// dependency on anything the repository declares. A test that needed `herdr` to
// be installed would fail on a machine where it is not, which is exactly the
// machine whose behaviour the "optional capability" tests exist to cover.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoundedRunResult } from '../lib/process.ts';

export interface FakeBin {
  /** Absolute path to the fake executable. */
  path: string;
  /** Directory the fake lives in — put this first on PATH when it matters. */
  dir: string;
  /** Raw text the fake printed, for asserting on stream separation. */
  cleanup(): void;
}

const roots: string[] = [];

/**
 * Write an executable shell script into a fresh temporary directory.
 *
 * `body` is the script body. It runs under `/bin/sh`, so `dash` is the shell —
 * which is the harder case: it forks rather than `exec`s, so a kill has to
 * reach the whole process group. Testing against `bash` would make the
 * cancellation tests pass for the wrong reason.
 */
export const fakeBin = (name: string, body: string): FakeBin => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fakebin-'));
  roots.push(dir);

  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);

  return {
    path,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

/** A fake that succeeds and prints nothing. */
export const silentBin = (name = 'quiet'): FakeBin => fakeBin(name, 'exit 0');

/** A fake that fails with a specific code and a message on stderr. */
export const failingBin = (code: number, message: string, name = 'failing'): FakeBin =>
  fakeBin(name, `echo "${message}" >&2\nexit ${code}`);

/**
 * A fake that writes `bytes` to stdout and then blocks until killed.
 *
 * Used for the truncation and cancellation tests: it produces more output than
 * any byte budget while never exiting on its own, which is the combination that
 * turns "bounded" from a claim into a measurement.
 */
export const floodingBin = (bytes: number, name = 'flood'): FakeBin =>
  fakeBin(
    name,
    `i=0
while [ $i -lt ${bytes} ]; do
  printf '%0.sx' $(seq 1 64)
  i=$((i + 1))
done
sleep 30`,
  );

/** Remove every directory this module created. Called from an `afterAll`. */
export const cleanupFakes = (): void => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * A `TaskRunner` bound to one executable.
 *
 * Uses the production `runBounded` deliberately: the bounds under test are the
 * ones `runBounded` implements, so a test double for it would test the double.
 */
/**
 * A `TaskRunner` bound to one executable.
 *
 * Uses the production `runBounded` deliberately: the bounds under test are the
 * ones `runBounded` implements, so a test double for it would test the double.
 * The `command` argument is ignored — the fake is the executable under test, so
 * this is the seam that lets a fixture replace `bun` or `herdr` without
 * pretending to be either.
 */
export const runnerFor =
  (bin: string, cwd: string) =>
  (
    _command: string,
    args: readonly string[],
    options: { timeoutMs: number; maxBytes: number },
  ): Promise<BoundedRunResult> =>
    import('../lib/process.ts').then(({ runBounded }) =>
      runBounded(bin, args, { cwd, ...options }),
    );

/** Read a file the fake wrote, or `undefined` when it wrote nothing. */
export const readIfPresent = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** Create a directory the fake can write into. */
export const scratchDir = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `pi-${name}-`));
  roots.push(dir);
  return dir;
};

export const ensureDir = (path: string): string => {
  mkdirSync(path, { recursive: true });
  return path;
};
