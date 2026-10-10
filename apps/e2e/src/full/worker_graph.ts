import { resolve } from 'node:path';
import type { V4FetchHandler, V4WorkerOptions } from 'miniflare';

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
  compute?: {
    jobsRoot: string;
    bindings: Record<string, string>;
    outbound: V4FetchHandler;
  };
  /**
   * Stripe bindings for the full lane.
   *
   * Separate from `compute.bindings` because they belong to the web Worker only:
   * the jobs Worker dispatches encodes and has no billing credentials, and giving
   * it some would put a secret in a component that does not need it.
   */
  stripe?: {
    apiBase: string;
    secretKey: string;
    webhookSecret: string;
  };
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

  /**
   * Stripe bindings, mapped from the option's field names to the Worker's.
   *
   * An explicit map rather than a spread, because spreading `apiBase` produces a
   * binding named `apiBase` — and the application, quite correctly, looks for
   * `STRIPE_API_BASE` and reports `stripe_not_configured`. That is exactly the
   * failure the first run of this lane produced: a fixture that supplied Stripe,
   * a route that refused to use it, and a green-looking graph.
   *
   * All-or-nothing on purpose. Half a configuration is worse than none: the
   * checkout route checks for a key *and* a base, so one of them alone would look
   * unconfigured while the other sat in the Worker unused.
   */
  const stripeBindings: Record<string, string> = {};
  if (options.stripe !== undefined) {
    const { apiBase, secretKey, webhookSecret } = options.stripe;
    const missing = Object.entries({ apiBase, secretKey, webhookSecret })
      .filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`Incomplete Stripe configuration: missing or blank ${missing.join(', ')}.`);
    }
    stripeBindings.STRIPE_API_BASE = apiBase;
    stripeBindings.STRIPE_SECRET_KEY = secretKey;
    stripeBindings.STRIPE_WEBHOOK_SECRET = webhookSecret;
  }

  if (!options.compute) {
    worker.bindings = { ...worker.bindings, ...stripeBindings };
    return { workers: [worker], workerName: name, assetsDirectory };
  }

  const jobsName = `${name}-jobs`;
  // Shared: what both Workers need. The jobs Worker dispatches encodes and reads
  // job state from Supabase; it has no billing surface, so a Stripe secret must not
  // be in this object — a secret in a component that never uses it is a secret with
  // an extra path out of it.
  const sharedBindings = {
    ...(worker.bindings ?? {}),
    ...options.compute.bindings,
    JOBS_PROFILE: 'encode',
  };
  // Web-only: the billing credentials, added for the Worker that does bill and
  // withheld from the jobs Worker, which has no billing surface.
  const webBindings = { ...sharedBindings, ...stripeBindings };
  const workflows = {
    ENCODE_WORKFLOW: { name: 'e2e-encode', className: 'EncodeWorkflow', scriptName: jobsName },
    MAINTENANCE_WORKFLOW: {
      name: 'e2e-maintenance',
      className: 'MaintenanceWorkflow',
      scriptName: jobsName,
    },
  };
  const r2Buckets = { MEDIA: `e2e-media-${options.testRunId}` };
  worker.bindings = webBindings;
  worker.workflows = workflows;
  worker.r2Buckets = r2Buckets;
  worker.outboundService = options.compute.outbound;
  const jobsWorker: V4WorkerOptions = {
    name: jobsName,
    scriptPath: resolve(options.compute.jobsRoot, 'dist/index.js'),
    modules: true,
    compatibilityDate,
    compatibilityFlags: worker.compatibilityFlags,
    bindings: sharedBindings,
    workflows,
    r2Buckets,
    outboundService: options.compute.outbound,
  };
  return { workers: [worker, jobsWorker], workerName: name, assetsDirectory };
};
