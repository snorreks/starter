// apps/frontend/client/tests/database_paths.ts
//
// Where the committed Drizzle migrations live, and the repository root they are
// measured from.
//
// One module, imported by the Worker integration test and by the auth lifecycle
// test, because both need to apply the *real* migrations to a real database
// rather than a schema they wrote themselves. Two copies of this path would be two
// chances to point at the wrong directory — and pointing at a directory that
// happens to exist but holds no migrations produces an empty database and a test
// suite that passes for the wrong reason.
//
// Under `tests/` rather than `src/lib/server/`, and that placement is the point.
// Nothing in the application imports this; it is a harness concern. It was in
// `src/lib/server/`, which is the plane SvelteKit compiles into the Worker, and
// `node:url` is not something a Worker module may reach — `bun run guard` failed
// the build over it. A test file may use `node:url`; a module the application
// ships may not, and this was never one.
//
// That move is also why the migrations directory is derived from `REPO_ROOT`
// rather than from a second `new URL('../../../../..')`. The two tests sit at
// different depths, so two relative paths meant two counts to keep right; being
// wrong about either produces a `readdirSync` ENOENT that reads as a missing
// migration rather than as a wrong path, which is the expensive kind to diagnose.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repository root, from this file's URL.
 *
 * Four levels up: `tests/` → `client` → `frontend` → `apps` → root. Written out
 * rather than derived because getting it wrong is silent — `process.cwd()` is
 * correct for the unit lane and wrong for the Worker lane and for CI, so a path
 * built from it names a directory that exists somewhere else.
 */
export const REPO_ROOT: string = fileURLToPath(new URL('../../../../', import.meta.url)).replace(
  /\/$/,
  '',
);

/** The committed migrations, in the directory drizzle-kit writes them to. */
export const databaseMigrationsDir: string = join(
  REPO_ROOT,
  'packages/backend/database/drizzle-d1',
);
