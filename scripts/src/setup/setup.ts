// scripts/src/setup/setup.ts
//
//   bun run setup          # idempotent; safe on every directory entry
//   bun run setup:doctor   # report capabilities, and what this host cannot do
//
// What setup does, and what it deliberately refuses to do:
//
//   * verifies the pinned toolchain and says what is missing
//   * creates local gitignored defaults, never overwriting an existing file
//   * installs the Playwright browsers that match the *locked* version
//   * records a readiness fingerprint so the next run is a hash comparison
//
// It never contacts a service, never reads a credential, and never overwrites
// anything a developer may have edited. "Idempotent" is load-bearing: `.envrc`
// calls this on directory entry, so it runs on every `cd`.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBrowser } from '../shared/browser_path.ts';
import { CLIENT_DIR, REPO_ROOT } from '../shared/paths.ts';
import { playwrightBin } from '../shared/tools.ts';
import { inspect, type Report } from './doctor.ts';
import { declaredPlaywrightVersion, readPins } from './pins.ts';

export { inspect, type Report } from './doctor.ts';
export { checkMirrors, readPins } from './pins.ts';

const STATE_DIR = join(REPO_ROOT, '.wrangler', 'setup');

const LOCAL_ENV = `# Local environment. Gitignored. Never contains a real secret.
# Every value here is a development default, so a fresh clone runs with no setup.
PUBLIC_MODE=local
PUBLIC_LOG_LEVEL=DEBUG
PUBLIC_APP_VERSION=dev
PUBLIC_API_BASE_URL=
PUBLIC_TELEMETRY_ENDPOINT=/api/telemetry
`;

/** Create a file only if it is absent. Never overwrites. */
const writeIfAbsent = (path: string, contents: string, mode?: number): boolean => {
  if (existsSync(path)) {
    return false;
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
  return true;
};

// ── Readiness fingerprint ────────────────────────────────────────────────────

/**
 * A hash of everything whose change should invalidate setup.
 *
 * The files, not their contents' mtimes: a `git checkout` rewrites mtimes without
 * changing what is installed, and a fingerprint that moved on every branch switch
 * would re-run `bun install` for nothing.
 *
 * What is deliberately *not* in it: the toolchain's installed state. That is
 * checked separately, by looking for the files themselves — see
 * `cachesStillExist`. A hash cannot tell you a browser was deleted.
 */
const fingerprint = (root = REPO_ROOT): string => {
  // The API application used to be listed here. It is gone, and `fingerprint` hashes
  // a missing path as the constant 'absent' — a contribution to the hash that could
  // never change, which is worse than useless because it looks like coverage.
  const inputs = [
    'bun.lock',
    'package.json',
    'config/toolchain.json',
    'apps/e2e/package.json',
    join('apps', 'frontend', 'client', 'package.json'),
  ];

  const hash = createHash('sha256');
  hash.update(process.platform);

  for (const relative of inputs) {
    const path = join(root, relative);
    hash.update(relative);
    hash.update(existsSync(path) ? readFileSync(path) : 'absent');
  }

  return hash.digest('hex').slice(0, 16);
};

/**
 * Verify a cached fingerprint still describes reality.
 *
 * Two independent ways the cache goes stale without the hash changing:
 *
 *   * the browser directory was removed (`rm -rf ~/.cache/ms-playwright`)
 *   * `node_modules` was reinstalled without the workspace lock changing
 *
 * So readiness is the hash *and* the tools being present. Checking only the hash
 * is what makes a "cached" setup command lie after someone clears a cache.
 */
const cachesStillExist = (): boolean => {
  const playwright = playwrightBin();
  if (playwright === null) {
    // No workspace Playwright at all: `bun install` has not run, so the cached
    // fingerprint is describing a checkout that does not exist.
    return false;
  }

  const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browserRoot === undefined || browserRoot === '') {
    // Nothing to verify beyond the binary. Accept: the browser may legitimately
    // not be installed on a headless machine that only runs unit tests.
    return true;
  }

  return existsSync(browserRoot);
};

