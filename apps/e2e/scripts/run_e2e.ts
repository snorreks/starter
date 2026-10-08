import { spawnSync } from 'bun';
import {
  allocateSupabaseLocal,
  hasSupabaseOwnership,
  readSupabaseOwnership,
  removeOwnedWorkerVars,
  startSupabaseLocal,
  stopSupabaseLocal,
  writeOwnedWorkerVars,
} from '../../../scripts/src/db/supabase_local.ts';

const allocation = allocateSupabaseLocal(undefined, `e2e_${crypto.randomUUID()}`);
let exitCode = 1;
let vars: { path: string; contents: string } | undefined;
try {
  const environment = await startSupabaseLocal(allocation, { emailConfirmations: true });
  const required = (name: 'SUPABASE_URL' | 'SUPABASE_ANON_KEY' | 'SUPABASE_SERVICE_ROLE_KEY') => {
    const value = environment[name];
    if (value === undefined || value.length === 0) {
      throw new Error(`The E2E Supabase runtime did not provide ${name}.`);
    }
    return value;
  };
  const supabaseUrl = required('SUPABASE_URL');
  const anonKey = required('SUPABASE_ANON_KEY');
  const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
  vars = await writeOwnedWorkerVars(allocation, {
    SUPABASE_URL: supabaseUrl,
    SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  });
  const result = spawnSync(
    [process.execPath, 'run', 'test:e2e:playwright', '--', ...process.argv.slice(2)],
    {
      cwd: process.cwd(),
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...process.env,
        SUPABASE_URL: supabaseUrl,
        SUPABASE_ANON_KEY: anonKey,
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
        SUPABASE_MAIL_URL: environment.SUPABASE_MAIL_URL,
        STARTER_DEV_VARS_PATH: vars.path,
        E2E_RUN_ID: allocation.runId,
      },
    },
  );
  exitCode = result.exitCode ?? 1;
} finally {
  if (vars) {
    await removeOwnedWorkerVars(vars.path, vars.contents);
  }
  if (await hasSupabaseOwnership(allocation)) {
    await stopSupabaseLocal(allocation, await readSupabaseOwnership(allocation));
  }
}
process.exitCode = exitCode;
