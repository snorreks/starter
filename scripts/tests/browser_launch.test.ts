// scripts/tests/browser_launch.test.ts
//
// The failure this test exists for was never a missing browser.
//
// `vitest.config.ts` selected its Chromium with an *instance* property:
//
//   instances: [{ browser: 'chromium', launch: { executablePath } }]
//
// `BrowserInstanceOption` in Vitest 5 has no `launch` member — it is
// `Omit<ProjectConfig, UnsupportedProperties>` plus `browser`, `name`,
// `provider` and six picked option names. The provider's own
// `resolveLaunchOptions` spreads exactly one thing:
//
//   const launchOptions = { ...providerOptions.launchOptions, headless: … }
//
// So the selected executable never reached `playwright.launch()`, nothing warned
// that it had been dropped, and the lane died on Playwright's own resolution:
//
//   Executable doesn't exist at …/bin/chromium_headless_shell-1243/
//     chrome-headless-shell-linux64/chrome-headless-shell
//
// which reads as "this Nix shell has no headless shell" and invites installing
// another Chromium. It was never about the headless shell.
//
// Nothing short of running a browser settles it. These tests put an
// **instrumented executable** where the resolver's answer goes, launch a real
// Vitest browser project through the real provider, and assert that the process
// that ran is the one the resolver selected — by the marker's own contents,
// which name the executable that produced them.
//
// They drive the provider rather than `apps/frontend/client/vitest.config.ts`,
// because the property under test is the provider API plus
// `browser_path.ts`. The lane that consumes both is `bun run test:browser`;
// docs/capability-matrix.md records its result.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
// `fileURLToPath`, not `URL.pathname`. The latter percent-encodes, so a checkout
// under a directory containing a space — `/home/o/My Projects/starter` — resolves to
// a path that does not exist, and the failure reads as a missing Chromium rather
// than as a missing directory. This repository has been bitten by exactly that and
// says so in `apps/e2e/playwright.config.ts`.
import { fileURLToPath } from 'node:url';
import {
  playwrightLaunchOptions,
  resolveBrowser,
  vitestProviderOptions,
} from '../src/shared/browser_path.ts';

const CLIENT_DIR = fileURLToPath(new URL('../../apps/frontend/client/', import.meta.url));
const E2E_CONFIG = fileURLToPath(new URL('../../apps/e2e/playwright.config.ts', import.meta.url));
const BROWSER_PATH_MODULE = fileURLToPath(
  new URL('../src/shared/browser_path.ts', import.meta.url),
);

/**
 * A throwaway Vitest browser project.
 *
 * Real `vitest`, real `@vitest/browser-playwright`, one assertion that the
 * browser is real. It imports the repository's own resolver by absolute path, so
 * the shape under test is the one the lanes use rather than a copy of it.
 *
 * It lives under `apps/frontend/client/.cache/` rather than the system temp
 * directory on purpose: Vitest resolves `@vitest/browser-playwright` from the
 * config file's own location, so a config under `/tmp` resolves nothing and
 * fails with `MODULE_NOT_FOUND` before a browser is launched — a failure
 * unrelated to the thing under test. `.cache/` is gitignored and inside the
 * project, so resolution matches a real lane.
 */
const writeHarness = (dir: string): string => {
  const configPath = join(dir, 'vitest.config.ts');
  writeFileSync(
    configPath,
    `import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { vitestProviderOptions } from '${BROWSER_PATH_MODULE}';

export default defineConfig({
  // \`root\` must be the harness directory: Vitest resolves \`include\` from the
  // project root, not from the config file, so without this the run reports
  // "No test files found" and exits 1 before a browser is ever launched.
  root: import.meta.dirname,
  test: {
    include: ['probe.browser.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(vitestProviderOptions()),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
`,
  );
  writeFileSync(
    join(dir, 'probe.browser.test.ts'),
    `import { expect, test } from 'vitest';
test('the browser is real', () => {
  expect(typeof document).toBe('object');
  expect(navigator.userAgent).toContain('Chrome');
});
`,
  );
  return configPath;
};

/**
 * An executable that records that it ran, then either becomes the real browser
 * or refuses.
 *
 * This is the instrument. Playwright spawns it as the browser process, so the
 * marker file proves the selected path reached the launch — which is precisely
 * the step the instance-level `launch` option skipped. Naming the executable in
 * the marker also distinguishes *which* one ran when two are in play.
 */