export interface SetupOutcome {
  /** True when nothing had to be done. */
  cached: boolean;
  /** Files created this run. */
  created: string[];
  /** Steps that ran. Empty when cached. */
  performed: string[];
  report: Report;
}

/**
 * Perform setup, or prove it is already done.
 *
 * Split from `runSetup` so a test can assert on the decision rather than on
 * stdout — "was it cached" is the property that matters, and it is invisible in
 * printed output unless a step says so.
 */
export const performSetup = (options: { force?: boolean; quiet?: boolean } = {}): SetupOutcome => {
  const stampPath = join(STATE_DIR, 'ready');
  const current = fingerprint();

  const created: string[] = [];
  const performed: string[] = [];
  const log = (line: string): void => {
    if (!options.quiet) {
      process.stdout.write(`${line}\n`);
    }
  };

  // 1. Dependencies, before anything inspects them.
  //
  //    `inspect` checks the *installed* tools, so on a fresh clone `wranglerCheck`
  //    reports "not installed in the workspace" and the required check fails. With
  //    install after that gate, `bun run setup` aborted before installing anything —
  //    reporting the symptom and stopping, on precisely the checkout that needed
  //    it. Nothing was written, and re-running changed nothing.
  //
  //    Gated on the absence of `node_modules/.bin` and deliberately *not* on
  //    `--force`: `--force` bypasses the cache, it does not mean "reinstall what is
  //    already there". A second `bun install` on a warm checkout is minutes of
  //    work for no change.
  //
  //    `--frozen-lockfile` so setup cannot silently update the lockfile; a
  //    developer who changed a dependency has already run install.
  const dependenciesMissing = !existsSync(join(REPO_ROOT, 'node_modules', '.bin'));

  if (dependenciesMissing) {
    const install = spawnSync('bun', ['install', '--frozen-lockfile'], {
      cwd: REPO_ROOT,
      stdio: options.quiet ? 'ignore' : 'inherit',
    });
    performed.push('bun install');
    if (install.status !== 0) {
      return { cached: false, created, performed, report: inspect() };
    }
  }

  const report = inspect();

  const cached =
    !options.force &&
    !dependenciesMissing &&
    existsSync(stampPath) &&
    readFileSync(stampPath, 'utf8').trim() === current &&
    cachesStillExist();

  if (cached) {
    return { cached: true, created: [], performed: [], report };
  }

  // A required capability missing means setup cannot complete. Say which, and stop
  // before writing anything: a half-prepared checkout is harder to reason about
  // than an unprepared one.
  if (!report.ok) {
    return { cached: false, created: [], performed: [...performed, 'aborted'], report };
  }

  // 2. Local defaults.
  if (writeIfAbsent(join(REPO_ROOT, '.env'), LOCAL_ENV)) {
    created.push('.env (local defaults only)');
  }
  if (writeIfAbsent(join(CLIENT_DIR, '.env'), LOCAL_ENV)) {
    created.push('apps/frontend/client/.env');
  }

  // 3. Browsers matching the locked Playwright version.
  //
  //    Skipped when a browser already resolves. That used to be decided by
  //    `PLAYWRIGHT_BROWSERS_PATH.startsWith('/nix/store')` — a check on the *name*
  //    of a directory rather than on whether a browser exists. It was wrong in both
  //    directions: renaming the variable's value made `setup` download a Chromium
  //    the environment had already decided not to use, and a Nix store path with no
  //    Chromium in it made `setup` skip a download that was needed.
  //
  //    The capability is `resolveBrowser()`, which is the same decision the lanes
  //    make. If it finds an executable, installing another one is pure cost; if it
  //    does not, Playwright's download is the only way to get one.
  const resolved = resolveBrowser();
  const playwright = playwrightBin();

  if (resolved.executable !== null) {
    log(`  using ${resolved.executable} (${resolved.source})`);
    log(`    ${resolved.reason}`);
  } else if (playwright !== null && !options.quiet) {
    const pins = readPins();
    const browsers = 'error' in pins ? ['chromium'] : [...pins.playwright.browsers];

    for (const browser of browsers) {
      log(`  installing playwright ${declaredPlaywrightVersion() ?? '?'} browser: ${browser}`);
      const installed = spawnSync(playwright, ['install', browser], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        // The download is a network operation with no bound. A hang here blocks
        // shell activation, because `.envrc` runs `setup` on every directory entry.
        timeout: 600_000,
      });
      if (installed.status !== 0) {
        process.stderr.write(
          `Could not install the ${browser} browser.\n` +
            'The browser lane and E2E will not run. Everything else works.\n' +
            `  ${resolved.reason}\n`,
        );
        performed.push(`playwright install ${browser} (failed)`);
        break;
      }
      performed.push(`playwright install ${browser}`);
    }
  } else if (playwright === null) {
    process.stderr.write(
      'playwright is not in this workspace, so no browser can be installed.\n' +
        '  Run `bun install`, then `bun run setup`.\n',
    );
  }

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(stampPath, `${current}\n`);

  return { cached: false, created, performed, report };
};

