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
export const API_DIR = at('../../../apps/backend/api');
export const CLIENT_DIR = at('../../../apps/frontend/client');
export const E2E_DIR = at('../../../apps/e2e');
export const DATABASE_DIR = at('../../../packages/backend/database');
export const PI_DIR = at('../../../.pi');
