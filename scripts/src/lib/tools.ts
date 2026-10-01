// scripts/src/lib/tools.ts
//
// Resolve a workspace tool to the version this repository pinned.
//
// The reason this module exists: `bunx <tool>` from the repository root does NOT
// find a tool that only one workspace package depends on. `wrangler` is declared
// by `apps/backend/api` and `scripts`, so its binary lives in those packages'
// `node_modules/.bin`, and `node_modules/.bin` at the root does not contain it.
// `bunx wrangler` therefore falls through to the network and runs whatever the
// registry served that day. Observed here: the lockfile pins 4.142.0, and
// `bunx wrangler --version` reported 4.144.0.
//
// That is not a cosmetic drift. A deploy tool running a different major-minor
// than the one the project validated is how "works on my machine" starts, and
// it makes a locally green verification meaningless.
//
// Resolution order:
//   1. `<workspace package>/node_modules/.bin/<tool>` for the packages that declare it
//   2. `<repo>/node_modules/.bin/<tool>`
//   3. nothing — the caller reports the tool as unavailable
//
// There is deliberately no `bunx` fallback here. A caller that wants a
// network-fetched tool should say so explicitly, and nothing in this repository
// should: the pinned version is the one that was tested.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.ts';

const isExecutableFile = (path: string): boolean => {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
};

/**
 * Find a workspace binary.
 *
 * `declaringPackages` are workspace-relative directories, most specific first.
 * Order matters: two packages can declare different versions of the same tool and
 * the more specific caller should win.
 */
export const resolveWorkspaceBin = (
  tool: string,
  declaringPackages: readonly string[] = [],
): string | null => {
  for (const packageDir of declaringPackages) {
    const candidate = join(REPO_ROOT, packageDir, 'node_modules', '.bin', tool);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  const rootBin = join(REPO_ROOT, 'node_modules', '.bin', tool);
  return isExecutableFile(rootBin) ? rootBin : null;
};

/** Wrangler, as pinned by `apps/backend/api` (the package that deploys). */
export const wranglerBin = (): string | null =>
  resolveWorkspaceBin('wrangler', ['apps/backend/api', 'scripts']);

/** Drizzle Kit, as pinned by `packages/backend/database`. */
export const drizzleKitBin = (): string | null =>
  resolveWorkspaceBin('drizzle-kit', ['packages/backend/database']);

/** Playwright, as pinned by `apps/frontend/client` and used by `apps/e2e`. */
export const playwrightBin = (): string | null =>
  resolveWorkspaceBin('playwright', ['apps/e2e', 'apps/frontend/client']);

/**
 * A readable, actionable report for "the tool is missing".
 *
 * The template ships no global installs and this is a fresh clone, so "not found"
 * almost always means "run `bun install`", not "install it yourself somewhere".
 */
export const missingToolMessage = (tool: string, declaringPackage: string): string =>
  `${tool} is not installed. It is a pinned workspace dependency of ${declaringPackage}. ` +
  `Run \`bun install\` from the repository root.`;
