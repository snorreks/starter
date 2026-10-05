import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseConfigFileTextToJson } from 'typescript';
import { REPO_ROOT } from '../shared/paths.ts';
import type { ResolvedTarget } from './target.ts';

/** Exact-target configs are local artifacts, not a second configuration authority. */
export const remoteConfigPath = (options: {
  target: ResolvedTarget;
  root?: string;
  kind?: 'web' | 'jobs';
}): string =>
  join(
    options.root ?? REPO_ROOT,
    '.starter/deploy',
    `${options.target.environment}-${options.kind ?? 'web'}.json`,
  );

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Wrangler configuration must contain objects.');
  }
  return value as Record<string, unknown>;
};

const pathFrom = (options: { directory: string; value: unknown }): string => {
  if (typeof options.value !== 'string' || options.value === '') {
    throw new Error('Wrangler configuration is missing a required artifact path.');
  }
  return resolve(options.directory, options.value);
};

/**
 * Render an environment's remote bindings exclusively from its validated target.
 * Source files own runtime/build policy; targets own every remote identity.
 * No env flag remains for Wrangler's legacy secret-name suffixing to reinterpret.
 */
export const renderRemoteConfig = (options: {
  target: ResolvedTarget;
  root?: string;
  kind?: 'web' | 'jobs';
}): Record<string, unknown> => {
  const { target } = options;
  const root = options.root ?? REPO_ROOT;
  const kind = options.kind ?? 'web';
  const sourcePath = join(root, kind === 'web' ? target.wranglerConfig : target.jobsWranglerConfig);
  const parsed = parseConfigFileTextToJson(sourcePath, readFileSync(sourcePath, 'utf8'));
  if (parsed.error !== undefined) {
    throw new Error('Cannot parse the source Wrangler config.');
  }
  const source = object(parsed.config);
  const environments = source.env === undefined ? {} : object(source.env);
  const scoped =
    environments[target.environment] === undefined ? {} : object(environments[target.environment]);
  const config = { ...source, ...scoped };
  config.env = undefined;
  config.$schema = undefined;
  const directory = dirname(sourcePath);
  config.name = kind === 'web' ? target.workerName : target.compute.jobsWorkerName;
  config.account_id = target.accountId;
  config.main = pathFrom({ directory, value: config.main });
  config.vars = {
    ...(source.vars === undefined ? {} : object(source.vars)),
    ...(scoped.vars === undefined ? {} : object(scoped.vars)),
    DEPLOYMENT_ENV: target.environment,
    JOBS_PROFILE: target.compute.profile,
    ...(kind === 'web' ? { BETTER_AUTH_URL: target.origin, MAIL_FROM: target.mailFrom } : {}),
  };
  config.d1_databases = [
    {
      binding: 'DB',
      database_name: `${target.project}-${target.environment}-db`,
      database_id: target.d1DatabaseId,
      migrations_dir: join(root, 'packages/backend/database/drizzle-d1'),
    },
  ];
  if (kind === 'web') {
    const assets = object(config.assets);
    config.assets = { ...assets, directory: pathFrom({ directory, value: assets.directory }) };
    const origin = new URL(target.origin);
    config.workers_dev = origin.hostname.endsWith('.workers.dev');
    config.routes = config.workers_dev ? [] : [{ pattern: origin.hostname, custom_domain: true }];
    if (!target.compute.enabled) {
      config.r2_buckets = undefined;
      config.workflows = undefined;
      return config;
    }
    config.workflows = [
      {
        binding: 'ENCODE_WORKFLOW',
        class_name: 'EncodeWorkflow',
        name: target.compute.encodeWorkflowName,
        script_name: target.compute.jobsWorkerName,
      },
    ];
  } else {
    if (!target.compute.enabled) {
      throw new Error('Cannot render a jobs Worker when compute is disabled.');
    }
    config.workers_dev = false;
    config.routes = [];
    const workflows = config.workflows;
    if (!Array.isArray(workflows)) {
      throw new Error('Jobs configuration is missing its Workflow policy.');
    }
    config.workflows = workflows.map((entry: unknown) => {
      const workflow = object(entry);
      if (workflow.binding === 'ENCODE_WORKFLOW') {
        return { ...workflow, name: target.compute.encodeWorkflowName };
      }
      if (workflow.binding === 'MAINTENANCE_WORKFLOW') {
        return { ...workflow, name: target.compute.maintenanceWorkflowName };
      }
      throw new Error('Unrecognised jobs Workflow binding.');
    });
    if (!Array.isArray(config.containers) || config.containers.length !== 1) {
      throw new Error('Jobs configuration must describe exactly one processor container.');
    }
    const container = object(config.containers[0]);
    const image = target.compute.containerImage;
    if (image === null) {
      throw new Error('No processor image was resolved.');
    }
    config.containers = [
      {
        ...container,
        image:
          image.includes('Dockerfile') || isAbsolute(image) ? resolve(directory, image) : image,
        image_build_context: pathFrom({ directory, value: container.image_build_context }),
        instance_type: target.compute.containerProfile,
      },
    ];
  }
  config.r2_buckets = [{ binding: 'MEDIA', bucket_name: target.compute.mediaBucketName }];
  return config;
};

/** Write only derived, nonsecret configuration under the gitignored local state. */
export const writeRemoteConfig = (options: {
  target: ResolvedTarget;
  root?: string;
  kind?: 'web' | 'jobs';
}): string => {
  const config = renderRemoteConfig(options);
  const path = remoteConfigPath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
};
