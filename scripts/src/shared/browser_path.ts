// scripts/src/shared/browser_path.ts
//
// One answer to "which Chromium do the browser lanes use?".
//
// Playwright's own answer is "the copy I downloaded". That is right on a Linux
// or macOS host with a normal libc, and wrong on NixOS, where the downloaded
// binary links against `libgbm.so.1` and friends that the store only provides
// under versioned names. The failure is:
//
//   error while loading shared libraries: libgbm.so.1
//
// which Playwright then reports as `Target page, context or browser has been
// closed` — a message that reads as a flaky test and is not one.
//
// So the decision lives here and is published as a single environment variable.
// `flake.nix` sets it, the app configs read it, and `doctor` proves the binary
// it names actually launches. One place decides; everything else obeys.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The variable every consumer reads. Set by the flake; optional elsewhere. */
export const BROWSER_PATH_ENV = 'CHROMIUM_PATH';

export type BrowserSource = 'nix-store' | 'playwright-download' | 'none';

export interface ResolvedBrowser {
  source: BrowserSource;
  /** Absolute path to an executable, or null when none was found. */
  executable: string | null;
  /** Why this answer, for `doctor` to print. */
  reason: string;
}

/**
 * Resolve the browser executable.
 *
 * Order is deliberate: an explicitly provided `CHROMIUM_PATH` wins, because an
 * operator who set it has a reason. Then a Nix store browser directory, because
 * Playwright's download cannot work there. Then whatever Playwright installed.
 */
export const resolveBrowser = (env: NodeJS.ProcessEnv = process.env): ResolvedBrowser => {
  const explicit = env[BROWSER_PATH_ENV];
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) {
    return {
      source: explicit.startsWith('/nix/store') ? 'nix-store' : 'playwright-download',
      executable: explicit,
      reason: `${BROWSER_PATH_ENV} is set to an existing file`,
    };
  }

  const browsersPath = env.PLAYWRIGHT_BROWSERS_PATH;

  if (browsersPath !== undefined && browsersPath !== '') {
    const candidate = join(browsersPath, 'chromium');
    if (existsSync(candidate)) {
      return {
        source: browsersPath.startsWith('/nix/store') ? 'nix-store' : 'playwright-download',
        executable: candidate,
        reason: `PLAYWRIGHT_BROWSERS_PATH contains a chromium binary`,
      };
    }

    return {
      source: 'none',
      executable: null,
      reason: browsersPath.startsWith('/nix/store')
        ? `PLAYWRIGHT_BROWSERS_PATH points into the Nix store but has no chromium: ${browsersPath}`
        : `PLAYWRIGHT_BROWSERS_PATH is set but empty of chromium: ${browsersPath}`,
    };
  }

  return {
    source: 'none',
    executable: null,
    reason:
      'No browser configured. Run `bun run setup` for a Playwright download, or use `nix develop` ' +
      'for one linked against the Nix store.',
  };
};

/**
 * The Playwright/Vitest `launchOptions` for the resolved browser.
 *
 * `executablePath` is left absent when nothing was resolved, so Playwright uses
 * its own default and produces its own error. Passing a nonexistent path instead
 * yields a less obvious failure.
 */
export const launchOptions = (
  env: NodeJS.ProcessEnv = process.env,
): { executablePath?: string } => {
  const { executable } = resolveBrowser(env);
  return executable === null ? {} : { executablePath: executable };
};
