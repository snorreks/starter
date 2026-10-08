import { fileURLToPath } from 'node:url';
import { publicToolEnvironment } from '../../../scripts/src/shared/private_environment.ts';
import { runBounded } from '../../../scripts/src/shared/run_bounded.ts';
import {
  allocateSupabaseLocal,
  hasSupabaseOwnership,
  readSupabaseOwnership,
  removeOwnedWorkerVars,
  startSupabaseLocal,
  stopSupabaseLocal,
  writeOwnedWorkerVars,
} from '../../../scripts/src/db/supabase_local.ts';

/** One bounded browser process; private keys reach only the owned Worker vars file. */
export const e2eProcessOptions = (options: {
  environment: NodeJS.ProcessEnv;
  varsPath: string;
  runId: string;
  args: string[];
}): Parameters<typeof runBounded>[0] => ({
  command: process.execPath,
  args: ['run', 'test:e2e:playwright', '--', ...options.args],
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  timeoutMs: 20 * 60_000,
  maxBytes: 16 * 1024 * 1024,
  onOutput: (stream, chunk) => process[stream].write(chunk),
  env: {
    ...publicToolEnvironment(options.environment),
    STARTER_DEV_VARS_PATH: options.varsPath,
    E2E_RUN_ID: options.runId,
  },
});

if (import.meta.main) {
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
    const result = await runBounded(
      e2eProcessOptions({
        environment: {
          ...process.env,
          SUPABASE_URL: supabaseUrl,
          SUPABASE_ANON_KEY: anonKey,
          SUPABASE_MAIL_URL: environment.SUPABASE_MAIL_URL,
        },
        varsPath: vars.path,
        runId: allocation.runId,
        args: process.argv.slice(2),
      }),
    );
    if (result.code !== 0) {
      process.stderr.write(result.stderr.slice(-4000));
    }
    exitCode = result.code;
  } finally {
    if (vars) {
      await removeOwnedWorkerVars(vars.path, vars.contents);
    }
    if (await hasSupabaseOwnership(allocation)) {
      await stopSupabaseLocal(allocation, await readSupabaseOwnership(allocation));
    }
  }
  process.exitCode = exitCode;
}
