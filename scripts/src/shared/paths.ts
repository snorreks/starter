// scripts/src/shared/paths.ts
//
// One place that knows where the repository is and which directories matter.
//
// Every other module imports these instead of recomputing a path from
// `import.meta.url`. Two reasons, both learned the hard way:
//
//   * `new URL(..., import.meta.url).pathname` percent-encodes, so a checkout
//     under a directory containing a space resolves to a nonexistent location and
//     the failure looks like a missing config file rather than a path bug.
//   * Getting the depth wrong is silent. `../../../..` from `scripts/src/shared`
//     is the *parent* of the repository, and every path built from it is wrong
//     in a way that reads as "no migrations found" or "no wrangler.jsonc".

import { fileURLToPath } from 'node:url';

// `scripts/src/shared/` -> three levels up is the repository root.
//
// `at()` strips the trailing separator `fileURLToPath` adds for a directory URL,
// so a string comparison against another module's path is meaningful.
const at = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url)).replace(/\/$/, '');

export const REPO_ROOT = at('../../../');

/**
 * The one application: `apps/frontend/client`.
 *
 * Named `CLIENT_DIR` because that is the path it has always had, and moving it
 * would be a rename unrelated to the runtime change. The comment is here so a
 * reader is not misled by the name into looking for a second application: the
 * `apps/backend/api` application this used to be paired with is gone, and this
 * directory now holds the browser half and the Worker half of a single SvelteKit
 * app. See docs/architecture.md.
 */
export const CLIENT_DIR = at('../../../apps/frontend/client');

/**
 * `CLIENT_DIR` relative to `REPO_ROOT`, for callers that take a `root`.
 *
 * `CLIENT_DIR` is absolute, so `join(root, CLIENT_DIR)` silently ignores `root`
 * and returns `CLIENT_DIR` — which is how `provisionDatabase` ended up writing its
 * test fixture's database id into the repository's committed `wrangler.jsonc`.
 * Anything that honours a caller-supplied root resolves through this instead.
 */
export const CLIENT_DIR_RELATIVE = 'apps/frontend/client';

/** The static SvelteKit app and its Tauri shell. */
export const NATIVE_DIR = at('../../../apps/frontend/native');
export const E2E_DIR = at('../../../apps/e2e');
export const DATABASE_DIR = at('../../../packages/backend/database');
export const PI_DIR = at('../../../.pi');

/**
 * The private jobs Worker: Workflows dispatch, no public route.
 *
 * Kept here with the other application directories rather than beside
 * `target.ts`'s `JOBS_DIR_RELATIVE`, because both the deploy target and the local
 * service now need it and two constants that must agree are the shape this
 * repository keeps failing on.
 */
export const JOBS_DIR = at('../../../apps/backend/jobs');
export const JOBS_DIR_RELATIVE = 'apps/backend/jobs';
