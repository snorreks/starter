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

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
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

/** Where Playwright keeps its downloads when the environment says nothing. */
const defaultBrowsersRoot = (): string => {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'ms-playwright');
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright');
};

/**
 * Chromium executables inside one Playwright cache, as `executable -> directory`.
 *
 * The layout is Playwright's, and it is not one directory:
 *   * `chromium-<build>/chrome-linux/chrome` — the Linux extraction
 *   * `chromium-<build>/chrome-mac/Chromium.app/Contents/MacOS/Chromium` — macOS
 *   * `chromium_headless_shell-<build>/chrome-linux/headless_shell` — the headless
 *     shell newer Playwright versions install and prefer
 *
 * Every entry carries a `toolchains`/`swiftshader` check where it applies, so a
 * half-extracted cache is not mistaken for a usable one.
 */
const chromiumExecutables = (root: string): Map<string, string> => {
  const found = new Map<string, string>();
  if (!existsSync(root)) {
    return found;
  }

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return found;
  }

  // Newest build last in sort order, and the loop below lets a later hit win, so a
  // stale `chromium-1000` beside a `chromium-1200` resolves to the newer one.
  for (const entry of entries.filter((name) => name.startsWith('chromium')).sort()) {
    const dir = join(root, entry);
    const candidates = [
      join(dir, 'chrome-linux', 'chrome'),
      join(dir, 'chrome-linux', 'headless_shell'),
      join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(dir, 'chrome-win', 'chrome.exe'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        found.set(candidate, dir);
      }
    }
  }

  return found;
};

/** Resolve the browser executable.
 *
 * Order is deliberate: an explicitly provided `CHROMIUM_PATH` wins, because an
 * operator who set it has a reason. Then the cache named by
 * `PLAYWRIGHT_BROWSERS_PATH`, because the flake points that at the Nix store where
 * Playwright's own download cannot work. Then Playwright's default cache — the
 * previous version returned `source: 'none'` without ever looking there, so a host
 * with a perfectly good download in `~/.cache/ms-playwright` was told it had no
 * browser, and the browser lane failed on the advice rather than on the truth.
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

  const source = (root: string): BrowserSource =>
    root.startsWith('/nix/store') ? 'nix-store' : 'playwright-download';

  // Each cache searched on its own, and a miss is not an answer: the two roots are
  // independent, and `PLAYWRIGHT_BROWSERS_PATH` pointing at an empty or
  // Nix-populated directory says nothing about whether the default cache has one.
  const named = env.PLAYWRIGHT_BROWSERS_PATH;
  const roots: string[] = [];

  if (named !== undefined && named !== '') {
    roots.push(named);
  }
  roots.push(defaultBrowsersRoot());

  const searched: string[] = [];

  for (const root of roots) {
    if (searched.includes(root)) {
      continue;
    }
    searched.push(root);

    const executables = chromiumExecutables(root);
    const candidates = [...executables.keys()].sort();

    if (candidates.length > 0) {
      // A headless shell launches faster and is what the browser lane wants; the
      // full browser is the fallback for a check that needs the whole product.
      const shell = candidates.find((path) => path.endsWith('headless_shell'));
      const executable = shell ?? (candidates.at(-1) as string);
      return {
        source: source(root),
        executable,
        reason: `${root} contains ${executables.get(executable)}`,
      };
    }
  }

  const alsoSearched = ` Also searched ${searched.join(', ')}.`;

  if (named === undefined || named === '') {
    return {
      source: 'none',
      executable: null,
      reason:
        `No chromium in the Playwright cache (${searched.join(', ')}). Run \`bun run setup\`, ` +
        'or use `nix develop` for one linked against the Nix store.',
    };
  }

  // Two different reasons, because the remedy differs: inside the Nix store the
  // Playwright download cannot work at all, so "run setup" would be advice that
  // cannot succeed.
  return {
    source: 'none',
    executable: null,
    reason: named.startsWith('/nix/store')
      ? `PLAYWRIGHT_BROWSERS_PATH points into the Nix store but has no chromium: ${named}.${alsoSearched}`
      : `PLAYWRIGHT_BROWSERS_PATH is set but holds no chromium: ${named}.${alsoSearched}`,
  };
};

/**
 * Playwright's own launch options for the resolved browser.
 *
 * `executablePath` is left absent when nothing was resolved, so Playwright uses
 * its own default and produces its own error. Passing a nonexistent path instead
 * yields a less obvious failure.
 *
 * This is the shape `playwright.config.ts` passes as `use.launchOptions`. It is
 * **not** the shape the Vitest browser provider wants — see
 * `vitestProviderOptions` for that. Handing this object to `playwright()` was
 * itself a bug worth naming: it type-checks, because `PlaywrightProviderOptions`
 * has other optional members, and it silently discards the executable.
 */
export const playwrightLaunchOptions = (
  env: NodeJS.ProcessEnv = process.env,
): { executablePath?: string } => {
  const { executable } = resolveBrowser(env);
  return executable === null ? {} : { executablePath: executable };
};

/**
 * `@vitest/browser-playwright` provider options for the resolved browser.
 *
 * The provider nests Playwright's launch options under `launchOptions`; that is
 * the only member its `resolveLaunchOptions` reads. Vitest 5's
 * `BrowserInstanceOption` has no `launch` member, so an executable placed on an
 * instance is dropped without a warning and the lane falls back to Playwright's
 * own resolution — which is how this lane used to fail on NixOS.
 *
 * Two functions rather than one, because the two callers need different shapes
 * and a single "launchOptions" name invited exactly that mistake.
 */
export const vitestProviderOptions = (
  env: NodeJS.ProcessEnv = process.env,
): { launchOptions: { executablePath?: string } } => ({
  launchOptions: playwrightLaunchOptions(env),
});