const writeInstrumentedBrowser = (
  dir: string,
  name: string,
  marker: string,
  target: string | null,
): string => {
  const path = join(dir, name);
  writeFileSync(
    path,
    target === null
      ? `#!/bin/sh\nprintf '%s\\n' "${path}" >> "${marker}"\nexit 3\n`
      : `#!/bin/sh\nprintf '%s\\n' "${path}" >> "${marker}"\nexec "${target}" "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
};

/** Run the harness and report the output, the exit status, and what ran.
 *
 * `launched` is a set rather than a single path: Vitest spawns the browser
 * again while tearing down, so the honest record is "these executables ran",
 * not "this one ran once".
 */
const runHarness = (configPath: string, env: NodeJS.ProcessEnv, marker: string) => {
  const result = spawnSync('bun', ['x', 'vitest', 'run', '--config', configPath], {
    cwd: CLIENT_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 240_000,
  });
  const launched = existsSync(marker)
    ? [
        ...new Set(
          readFileSync(marker, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ]
    : [];
  return {
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    status: result.status,
    launched,
  };
};

describe('the browser lane launches the executable the resolver selected', () => {
  let dir: string;
  let configPath: string;
  let marker: string;

  beforeEach(() => {
    // `mkdtempSync` will not create the parent, and `.cache/` is gitignored and
    // therefore absent from a fresh checkout.
    mkdirSync(join(CLIENT_DIR, '.cache'), { recursive: true });
    dir = mkdtempSync(join(CLIENT_DIR, '.cache', 'browser-launch-'));
    configPath = writeHarness(dir);
    marker = join(dir, 'launched.txt');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Each of the three tests below spawns a real Vitest browser run, which is far
  // slower than bun's 5 s default and can be slower still on a host where Playwright
  // has a downloaded Chromium and the negative test launches it before failing.
  const HARNESS_TIMEOUT_MS = 240_000;

  /**
   * Whether this host has a browser the resolver can name.
   *
   * Read once, here, so `skipIf` can decide before the test body runs. Returning
   * early from inside the body reported the test **green** having launched nothing,
   * which is the exact shape of failure this file exists to detect — the same class
   * as a lane whose runner matches nothing. A skip is reported as a skip, and the
   * count is visibly short of the total.
   *
   * `doctor` and `browser_path.test.ts` still cover the resolver's behaviour on a
   * host with no browser, so nothing is lost by not running these.
   */
  const browser = resolveBrowser();
  const skipWithoutBrowser = browser.executable === null;
  const withoutBrowserMessage = `no browser resolves on this host. ${browser.reason}`;

  test.skipIf(skipWithoutBrowser)(
    'the selected executable is the process Playwright started',
    () => {
      const real = browser;

      if (real.executable === null) {
        // `skipIf` already handled it; reaching here would mean the two disagree,
        // which is worth an explicit message rather than a `TypeError` further down.
        throw new Error(withoutBrowserMessage);
      }

      const selected = writeInstrumentedBrowser(dir, 'selected-browser', marker, real.executable);
      const result = runHarness(configPath, { CHROMIUM_PATH: selected }, marker);

      // Positive: a real browser served the test, so the lane can pass.
      expect(result.status).toBe(0);
      expect(result.output).toContain('1 passed');
      // The property itself: the marker exists, and it names the selected path.
      expect(result.launched).toEqual([selected]);
      // Not the headless-shell path the previous configuration produced.
      expect(result.output).not.toContain('chromium_headless_shell-');
    },
    HARNESS_TIMEOUT_MS,
  );

  test(
    'a selected executable that refuses fails the launch instead of being ignored',
    () => {
      // The negative control for the positive test above. If the selected path
      // were dropped, Playwright would resolve a browser of its own and this run
      // would pass — so a *failing* run here is the evidence that the choice is
      // load-bearing. No real browser is needed: the instrument refuses.
      const refusing = writeInstrumentedBrowser(dir, 'refusing-browser', marker, null);

      const result = runHarness(configPath, { CHROMIUM_PATH: refusing }, marker);

      expect(result.launched).toEqual([refusing]);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('Tests  no tests');
    },
    HARNESS_TIMEOUT_MS,
  );

  test(
    'PLAYWRIGHT_BROWSERS_PATH alone does not choose the executable',
    () => {
      // The flake points this at the Nix store's `bin` directory, which is how the
      // broken headless-shell path was built. With no executable selected, the
      // resolver has nothing to pass and nothing runs the instrument — which is
      // what keeps the two variables from being read as one setting.
      const result = runHarness(
        configPath,
        { CHROMIUM_PATH: '', PLAYWRIGHT_BROWSERS_PATH: join(dir, 'empty-cache') },
        marker,
      );

      expect(result.launched).toEqual([]);
    },
    HARNESS_TIMEOUT_MS,
  );

  test('both lanes read one resolver, and the two option shapes differ', async () => {
    // `apps/frontend/client/vitest.config.ts` and `apps/e2e/playwright.config.ts`
    // both import from `browser_path.ts`. Reading each proves they agree, and
    // that the provider shape still nests `launchOptions` — the detail that,
    // when flattened, type-checks and does nothing.
    //
    // Comment lines are dropped first: both files now *describe* the shape that
    // was dropped, and asserting on the whole text would fail on the
    // explanation rather than on the code.
    //
    // Line-by-line, never with a `/…\*…\*\/` pattern. `playwright.config.ts`
    // writes `` `/api/*` `` inside a `//` comment on line 19, and a block-comment
    // regex happily starts there and swallows the two import lines below it —
    // the same class of defect the repository's own boundary scanner used to
    // have. A line whose first non-space characters are `//`, `/*` or `*` is
    // comment; anything else is code.
    const code = async (path: string) =>
      (await Bun.file(path).text())
        .split('\n')
        .filter((line) => {
          const trimmed = line.trimStart();
          return !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*');
        })
        .join('\n');

    const clientConfig = await code(join(CLIENT_DIR, 'vitest.config.ts'));
    const e2eConfig = await code(E2E_CONFIG);

    expect(clientConfig).toContain("from '../../../scripts/src/shared/browser_path.ts'");
    expect(e2eConfig).toContain("from '../../scripts/src/shared/browser_path.ts'");
    // The exact shape that was dropped. A config object may still carry it and
    // the browser still launches something else.
    expect(clientConfig).not.toContain('launch: { executablePath');
    expect(e2eConfig).not.toContain('process.env.CHROMIUM_PATH ?');

    expect(Object.keys(vitestProviderOptions({}))).toEqual(['launchOptions']);
    expect(playwrightLaunchOptions({})).not.toHaveProperty('launchOptions');
  });
});
