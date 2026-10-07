import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  runnerSubject?: string;
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
  if (target.deploymentProfile === 'supabase' && !/^\d{8,32}$/.test(options.runnerSubject ?? '')) {
    throw new Error(
      'Supabase Worker configuration needs the runner service-account uniqueId from authenticated provider discovery.',
    );
  }
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
    ...(target.deploymentProfile === 'supabase' && target.supabase !== null
      ? {
          STARTER_BACKEND_PROFILE: 'supabase',
          SUPABASE_URL: target.supabase.url,
          SUPABASE_ANON_KEY: target.supabase.publishableKey,
          SUPABASE_MAIL_URL: target.supabase.url,
          GOOGLE_RUNNER_SERVICE_ACCOUNT: target.supabase.runnerServiceAccount,
          GOOGLE_RUNNER_SUBJECT: options.runnerSubject,
          GOOGLE_RUNNER_AUDIENCE: target.origin,
          ...(kind === 'jobs'
            ? {
                GOOGLE_CLOUD_PROJECT: target.supabase.googleProjectId,
                GOOGLE_CLOUD_REGION: target.supabase.googleRegion,
                GOOGLE_CLOUD_RUN_JOB: target.supabase.jobName,
                COMPUTE_PROTOCOL: target.supabase.protocol,
              }
            : {}),
        }
      : {}),
  };
  config.d1_databases =
    target.deploymentProfile === 'supabase'
      ? undefined
      : [
          {
            binding: 'DB',
            database_name: `${target.project}-${target.environment}-db`,
            database_id: target.d1DatabaseId,
            migrations_dir: join(root, 'packages/backend/database/drizzle-d1'),
          },
        ];
  if (kind === 'web') {
    // Build closes the adapter's SSR graph. Upload those hashed bytes unchanged.
    config.no_bundle = true;
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
    if (target.deploymentProfile === 'supabase') {
      config.containers = undefined;
      config.durable_objects = undefined;
      config.migrations = undefined;
    } else if (!Array.isArray(config.containers) || config.containers.length !== 1) {
      throw new Error('Jobs configuration must describe exactly one processor container.');
    }
    if (target.deploymentProfile === 'legacy') {
      const container = object((config.containers as unknown[])[0]);
      const image = target.compute.containerImage;
      if (image === null) {
        throw new Error('No processor image was resolved.');
      }
      // A local build input is a path; a registry reference is not. Deciding by
      // spelling — "absolute, or a filename that happens to contain `Dockerfile`" —
      // left every other relative build input unresolved, so the generated config
      // named a path relative to whatever directory wrangler happened to run in.
      // Existence is the discriminator, and a reference like `ghcr.io/org/img:tag`
      // cannot exist as a relative file next to the source config.
      const local = resolve(directory, image);
      config.containers = [
        {
          ...container,
          image: isAbsolute(image) || existsSync(local) ? local : image,
          image_build_context: pathFrom({ directory, value: container.image_build_context }),
          instance_type: target.compute.containerProfile,
        },
      ];
    }
  }
  config.r2_buckets = [{ binding: 'MEDIA', bucket_name: target.compute.mediaBucketName }];
  return config;
};

/** Write only derived, nonsecret configuration under the gitignored local state. */
export const writeRemoteConfig = (options: {
  target: ResolvedTarget;
  root?: string;
  kind?: 'web' | 'jobs';
  runnerSubject?: string;
}): string => {
  const config = renderRemoteConfig(options);
  const path = remoteConfigPath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
};
