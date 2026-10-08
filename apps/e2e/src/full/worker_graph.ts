import { resolve } from 'node:path';
import type { V4WorkerOptions } from 'miniflare';

type JsonRecord = Record<string, unknown>;

const record = (value: unknown, label: string): JsonRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object in the Wrangler configuration.`);
  }
  return value as JsonRecord;
};

const string = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is missing from Wrangler configuration.`);
  }
  return value;
};

/** Read repository JSONC files whose comments occupy whole lines. */
export const parseWranglerJsonc = (source: string): JsonRecord => {
  const withoutLineComments = source.replace(/^\s*\/\/.*$/gm, '');
  try {
    return record(JSON.parse(withoutLineComments), 'Wrangler configuration');
  } catch (error) {
    throw new Error(
      `Cannot parse Wrangler JSONC: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export interface WorkerGraphOptions {
  client: JsonRecord;
  clientRoot: string;
  testRunId: string;
  appOrigin: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  supabaseMailUrl?: string;
}

export interface WorkerGraph {
  workers: V4WorkerOptions[];
  workerName: string;
  assetsDirectory: string;
}

/** Derive the built web Worker and its local Supabase bindings. */
export const buildWorkerGraph = (options: WorkerGraphOptions): WorkerGraph => {
  const name = string(options.client.name, 'client.name');
  const compatibilityDate = string(options.client.compatibility_date, 'client.compatibility_date');
  const main = string(options.client.main, 'client.main');
  const assets = record(options.client.assets, 'client.assets');
  const assetsDirectory = resolve(
    options.clientRoot,
    string(assets.directory, 'client.assets.directory'),
  );
  const assetBinding = string(assets.binding, 'client.assets.binding');
  const vars = options.client.vars === undefined ? {} : record(options.client.vars, 'client.vars');
  const flags = options.client.compatibility_flags;
  if (options.client.d1_databases !== undefined) {
    throw new Error('The web Worker must not declare an application D1 binding.');
  }
  if (vars.JOBS_PROFILE !== 'disabled') {
    throw new Error('The E2E template runtime requires JOBS_PROFILE=disabled explicitly.');
  }
  const worker: V4WorkerOptions = {
    name,
    scriptPath: resolve(options.clientRoot, main),
    modules: true,
    compatibilityDate,
    compatibilityFlags: Array.isArray(flags)
      ? flags.filter((flag): flag is string => typeof flag === 'string')
      : [],
    bindings: {
      ...vars,
      SUPABASE_URL: options.supabaseUrl,
      SUPABASE_ANON_KEY: options.supabaseAnonKey,
      SUPABASE_SERVICE_ROLE_KEY: options.supabaseServiceRoleKey,
      ...(options.supabaseMailUrl === undefined
        ? {}
        : { SUPABASE_MAIL_URL: options.supabaseMailUrl }),
      DEPLOYMENT_ENV: 'local',
      JOBS_PROFILE: 'disabled',
      APP_ORIGIN: options.appOrigin,
      TEST_RUN_ID: options.testRunId,
    },
    assets: {
      directory: assetsDirectory,
      binding: assetBinding,
      run_worker_first: true,
      routerConfig: { has_user_worker: true },
      assetConfig: {
        not_found_handling:
          typeof assets.not_found_handling === 'string' ? assets.not_found_handling : 'none',
      },
    },
  };
  return { workers: [worker], workerName: name, assetsDirectory };
};
