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

const rows = (value: unknown, label: string): JsonRecord[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array in Wrangler configuration.`);
  }
  return value.map((item, index) => record(item, `${label}[${index}]`));
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

const bindingNames = (
  rowsValue: unknown,
  bindingKey: string,
  resourceKey: string,
): Record<string, string> =>
  Object.fromEntries(
    rows(rowsValue, resourceKey).map((row, index) => [
      string(row[bindingKey], `${resourceKey}[${index}].${bindingKey}`),
      string(
        row[resourceKey === 'd1_databases' ? 'database_name' : 'bucket_name'],
        `${resourceKey}[${index}].${resourceKey}`,
      ),
    ]),
  );

export interface WorkerGraphOptions {
  client: JsonRecord;
  jobs: JsonRecord;
  clientRoot: string;
  jobsRoot: string;
  testRunId: string;
  processorOrigin: string;
  authSecret: string;
  trustedOrigins: string;
}

export interface WorkerGraph {
  workers: V4WorkerOptions[];
  migrationDirectory: string;
  databaseName: string;
  mediaBucketName: string;
  workflowName: string;
  workflowClass: string;
}

/** Derive the test graph from both committed Wrangler configurations. */
export const buildWorkerGraph = (options: WorkerGraphOptions): WorkerGraph => {
  const webName = string(options.client.name, 'client.name');
  const jobsName = string(options.jobs.name, 'jobs.name');
  if (webName === jobsName) {
    throw new Error('Web and jobs Workers need distinct names.');
  }
  const webDate = string(options.client.compatibility_date, 'client.compatibility_date');
  const jobsDate = string(options.jobs.compatibility_date, 'jobs.compatibility_date');
  if (webDate !== jobsDate) {
    throw new Error('Web and jobs Workers must share the configured compatibility date.');
  }
  const webFlags = options.client.compatibility_flags;
  const jobsFlags = options.jobs.compatibility_flags;
  if (JSON.stringify(webFlags ?? []) !== JSON.stringify(jobsFlags ?? [])) {
    throw new Error('Web and jobs Workers must share compatibility flags.');
  }

  const webD1 = bindingNames(options.client.d1_databases, 'binding', 'd1_databases');
  const jobsD1 = bindingNames(options.jobs.d1_databases, 'binding', 'd1_databases');
  if (webD1.DB === undefined || jobsD1.DB === undefined || webD1.DB !== jobsD1.DB) {
    throw new Error('Web and jobs Workers must share the same D1 database identity.');
  }
  const jobsMedia = bindingNames(options.jobs.r2_buckets, 'binding', 'r2_buckets');
  const mediaBucketName = jobsMedia.MEDIA;
  if (mediaBucketName === undefined) {
    throw new Error('The jobs Worker must declare its MEDIA R2 bucket.');
  }
  const doConfig = record(options.jobs.durable_objects, 'jobs.durable_objects');
  const durableBindings = rows(doConfig.bindings, 'jobs.durable_objects.bindings');
  const container = durableBindings.find((entry) => entry.name === 'CONTAINER');
  if (container === undefined) {
    throw new Error('The jobs Worker must declare its CONTAINER Durable Object.');
  }

  const workflowEntries = rows(options.jobs.workflows, 'jobs.workflows');
  const workflow = workflowEntries.find((entry) => entry.binding === 'ENCODE_WORKFLOW');
  if (workflow === undefined) {
    throw new Error('The jobs Worker must declare ENCODE_WORKFLOW.');
  }
  const workflowName = string(workflow.name, 'jobs ENCODE_WORKFLOW name');
  const workflowClass = string(workflow.class_name, 'jobs ENCODE_WORKFLOW class_name');
  const workflowExports = Object.fromEntries(
    workflowEntries.map((entry, index) => [
      string(entry.class_name, `jobs.workflows[${index}].class_name`),
      { name: string(entry.name, `jobs.workflows[${index}].name`) },
    ]),
  );
  const workflowBindings = Object.fromEntries(
    workflowEntries.map((entry, index) => [
      string(entry.binding, `jobs.workflows[${index}].binding`),
      {
        name: string(entry.name, `jobs.workflows[${index}].name`),
        className: string(entry.class_name, `jobs.workflows[${index}].class_name`),
      },
    ]),
  );
  const webWorkflow = workflowBindings.ENCODE_WORKFLOW;
  if (webWorkflow === undefined) {
    throw new Error('No ENCODE_WORKFLOW binding could be derived.');
  }

  const clientAssets = record(options.client.assets, 'client.assets');
  const clientMain = string(options.client.main, 'client.main');
  const jobsMain = string(options.jobs.main, 'jobs.main');
  const migration = rows(options.jobs.d1_databases, 'jobs.d1_databases')[0];
  if (migration === undefined) {
    throw new Error('The jobs D1 migration declaration is missing.');
  }
  const migrationDirectory = resolve(
    options.jobsRoot,
    string(migration.migrations_dir, 'jobs.d1_databases[0].migrations_dir'),
  );
  const webVars =
    options.client.vars === undefined ? {} : record(options.client.vars, 'client.vars');
  const jobsVars = options.jobs.vars === undefined ? {} : record(options.jobs.vars, 'jobs.vars');

  const common = {
    compatibilityDate: webDate,
    compatibilityFlags: Array.isArray(webFlags)
      ? webFlags.filter((flag): flag is string => typeof flag === 'string')
      : [],
  };
  const workers: V4WorkerOptions[] = [
    {
      name: webName,
      scriptPath: resolve(options.clientRoot, clientMain),
      modules: true,
      ...common,
      bindings: {
        ...webVars,
        DEPLOYMENT_ENV: 'local',
        JOBS_PROFILE: 'encode',
        TEST_RUN_ID: options.testRunId,
        BETTER_AUTH_SECRET: options.authSecret,
        AUTH_RATE_LIMIT_MAX: '500',
        TRUSTED_ORIGINS: options.trustedOrigins,
      },
      d1Databases: webD1,
      r2Buckets: { ...jobsMedia },
      workflows: {
        ENCODE_WORKFLOW: { ...webWorkflow, scriptName: jobsName },
      },
      assets: {
        directory: resolve(
          options.clientRoot,
          string(clientAssets.directory, 'client.assets.directory'),
        ),
        binding: string(clientAssets.binding, 'client.assets.binding'),
        run_worker_first: true,
        routerConfig: { has_user_worker: true },
        assetConfig: {
          not_found_handling:
            typeof clientAssets.not_found_handling === 'string'
              ? clientAssets.not_found_handling
              : 'none',
        },
      },
    },
    {
      name: jobsName,
      scriptPath: resolve(options.jobsRoot, jobsMain),
      modules: true,
      ...common,
      bindings: {
        ...jobsVars,
        DEPLOYMENT_ENV: 'local',
        JOBS_PROFILE: 'encode',
        PROCESSOR_ORIGIN: options.processorOrigin,
        TEST_RUN_ID: options.testRunId,
      },
      d1Databases: jobsD1,
      r2Buckets: jobsMedia,
      durableObjects: {
        CONTAINER: {
          className: string(container.class_name, 'jobs CONTAINER class_name'),
          useSQLite: true,
        },
      },
      workflowExports,
      workflows: workflowBindings,
    },
  ];
  return {
    workers,
    migrationDirectory,
    databaseName: webD1.DB,
    mediaBucketName,
    workflowName,
    workflowClass,
  };
};
