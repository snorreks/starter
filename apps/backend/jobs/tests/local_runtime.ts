// apps/backend/jobs/tests/local_runtime.ts
//
// The local runtime this lane drives: the real Workers runtime, the real Durable
// Object, the real Workflows engine, real local D1 and real local R2.
//
// Configured from the same facts `wrangler.jsonc` declares, and from the same
// bundle a deploy would ship. Nothing here mocks a binding: `getBindings()` hands
// back the real service bindings, which is the same mechanism
// `@cloudflare/vitest-pool-workers` uses to give a test its `env` — reachable
// directly here only because that package cannot be adopted alongside vitest 5
// (see the note in `scripts/compute_lane.ts`).
//
// What this helper deliberately does *not* provide: Cloudflare's managed container
// runtime. `ctx.container` does not exist locally, so the processor is reached by
// `PROCESSOR_ORIGIN` — pointing either at the real image running in Docker, or at a
// local server that misbehaves on purpose for a negative control. Every byte, every
// header and every validation is real in both cases.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const DIST_ENTRY = join(APP_DIR, 'dist/index.js');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/backend/database/drizzle-d1');

/**
 * A started instance.
 *
 * `create` returns a handle with `id` and `status()`. The handle is not part of the
 * port `createWorkflowDispatchPort` needs — that is the point of the split — so this
 * lane's runtime declares the handle separately and the tests that await completion
 * use it.
 */
export interface WorkflowInstanceHandle {
  id: string;
  status(): Promise<{ status: string }>;
}

/** The bindings, plus the started-instance type the tests await. */
export interface JobsBindings {
  DB: D1Database;
  MEDIA: R2Bucket;
  CONTAINER: DurableObjectNamespace;
  ENCODE_WORKFLOW: {
    create(options: { id: string; params?: unknown }): Promise<WorkflowInstanceHandle>;
  };
  MAINTENANCE_WORKFLOW: {
    create(options: { id: string; params?: unknown }): Promise<WorkflowInstanceHandle>;
  };
}

export interface JobsRuntime {
  miniflare: Miniflare;
  bindings: JobsBindings;
  dispose: () => Promise<void>;
}

/** Every committed migration, applied in order, to the real local database. */
const applyMigrations = async (db: D1Database): Promise<void> => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim().length > 0) {
        // One statement per `prepare`, not one `exec` per file: D1's `exec` splits
        // its input on newlines, and a `CREATE TABLE` spans many. Splitting here on
        // the `-->` marker the migration files already use is the same split
        // `wrangler d1 migrations apply` performs.
        await db.prepare(statement).run();
      }
    }
  }
};

/**
 * Start one runtime.
 *
 * `processorOrigin` is the processor this Worker is allowed to reach. Passing a
 * different origin starts a second runtime whose container broker points at it,
 * which is how the negative controls get a processor that lies.
 */
export const startJobsRuntime = async (options: {
  processorOrigin: string;
  migrations?: boolean;
}): Promise<JobsRuntime> => {
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'starter-jobs',
          modules: true,
          scriptPath: DIST_ENTRY,
          compatibilityDate: '2026-10-01',
          compatibilityFlags: ['nodejs_compat'],
          workflowExports: {
            EncodeWorkflow: { name: 'starter-encode' },
            MaintenanceWorkflow: { name: 'starter-maintenance' },
          },
          workflows: {
            ENCODE_WORKFLOW: { name: 'starter-encode', className: 'EncodeWorkflow' },
            MAINTENANCE_WORKFLOW: { name: 'starter-maintenance', className: 'MaintenanceWorkflow' },
          },
          d1Databases: { DB: 'jobs-lane-db' },
          r2Buckets: { MEDIA: 'jobs-lane-media' },
          durableObjects: { CONTAINER: { className: 'EncodeContainer', useSQLite: true } },
          bindings: {
            DEPLOYMENT_ENV: 'local',
            JOBS_PROFILE: 'encode',
            PROCESSOR_ORIGIN: options.processorOrigin,
            TEST_RUN_ID: 'jobs-compute-lane',
          },
        },
      ],
    }),
  );

  const bindings = (await miniflare.getBindings()) as unknown as JobsBindings;
  if (options.migrations !== false) {
    await applyMigrations(bindings.DB);
  }

  return { miniflare, bindings, dispose: async () => miniflare.dispose() };
};

/** A user row, because a job's owner is a foreign key and this is a real database. */
export const seedUser = async (db: D1Database, id: string): Promise<void> => {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, 'Compute Lane', `${id}@example.test`, now, now)
    .run();
};

/**
 * Put the real fixture bytes in the real bucket.
 *
 * Read from the committed file rather than generated here, so the bytes this lane
 * encodes are the bytes the media crate shipped and whose provenance is recorded.
 */
export const seedFixture = async (
  bucket: R2Bucket,
  key: string,
  sourcePath: string,
): Promise<number> => {
  const { readFile } = await import('node:fs/promises');
  const bytes = new Uint8Array(await readFile(sourcePath));
  await bucket.put(key, bytes, { httpMetadata: { contentType: 'video/mp4' } });
  return bytes.byteLength;
};

/** Wait for an instance to reach a terminal status, or report it is still running. */
export const awaitInstance = async (
  instance: WorkflowInstanceHandle,
  timeoutMs = 120_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  while (Date.now() < deadline) {
    const status = await instance.status();
    last = status.status;
    if (last === 'complete' || last === 'errored' || last === 'terminated') {
      return last;
    }
    await Bun.sleep(50);
  }
  return `timeout:${last}`;
};
