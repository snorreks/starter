// scripts/src/setup/pins.ts
//
// The one authority for every version pin, and the readers that keep mirrors
// honest.
//
// `config/toolchain.json` is written by hand and read by the Nix flake, by
// `doctor`, and by a guard. Everything else that states a version is a *mirror*:
// `.bun-version` for `oven-sh/setup-bun` and proto, `flake.lock` for Nix.
//
// The reason this is centralised rather than left to convention: the two files
// drifted, `.bun-version` said 1.4.0 while CI pinned 1.4.2, and the symptom was
// `bun install --frozen-lockfile` failing in CI with a message about the lockfile
// that named nothing useful. `doctor` now fails on that, and so does
// `bun run guard`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';

export interface ToolchainPins {
  bun: string;
  playwright: {
    browsers: readonly string[];
  };
}

/** Strip the `"//"` comment members, which are documentation, not configuration. */
const withoutComments = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }

  const entries = Object.entries(raw).filter(
    ([key, value]) => key !== '//' && !(Array.isArray(value) && key === '//'),
  );

  return Object.fromEntries(entries);
};

/** Read the pins, or report why they could not be read. */
export const readPins = (root = REPO_ROOT): ToolchainPins | { error: string } => {
  const path = join(root, 'config/toolchain.json');

  if (!existsSync(path)) {
    return { error: `${path} is missing. It is the one place version pins live.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { error: `${path} is not valid JSON: ${String(error)}` };
  }

  const raw = withoutComments(parsed) as Partial<ToolchainPins>;

  if (typeof raw.bun !== 'string' || raw.bun.trim() === '') {
    return { error: `${path} has no "bun" version.` };
  }
  if (typeof raw.playwright?.browsers !== 'object' || raw.playwright?.browsers === null) {
    return { error: `${path} has no "playwright.browsers" list.` };
  }

  return raw as ToolchainPins;
};

export interface MirrorDrift {
  mirror: string;
  expected: string;
  found: string | null;
  reason: string;
}

/**
 * Compare every generated mirror against the pins.
 *
 * Read-only, and safe to call on a checkout with nothing installed: it compares
 * text, so it works before `bun install` has ever run.
 */
export const checkMirrors = (root = REPO_ROOT): MirrorDrift[] => {
  const pins = readPins(root);

  if ('error' in pins) {
    return [
      {
        mirror: 'config/toolchain.json',
        expected: 'a readable pin file',
        found: null,
        reason: pins.error,
      },
    ];
  }

  const drifts: MirrorDrift[] = [];

  // `.bun-version` — read by oven-sh/setup-bun in CI and by proto locally.
  const bunVersionFile = join(root, '.bun-version');
  const declared = existsSync(bunVersionFile) ? readFileSync(bunVersionFile, 'utf8').trim() : null;

  if (declared !== pins.bun) {
    drifts.push({
      mirror: '.bun-version',
      expected: pins.bun,
      found: declared,
      reason:
        '`.bun-version` is what CI installs. When it disagrees with the pin, a local `bun install` ' +
        "writes a lockfile that CI's `--frozen-lockfile` rejects, and the error names the lockfile " +
        'rather than the version.',
    });
  }

  // `.github/workflows/ci.yml` — GitHub Actions cannot read a file into a
  // workflow-level `env:`, so the Bun version is a literal there. That makes it a
  // second source of truth, and a second source of truth drifts. This is the
  // mirror that actually disagreed when the pin was 1.4.0.
  const workflowFile = join(root, '.github/workflows/ci.yml');
  if (existsSync(workflowFile)) {
    const workflow = readFileSync(workflowFile, 'utf8');
    const literal = /^\s*BUN_VERSION:\s*['"]?([^'"\s#]+)['"]?\s*$/m.exec(workflow);

    if (literal === null) {
      drifts.push({
        mirror: '.github/workflows/ci.yml',
        expected: `BUN_VERSION: '${pins.bun}'`,
        found: null,
        reason:
          'The workflow does not set BUN_VERSION. CI then installs whatever Bun the runner ' +
          'defaults to, which is the unpinned toolchain this repository exists to avoid.',
      });
    } else if (literal[1] !== pins.bun) {
      drifts.push({
        mirror: '.github/workflows/ci.yml',
        expected: pins.bun,
        found: literal[1],
        reason:
          'CI installs a different Bun than the pin. Every job runs the toolchain nobody ' +
          'tested locally, and a failure here is read as a change in the code under review.',
      });
    }
  }

  return drifts;
};

/**
 * Playwright's version, as the workspace declares it.
 *
 * Read from `apps/e2e/package.json` rather than the pins, because the browser
 * download is keyed by this version — the two must match and the lockfile is the
 * thing that actually installs it.
 */
export const declaredPlaywrightVersion = (root = REPO_ROOT): string | null => {
  const path = join(root, 'apps/e2e/package.json');
  if (!existsSync(path)) {
    return null;
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  return manifest.devDependencies?.['@playwright/test']?.replace(/^[\^~]/, '') ?? null;
};
