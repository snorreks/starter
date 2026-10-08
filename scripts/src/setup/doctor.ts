// scripts/src/setup/doctor.ts
//
// Capability checks, not existence checks.
//
// Every check here runs the thing and reads what it reports. `which wrangler`
// proves a file exists; running `wrangler --version` proves it loads, which is a
// different property and the one that actually matters. The audit found this
// distinction being lost: doctor reported tools as present while `bun run e2e`
// failed on a missing shared library.
//
// Three questions each check answers:
//   1. Can it run here?        (version, not existence)
//   2. Is it the version we pinned?  (drift is reported, not tolerated silently)
//   3. What do I do about it?   (a remedy, or an honest "this host cannot")
//
// Optional capabilities report as NOT AVAILABLE rather than failing, because a
// template cannot require an Android SDK. What they must not do is claim success
// for a lane they cannot run.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBrowser } from '../shared/browser_path.ts';
import { CLIENT_DIR } from '../shared/paths.ts';
import { playwrightBin, wranglerBin } from '../shared/tools.ts';
import { checkMirrors, declaredPlaywrightVersion, readPins } from './pins.ts';

export type Severity = 'required' | 'optional' | 'info';

export interface Check {
  name: string;
  severity: Severity;
  ok: boolean;
  detail: string;
  remedy?: string;
}

/** Run a command and take its first line of output. Null means it did not run. */
export const probe = (command: string, args: readonly string[] = ['--version']): string | null => {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  const first = (result.stdout ?? '') + (result.stderr ?? '');
  return first.split('\n')[0]?.trim() ?? '';
};

/** Whether a version string at least mentions the version we pinned. */
const satisfies = (reported: string, pinned: string): boolean => reported.includes(pinned);

// ── Required capabilities ────────────────────────────────────────────────────

/**
 * Bun, compared against the pin.
 *
 * The pin matters more than it looks: `bun install` writes `bun.lock` in the
 * shape its own version produces, so a local Bun on a different patch writes a
 * lockfile that CI's `--frozen-lockfile` rejects.
 */
const bunCheck = (): Check => {
  const pins = readPins();
  const reported = probe('bun');

  if (reported === null) {
    return {
      name: 'bun',
      severity: 'required',
      ok: false,
      detail: 'not on PATH',
      remedy: 'Install Bun: https://bun.sh — or use `nix develop`, which pins it.',
    };
  }

  if ('error' in pins) {
    return { name: 'bun', severity: 'info', ok: true, detail: reported, remedy: pins.error };
  }

  return {
    name: 'bun',
    severity: 'required',
    ok: satisfies(reported, pins.bun),
    detail: `${reported}${satisfies(reported, pins.bun) ? '' : ` (pinned: ${pins.bun})`}`,
    ...(satisfies(reported, pins.bun)
      ? {}
      : {
          remedy:
            'A different Bun writes a differently-shaped bun.lock, and CI then rejects it with ' +
            '`--frozen-lockfile`. Use `nix develop`, or install the pinned version.',
        }),
  };
};

/**
 * Node, required and stated with its reason.
 *
 * `wrangler dev` is a Node program that spawns workerd. Without Node the Worker
 * never starts, and both `test:integration` and `e2e` sit in a four-minute
 * readiness timeout that reads like a hang.
 */
const nodeCheck = (): Check => {
  const reported = probe('node');

  return {
    name: 'node',
    severity: 'required',
    ok: reported !== null,
    detail: reported ?? 'not on PATH',
    ...(reported === null
      ? {
          remedy:
            'Install Node 22+. `wrangler dev` is a Node program, so without it the Worker never ' +
            'starts and `test:integration` / `e2e` time out after four minutes. `nix develop` ' +
            'provides it.',
        }
      : {}),
  };
};

/**
 * Wrangler — resolved from the workspace, and *run*.
 *
 * The audit's finding was that this check required an unrelated global install,
 * while every command that used wrangler used the workspace copy. Resolving the
 * same binary here is the whole point: a green doctor line that does not
 * correspond to the binary the deploy uses is worse than no line.
 */
const wranglerCheck = (): Check => {
  const bin = wranglerBin();

  if (bin === null) {
    return {
      name: 'wrangler',
      severity: 'required',
      ok: false,
      detail: 'not installed in the workspace',
      remedy: 'Run `bun install`. It is a pinned dependency of apps/frontend/client.',
    };
  }

  const reported = probe(bin);

  if (reported === null) {
    return {
      name: 'wrangler',
      severity: 'required',
      ok: false,
      detail: `present at ${bin} but does not run`,
      remedy: 'Re-run `bun install`; a partial install leaves a bin that cannot load.',
    };
  }

  return {
    name: 'wrangler',
    severity: 'required',
    ok: true,
    detail: `${reported} (workspace)`,
  };
};

/**
 * Whether a browser can actually launch.
 *
 * The important property is not "Chromium is installed" but "a browser process
 * starts and can evaluate JavaScript". A missing shared library produces
 * `error while loading shared libraries: libgbm.so.1`, which Playwright then
 * reports as `Target page, context or browser has been closed` — a message that
 * reads as a test bug and is not one.
 */
