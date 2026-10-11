// scripts/src/shared/tools.ts
//
// Resolve a workspace tool to the version this repository pinned.
//
// The reason this module exists: `bunx <tool>` from the repository root does NOT
// find a tool that only one workspace package depends on. `wrangler` is declared
// by `apps/frontend/client` and `scripts`, so its binary lives in those packages'
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
/**
 * The filenames a package manager may give one binary, in the order to try them.
 *
 * `tauri` alone works on Linux and macOS and misses on Windows, where a `.bin`
 * entry is a shim named `<tool>.cmd` (and Bun may also write `<tool>.exe` for a
 * real native binary). That produced a Windows CI job reporting
 * `MISS tauri cli — not installed` on a runner where `bun install` had just
 * installed it, one minute before a build that needed it.
 *
 * The extensionless name stays first: a POSIX symlink is what both Unix package
 * managers create, and a `cmd` shim would not be runnable there anyway.
 */
export const BIN_SUFFIXES = ['', '.cmd', '.exe'] as const;

/**
 * `root` is a parameter for the same reason `checkMirrors(root)` takes one: this
 * resolves paths inside a repository, and asserting that against the live
 * `node_modules` would test whatever the last `bun install` happened to produce.
 * A fixture tree with a `.bin` directory in it is the thing that can be made to
 * fail on purpose.
 */
export const resolveWorkspaceBin = (
  tool: string,
  declaringPackages: readonly string[] = [],
  root: string = REPO_ROOT,
): string | null => {
  const directories = [
    ...declaringPackages.map((packageDir) => join(root, packageDir, 'node_modules', '.bin')),
    join(root, 'node_modules', '.bin'),
  ];

  // Suffix inside the directory loop, not the other way round: the *declaring
  // package* is the more specific answer, so a tool declared by this project must
  // win even when the root only has the other platform's shim.
  for (const directory of directories) {
    for (const suffix of BIN_SUFFIXES) {
      const candidate = join(directory, `${tool}${suffix}`);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
};

/**
 * The environment Moon has to run in, for the Bun this repository supplies.
 *
 * Moon does not resolve a toolchain from `PATH`. It embeds protox, and protox
 * asks the proto store for the pinned version — measured here with
 * `@moonrepo/cli` 2.6.1, `.bun-version` at 1.4.3 and no 1.4.3 in that store:
 *
 *     $ moon bin bun
 *     × Process proto failed: exit code 1
 *
 *     ui:lint | {"code":"proto::commands::run::missing_tool","message":"This
 *     project requires Bun 1.4.3 (detected from …/.bun-version), but this
 *     version has not been installed. Install it with proto install bun 1.4.3"}
 *
 * Deleting `.bun-version` does not produce "use the Bun on PATH" either. With
 * the file gone, `moon bin bun` answered with
 * `~/.local/share/proto/tools/bun/1.1.31/bun` — the version pinned in the
 * *global* `~/.local/share/proto/.prototools`. So a repository that declares a
 * `bun` toolchain and does not want proto does not get a different Bun; it gets
 * whatever a version manager it never installed happened to pin.
 *
 * `MOON_TOOLCHAIN_FORCE_GLOBALS` is Moon's own documented switch for this
 * ("Force toolchains to use globally installed tools instead of proto-managed
 * versions", the one Moon sets for itself inside Docker). With it, the same
 * `moon run ui:lint` ran the Nix-provided Bun while `.bun-version` named a
 * version the proto store did not have; without it, that task failed.
 *
 * Every spawn of Moon in this repository goes through this function:
 * `scripts/src/commands/cached.ts` (every `bun run test|lint|format|fix|
 * typecheck|e2e|build`), `scripts/src/coverage/coverage.ts` and
 * `scripts/src/hooks/pre_commit.ts`. `flake.nix` exports the same variable so a
 * Moon typed directly in the developer's shell — and every agent process that
 * shells out to one — gets the same Bun the lane validated.
 *
 * It is set unconditionally rather than only when absent: an inherited
 * `MOON_TOOLCHAIN_FORCE_GLOBALS=0` from an outer environment would otherwise
 * reintroduce proto on a machine that has one.
 */
export const moonToolchainEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...env,
  MOON_TOOLCHAIN_FORCE_GLOBALS: '1',
});

/**
 * Wrangler, as pinned by `apps/frontend/client` (the package that deploys) and
 * `scripts`.
 */
export const wranglerBin = (): string | null =>
  resolveWorkspaceBin('wrangler', ['apps/frontend/client', 'scripts']);

/** Drizzle Kit, as pinned by `packages/backend/database`. */
export const drizzleKitBin = (): string | null =>
  resolveWorkspaceBin('drizzle-kit', ['packages/backend/database']);

/** Vite, as pinned by `apps/frontend/client`. Used to start the dev server. */
export const viteBin = (): string | null => resolveWorkspaceBin('vite', ['apps/frontend/client']);

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