export const statusMark = (check: Report['checks'][number]): string => {
  if (check.ok) {
    return '  ok  ';
  }
  return check.severity === 'required' ? ' MISS ' : '  --  ';
};

/** Render a report for a person. Shared by `setup` and `doctor`. */
export const renderReport = (report: Report): string =>
  report.checks
    .map((check) => `${statusMark(check)} ${check.name.padEnd(12)} ${check.detail}`)
    .join('\n');

export const runSetup = (args: readonly string[] = []): number => {
  const force = args.includes('--force');
  const quiet = args.includes('--quiet');
  const outcome = performSetup({ force, quiet });

  if (outcome.cached) {
    if (!quiet) {
      process.stdout.write('Toolchain\n');
      process.stdout.write(`${renderReport(outcome.report)}\n`);
      process.stdout.write('\nSetup\n  ok    already prepared (nothing to do)\n');
    }
    return outcome.report.ok ? 0 : 1;
  }

  process.stdout.write('Toolchain\n');
  process.stdout.write(`${renderReport(outcome.report)}\n`);

  if (!outcome.report.ok) {
    process.stderr.write(
      `\nMissing required capabilities: ${outcome.report.missingRequired.join(', ')}\n` +
        'Nothing was written. Fix these, then re-run `bun run setup`.\n',
    );
    for (const check of outcome.report.checks) {
      if (!check.ok && check.severity === 'required' && check.remedy) {
        process.stderr.write(`  ${check.name}: ${check.remedy}\n`);
      }
    }
    return 1;
  }

  process.stdout.write('\nSetup\n');
  for (const step of outcome.performed) {
    process.stdout.write(`  ran   ${step}\n`);
  }
  if (outcome.created.length === 0) {
    process.stdout.write('  ok    local defaults already present\n');
  } else {
    for (const path of outcome.created) {
      process.stdout.write(`  new   ${path}\n`);
    }
  }

  const unavailable = outcome.report.unavailable;
  if (unavailable.length > 0) {
    process.stdout.write(
      `\nNot available on this host: ${unavailable.join(', ')}\n` +
        '  Those lanes cannot run here. See docs/platforms.md for what each needs.\n',
    );
  }

  process.stdout.write(
    '\nNext:\n' +
      '  bun run db:generate   # create migrations from the Drizzle schema\n' +
      '  bun run db:migrate    # apply them to the local database\n' +
      '  bun run dev           # start the app: pages, assets and /api, one origin\n',
  );
  return 0;
};

/** Remove the readiness stamp, so the next setup re-checks rather than trusting it. */
export const invalidateSetupCache = (root = REPO_ROOT): void => {
  rmSync(join(root, '.wrangler', 'setup', 'ready'), { force: true });
};
