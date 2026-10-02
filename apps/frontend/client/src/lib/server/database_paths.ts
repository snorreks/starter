// apps/frontend/client/src/lib/server/database_paths.ts
//
// Where the committed Drizzle migrations live.
//
// One module, imported by the Worker integration test and by the auth lifecycle
// test, because both need to apply the *real* migrations to a real database
// rather than a schema they wrote themselves. Two copies of this path would be two
// chances to point at the wrong directory — and pointing at a directory that
// happens to exist but holds no migrations produces an empty database and a test
// suite that passes for the wrong reason.
//
// This is server-only for the same reason the rest of `src/lib/server` is, though
// it reads no binding and touches no platform API.
//
// Path is relative to this file rather than to `process.cwd()`. The unit lane
// runs from the package root, the Worker lane from the same place, and CI from
// wherever it likes; a `cwd`-relative path is only correct for one of those.

import { fileURLToPath } from 'node:url';

/**
 * Six `..`, not five and not seven.
 *
 * `server/` → `lib` → `src` → `client` → `frontend` → `apps` → repository root,
 * then into `packages/backend/database`. The count is written out rather than
 * derived because getting it wrong is silent: a `cwd`-relative or off-by-one path
 * either names a directory that does not exist (a loud failure, fine) or, if the
 * repository is ever nested differently, one that exists and holds no migrations —
 * which yields an empty database and a suite that passes for the wrong reason.
 */
export const databaseMigrationsDir: string = fileURLToPath(
  new URL('../../../../../../packages/backend/database/drizzle-d1/', import.meta.url),
);
