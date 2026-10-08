import { fileURLToPath } from 'node:url';
import {
  allocateSupabaseLocal,
  hasSupabaseOwnership,
  readSupabaseOwnership,
  removeOwnedWorkerVars,
  startSupabaseLocal,
  stopSupabaseLocal,
  writeOwnedWorkerVars,
} from '../../../scripts/src/db/supabase_local.ts';
import { publicToolEnvironment } from '../../../scripts/src/shared/private_environment.ts';
import { runBounded } from '../../../scripts/src/shared/run_bounded.ts';

/** One bounded browser process; private keys reach only the owned Worker vars file. */
export const e2eProcessOptions = (options: {
  environment: NodeJS.ProcessEnv;
  varsPath: string;
  runId: string;
  args: string[];
  full?: boolean;
}): Parameters<typeof runBounded>[0] => ({
  command: process.execPath,
  args: [
    'run',
    options.full ? 'test:full:playwright' : 'test:e2e:playwright',
    '--',
    ...options.args,
  ],
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  timeoutMs: (options.full ? 30 : 20) * 60_000,
  maxBytes: 16 * 1024 * 1024,
  onOutput: (stream, chunk) => process[stream].write(chunk),
  env: {
    ...publicToolEnvironment(options.environment),
    STARTER_DEV_VARS_PATH: options.varsPath,
    E2E_RUN_ID: options.runId,
  },
});

const e2eDependencies = {
  allocateSupabaseLocal,
  startSupabaseLocal,
  writeOwnedWorkerVars,
  runBounded,
  removeOwnedWorkerVars,
  hasSupabaseOwnership,
  readSupabaseOwnership,
  stopSupabaseLocal,
  reportTeardownFailure: (error: unknown) => {
    process.stderr.write(
      `E2E teardown failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  },
};

export const runE2E = async (
  args: string[],
  overrides: Partial<typeof e2eDependencies> = {},
): Promise<number> => {
  const dependencies = { ...e2eDependencies, ...overrides };
  const full = args[0] === '--full';
  const allocation = dependencies.allocateSupabaseLocal(undefined, `e2e_${crypto.randomUUID()}`);
  let exitCode = 1;
  let vars: { path: string; contents: string } | undefined;
  try {
    const environment = await dependencies.startSupabaseLocal(allocation, {
      emailConfirmations: true,
    });
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
    vars = await dependencies.writeOwnedWorkerVars(allocation, {
      SUPABASE_URL: supabaseUrl,
      SUPABASE_ANON_KEY: anonKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    });
    const result = await dependencies.runBounded(
      e2eProcessOptions({
        environment: {
          ...process.env,
          SUPABASE_URL: supabaseUrl,
          SUPABASE_ANON_KEY: anonKey,
          SUPABASE_MAIL_URL: environment.SUPABASE_MAIL_URL,
        },
        varsPath: vars.path,
        runId: allocation.runId,
        args: full ? args.slice(1) : args,
        full,
      }),
    );
    if (result.code !== 0) {
      process.stderr.write(result.stderr.slice(-4000));
    }
    exitCode = result.code;
  } finally {
    const failures: unknown[] = [];
    try {
      if (vars) {
        await dependencies.removeOwnedWorkerVars(vars.path, vars.contents);
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      if (await dependencies.hasSupabaseOwnership(allocation)) {
        await dependencies.stopSupabaseLocal(
          allocation,
          await dependencies.readSupabaseOwnership(allocation),
        );
      }
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      dependencies.reportTeardownFailure(failures[0]);
      if (exitCode === 0) {
        exitCode = 1;
      }
    }
  }
  return exitCode;
};

if (import.meta.main) {
  process.exitCode = await runE2E(process.argv.slice(2));
}
