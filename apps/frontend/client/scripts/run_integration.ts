import { spawnSync } from 'bun';
import {
  allocateSupabaseLocal,
  hasSupabaseOwnership,
  readSupabaseOwnership,
  startSupabaseLocal,
  stopSupabaseLocal,
  writeOwnedWorkerVars,
  removeOwnedWorkerVars,
} from '../../../../scripts/src/db/supabase_local.ts';

const allocation = allocateSupabaseLocal(undefined, `worker_${crypto.randomUUID()}`);
let exitCode = 1;
let vars: { path: string; contents: string } | undefined;
try {
  const environment = await startSupabaseLocal(allocation, { jwtExpirySeconds: 10 });
  vars = await writeOwnedWorkerVars(allocation, {
    SUPABASE_URL: environment.SUPABASE_URL!,
    SUPABASE_ANON_KEY: environment.SUPABASE_ANON_KEY!,
    SUPABASE_SERVICE_ROLE_KEY: environment.SUPABASE_SERVICE_ROLE_KEY!,
  });
  const result = spawnSync([process.execPath, 'test', 'tests/worker_integration.test.ts'], {
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      SUPABASE_URL: environment.SUPABASE_URL,
      SUPABASE_ANON_KEY: environment.SUPABASE_ANON_KEY,
      STARTER_DEV_VARS_PATH: vars.path,
    },
  });
  exitCode = result.exitCode ?? 1;
} finally {
  if (vars) await removeOwnedWorkerVars(vars.path, vars.contents);
  if (await hasSupabaseOwnership(allocation)) {
    await stopSupabaseLocal(allocation, await readSupabaseOwnership(allocation));
  }
}
process.exitCode = exitCode;