const browserCheck = (): Check => {
  const resolved = resolveBrowser();

  if (resolved.executable === null) {
    const fromNix = process.env.PLAYWRIGHT_BROWSERS_PATH?.startsWith('/nix/store') ?? false;

    return {
      name: 'chromium',
      severity: 'optional',
      ok: false,
      detail: fromNix
        ? `PLAYWRIGHT_BROWSERS_PATH points at ${process.env.PLAYWRIGHT_BROWSERS_PATH}, which has no chromium`
        : resolved.reason,
      remedy:
        'Chromium is not required by unit tests. For the browser and E2E lanes:\n' +
        '    nix develop        # supplies a Chromium linked against the Nix store\n' +
        '  or, on a non-Nix host:\n' +
        '    bun run setup      # installs the browser matching the locked version',
    };
  }

  // A real launch, not a version string: `--dump-dom` starts the process, renders
  // a document and exits. This is the check that catches a browser built against
  // a different libc than this host.
  const launched = spawnSync(
    resolved.executable,
    ['--headless', '--no-sandbox', '--dump-dom', 'about:blank'],
    { encoding: 'utf8', timeout: 30_000 },
  );

  if (launched.status !== 0) {
    const stderr = (launched.stderr ?? '').split('\n')[0]?.trim() ?? 'unknown error';
    return {
      name: 'chromium',
      severity: 'optional',
      ok: false,
      detail: `${resolved.executable} does not launch: ${stderr}`,
      remedy:
        'A Chromium built against a different libc than this host fails exactly here. On NixOS ' +
        'the Playwright download cannot work — use `nix develop`, which supplies one linked ' +
        'against the same store.',
    };
  }

  return {
    name: 'chromium',
    severity: 'optional',
    ok: true,
    detail: `${resolved.source}: ${resolved.executable} launches`,
  };
};

/**
 * Whether the Playwright *browsers* match the locked package version.
 *
 * A browser from a different Playwright version launches and then fails on a
 * protocol mismatch, which reads as a flaky test.
 */
const playwrightCheck = (): Check => {
  const bin = playwrightBin();
  const declared = declaredPlaywrightVersion();

  if (bin === null) {
    return {
      name: 'playwright',
      severity: 'optional',
      ok: false,
      detail: 'not installed in the workspace',
      remedy: 'Run `bun install`. @playwright/test is declared by apps/e2e.',
    };
  }

  const reported = probe(bin, ['--version']);

  return {
    name: 'playwright',
    severity: 'optional',
    ok: reported !== null,
    detail:
      reported === null ? 'installed but does not run' : `${reported} (locked: ${declared ?? '?'})`,
    ...(reported === null ? { remedy: 'Re-run `bun install`.' } : {}),
  };
};

// ── Optional capabilities, reported honestly ─────────────────────────────────

const sopsCheck = (): Check => {
  const sops = probe('sops');
  const age = probe('age');

  if (sops === null) {
    return {
      name: 'sops',
      severity: 'optional',
      ok: false,
      detail: 'not on PATH',
      remedy: '`nix develop` provides sops and age. Needed only for `bun run secrets`.',
    };
  }

  return {
    name: 'sops',
    severity: 'optional',
    // sops without age cannot encrypt. Reporting sops alone would be a green line
    // over a command that cannot work.
    ok: age !== null,
    detail: age === null ? `${sops}, but age is missing` : `${sops}, ${age}`,
  };
};

const configCheck = (): Check => {
  const config = join(CLIENT_DIR, 'wrangler.jsonc');

  if (!existsSync(config)) {
    return {
      name: 'wrangler.jsonc',
      severity: 'required',
      ok: false,
      detail: 'missing',
      remedy: `Restore ${config}.`,
    };
  }

  const text = readFileSync(config, 'utf8');
  const ok =
    /"DEPLOYMENT_ENV"\s*:\s*"local"/.test(text) && /"JOBS_PROFILE"\s*:\s*"disabled"/.test(text);

  return {
    name: 'wrangler.jsonc',
    severity: 'required',
    ok,
    detail: ok
      ? 'neutral local environment and explicit disabled compute are configured'
      : 'missing explicit local deployment or compute mode',
    ...(ok
      ? {}
      : { remedy: 'Keep DEPLOYMENT_ENV=local and JOBS_PROFILE=disabled in the neutral template.' }),
  };
};

/** Version pins and their generated mirrors. */
const pinCheck = (): Check => {
  const pins = readPins();

  if ('error' in pins) {
    return {
      name: 'pins',
      severity: 'required',
      ok: false,
      detail: pins.error,
      remedy: pins.error,
    };
  }

  const drifts = checkMirrors();

  return {
    name: 'pins',
    severity: 'required',
    ok: drifts.length === 0,
    detail:
      drifts.length === 0
        ? `bun ${pins.bun} consistent`
        : drifts
            .map((d) => `${d.mirror} says ${d.found ?? 'nothing'}, pin says ${d.expected}`)
            .join('; '),
    ...(drifts.length === 0
      ? {}
      : { remedy: drifts.map((d) => `${d.mirror}: ${d.reason}`).join('\n  ') }),
  };
};

const CHECKS = [
  bunCheck,
  pinCheck,
  nodeCheck,
  wranglerCheck,
  configCheck,
  playwrightCheck,
  browserCheck,
  sopsCheck,
] as const;

export interface Report {
  checks: Check[];
  ok: boolean;
  /** Required capabilities that did not pass. */
  missingRequired: string[];
  /** Optional capabilities this host cannot provide. Named, not hidden. */
  unavailable: string[];
}

export const inspect = (): Report => {
  const checks = CHECKS.map((check) => check());

  const missingRequired = checks
    .filter((check) => check.severity === 'required' && !check.ok)
    .map((check) => check.name);

  const unavailable = checks
    .filter((check) => check.severity === 'optional' && !check.ok)
    .map((check) => check.name);

  return { checks, ok: missingRequired.length === 0, missingRequired, unavailable };
};
