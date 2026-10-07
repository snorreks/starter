// scripts/src/deploy/target.ts
//
// The one authority for "what would this command actually change".
//
// Everything that can reach a remote resource — the plan, the preflight, the
// migrate command, the deploy, the verify, the release record — resolves its
// destination through `resolveTarget` here, and nothing else. That is the whole
// design: a command that answered a different question from the plan the
// operator approved is the failure this module exists to make impossible.
//
// It is deliberately *offline*. It reads configuration and refuses; it never
// spawns a process, never contacts Cloudflare and never decrypts anything. The
// distinction matters because `plan` has to be answerable on a laptop with no
// credential at all, and because a "plan" that quietly authenticated is not a
// plan a reviewer can trust.
//
// Four refusals, each for a way this has previously gone wrong:
//
//   1. **An unknown environment.** `--env prod` is a typo, not a synonym.
//   2. **A missing value.** `null` means "not provisioned". Every deployment
//      resource id in this repository starts `null` on purpose — a template that
//      ships ids points every new user at one account.
//   3. **Two environments sharing a resource.** Staging and production are
//      separate Workers and separate databases. One name or one database id in
//      both is the configuration that a test run quietly promotes to live traffic,
//      and it is refused here, before any mutation, rather than caught afterwards.
//   4. **A non-https or non-absolute origin.** Verification is made against this
//      address; an origin that is not an absolute https URL is not an address.

import type { DeploymentEnvironment } from '@starter/schemas';
import {
  DEPLOYMENT_CONFIG,
  type EnvironmentTargets,
  JOBS_PROFILES,
  type JobsProfile,
  REQUIRED_REMOTE_SECRET_NAMES,
  REQUIRED_REMOTE_VAR_NAMES,
  SUPABASE_REMOTE_SECRET_NAMES,
} from '../registry/app_registry.ts';
import {
  configuredTopologyFor,
  type DeploymentValues,
  effectiveDeploymentValues,
  topologyFor,
} from '../registry/deployment_values.ts';
import { CLIENT_DIR_RELATIVE } from '../shared/paths.ts';
import { targetCompatibilityProblem } from './compatibility.ts';

/** The jobs Worker's config, relative to the repository root. */
export const JOBS_DIR_RELATIVE = 'apps/backend/jobs';

/** The environments this project can deploy to. `local` is a runtime, not a target. */
export const DEPLOYABLE_ENVIRONMENTS = ['staging', 'production'] as const;

/**
 * The narrow type a resolved target carries.
 *
 * Not `DeploymentEnvironment`, which also contains `local`. Keeping the two apart
 * is what stops a `local` value reaching `ResolvedTarget` through a cast that
 * compiled: the whole point of the `local` refusal is that it is not a target.
 */
export type TargetEnvironment = (typeof DEPLOYABLE_ENVIRONMENTS)[number];

export interface ResolvedTarget {
  deploymentProfile: 'legacy' | 'supabase';
  environment: TargetEnvironment;
  /** Project identity, from the committed registry. Never a secret. */
  project: string;
  accountId: string;
  workerName: string;
  d1DatabaseId: string;
  /** Absolute https origin verification is made against. */
  origin: string;
  /** Canonical Wrangler input. Bindings and generated types are read from this. */
  wranglerConfig: string;
  /** The jobs Worker's config. Same repository, a different resource. */
  jobsWranglerConfig: string;
  /**
   * The compute half, resolved.
   *
   * A nested object rather than a dozen nullable fields, because the interesting
   * state is "compute is off for this environment" and a flat shape expresses that
   * as thirteen nulls, which is indistinguishable from a half-configured compute
   * environment. `enabled` is the assertion; the fields are the evidence for it.
   */
  compute: {
    enabled: boolean;
    profile: JobsProfile;
    jobsWorkerName: string | null;
    mediaBucketName: string | null;
    encodeWorkflowName: string | null;
    maintenanceWorkflowName: string | null;
    containerImage: string | null;
    /** The protocol the deployed image is required to speak. */
    imageProtocol: string | null;
    /** The measured Cloudflare container profile. */
    containerProfile: string | null;
  };
  /** The verified sender address. Configuration, and required. */
  mailFrom: string;
  /** The https origin a packaged native build targets. Nullable: not every project ships one. */
  nativeApiOrigin: string | null;
  supabase: null | {
    projectRef: string;
    url: string;
    authUrl: string;
    publishableKey: string;
    nativeRedirectAllowlist: readonly string[];
    googleProjectId: string;
    googleRegion: string;
    jobName: string;
    image: string;
    runnerServiceAccount: string;
    dispatcherServiceAccount: string;
    protocol: string;
    cpu: string;
    memory: string;
    timeoutSeconds: number;
  };
  /** Secret *names* required, in documented apply order. Never values. */
  requiredSecretNames: readonly string[];
  /** Nonsecret var names required. Never values. */
  requiredVarNames: readonly string[];
}

export interface TargetFailure {
  ok: false;
  reason: string;
  remedy: string;
}
export type TargetResult = { ok: true; target: ResolvedTarget } | TargetFailure;

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

/**
 * A Worker name Cloudflare will actually accept.
 *
 * Checked here rather than left to wrangler because the failure mode of not
 * checking is not a rejected deploy: `wrangler deploy --name api` succeeds and
 * publishes to a Worker called `api`. A name that satisfies this pattern cannot
 * silently become a different resource.
 */
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const fail = (reason: string, remedy: string): TargetFailure => ({ ok: false, reason, remedy });

/**
 * An absolute `https://` origin with no path, query or fragment.
 *
 * Rejecting the extras is not pedantry: the origin is used both as the base URL
 * Better Auth issues cookies for and as the address verification fetches. A
 * trailing path would make `/api/health` resolve somewhere the operator did not
 * intend, and the mismatch would only show up as a confusing verification
 * failure after the deploy succeeded.
 */
const parseOrigin = (
  value: string,
): { ok: true; origin: string } | { ok: false; problem: string } => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, problem: `"${value}" is not an absolute URL` };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, problem: `"${value}" is not https` };
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return {
      ok: false,
      problem: `"${value}" has a path, query or fragment`,
    };
  }

  return { ok: true, origin: url.origin };
};

/**
 * The destinations an override may retarget, and what sharing one costs.
 *
 * The image is absent: a Dockerfile is a build input both environments may use, and
 * what runs differs by digest. `environmentIsolationProblem` compares digests
 * separately.
 */
const OVERRIDABLE_DESTINATIONS: ReadonlyArray<[keyof EnvironmentTargets, string, string]> = [
  ['workerName', 'Worker', 'A staging release would reach live traffic.'],
  [
    'jobsWorkerName',
    'jobs Worker',
    "Staging's maintenance sweep would operate on production jobs.",
  ],
  ['d1DatabaseId', 'D1 database', 'A staging migration would be a production migration.'],
  ['mediaBucketName', 'R2 bucket', "Staging's retention sweep would delete production's output."],
  [
    'encodeWorkflowName',
    'encode Workflow',
    'Both environments would share one instance namespace.',
  ],
  [
    'maintenanceWorkflowName',
    'maintenance Workflow',
    'One environment would consume the other maintenance run key.',
  ],
  ['supabaseProjectRef', 'Supabase project', 'A staging migration would change production data.'],
  [
    'googleProjectId',
    'Google Cloud project',
    'Staging provisioning would mutate production cloud resources.',
  ],
  ['cloudRunJobName', 'Cloud Run Job', 'The environments would execute in the same job.'],
  [
    'runnerServiceAccount',
    'Cloud Run runner identity',
    'One environment could mint grants for the other.',
  ],
  [
    'dispatcherServiceAccount',
    'Cloud Run dispatcher identity',
    'One environment could dispatch into the other.',
  ],
  ['origin', 'origin', "Staging would be verified against production's address, or the reverse."],
];

/**
 * Refuse two environments that would resolve to the same destination.
 *
 * The check is over the *configured* topology rather than the raw map, which is what
 * makes it catch the case that matters. A project with no `environments` map has one
 * set of names, so `--env staging` and `--env production` resolve to the same Worker
 * and the same database — and a production release would then be a staging release.
 * Comparing map entries alone cannot see that: there are no entries to compare.
 *
 * Refused here, before any mutation, and reported against the *resolved* values, so
 * the message names the resource that is actually shared rather than a key in a
 * file.
 *
 * It compares the *configured* topology, never the injected one. The injected
 * values (`CLOUDFLARE_WORKER_NAME` and friends) describe the single environment a
 * CI run is deploying; applying them to both environments and then comparing them
 * proves only that the variable was set — and reports "staging and production
 * share a Worker" on every run, including the ones with a correct configuration.
 * That is a plan that always refuses, which is not a safety property.
 *
 * Every resource that must be distinct is compared, not just the two that existed
 * when this was written. A shared bucket means staging's cleanup sweep deletes
 * production's job output; a shared Workflow identity means staging's recovery pass
 * and production's maintenance pass claim the same run key.
 */
export const environmentIsolationProblem = (
  values: DeploymentValues = effectiveDeploymentValues(),
): string | null => {
  interface Destinations {
    worker: string | null;
    jobsWorker: string | null;
    database: string | null;
    bucket: string | null;
    encodeWorkflow: string | null;
    maintenanceWorkflow: string | null;
    image: string | null;
    supabaseProject: string | null;
    googleProject: string | null;
    cloudRunJob: string | null;
    runner: string | null;
    dispatcher: string | null;
  }

  const resolved = new Map<string, Destinations>();

  for (const environment of DEPLOYABLE_ENVIRONMENTS) {
    const topology = configuredTopologyFor(environment, values);
    resolved.set(environment, {
      worker: topology?.workerName ?? null,
      jobsWorker: topology?.jobsWorkerName ?? null,
      database: topology?.d1DatabaseId ?? null,
      bucket: topology?.mediaBucketName ?? null,
      encodeWorkflow: topology?.encodeWorkflowName ?? null,
      maintenanceWorkflow: topology?.maintenanceWorkflowName ?? null,
      image: topology?.containerImage ?? null,
      supabaseProject: topology?.supabaseProjectRef ?? null,
      googleProject: topology?.googleProjectId ?? null,
      cloudRunJob: topology?.cloudRunJobName ?? null,
      runner: topology?.runnerServiceAccount ?? null,
      dispatcher: topology?.dispatcherServiceAccount ?? null,
    });
  }

  /**
   * Resources compared unconditionally.
   *
   * A Worker, a bucket, a database and a Workflow identity are one resource that
   * two environments cannot both own, whatever their profiles. (With compute off
   * in both, the compute fields are `null` and nothing matches anyway.)
   *
   * The *image* is deliberately excluded from that list: it is a build input, not
   * a per-environment resource. Both environments legitimately build from one
   * Dockerfile, and what actually runs differs by digest — which is recorded per
   * release. A digest is compared instead, and only a digest, below.
   */
  // Second pass, over the destinations this run will actually *use*.
  //
  // The pass above compares configuration, because the injected overrides are scoped
  // to one environment and applying one value to both would make every CI plan refuse.
  // That left a gap CodeRabbit correctly named: a staging override naming
  // production's Worker escapes the configuration comparison entirely, and the
  // mutation that follows deploys to production under a staging label.
  //
  // So the override is checked against the *other* environment's configured
  // destinations instead. That is the comparison that matters: an override is
  // allowed to differ from configuration — that is its purpose — but it is not
  // allowed to land on a resource another environment already owns.
  for (const environment of DEPLOYABLE_ENVIRONMENTS) {
    const own = configuredTopologyFor(environment, values);
    if (own === null) {
      continue;
    }
    const effective = topologyFor(environment, values);
    if (effective === null) {
      continue;
    }

    for (const other of DEPLOYABLE_ENVIRONMENTS) {
      if (other === environment) {
        continue;
      }
      const otherConfigured = configuredTopologyFor(other, values);
      if (otherConfigured === null) {
        continue;
      }

      for (const [field, label, consequence] of OVERRIDABLE_DESTINATIONS) {
        const mine = effective[field];
        const theirs = otherConfigured[field];
        if (mine === null || mine === undefined || mine !== theirs) {
          continue;
        }
        // Only report it when the override actually *introduced* the collision;
        // a collision already present in configuration is the first pass's business
        // and has a different remedy.
        if (own[field] === mine) {
          continue;
        }
        return (
          `The override for ${environment} resolves to the ${label} "${String(mine)}", which is ` +
          `${other}'s configured ${label}. ` +
          `${consequence}\n` +
          '  Overrides exist to target something configuration did not describe; they do not ' +
          'exist to reach another environment. Nothing has been changed.'
        );
      }
    }
  }

  const entries = [...resolved.entries()].filter(([, value]) =>
    Object.values(value).some((entry) => entry !== null),
  );

  for (const [environment, value] of entries) {
    for (const [other, otherValue] of entries) {
      if (environment >= other) {
        continue;
      }

      const shared = (
        field: keyof Destinations,
        label: string,
        consequence: string,
      ): string | null => {
        if (value[field] === null || value[field] !== otherValue[field]) {
          return null;
        }
        return (
          `${environment} and ${other} both resolve to the ${label} "${String(value[field])}". ` +
          consequence
        );
      };

      const problem =
        shared(
          'worker',
          'Worker',
          'A Worker is one resource per account, so the two environments are the same deployment.',
        ) ??
        shared(
          'jobsWorker',
          'jobs Worker',
          'A staging maintenance run would operate on production jobs.',
        ) ??
        shared('database', 'D1 database', 'A staging migration is then a production migration.') ??
        shared(
          'bucket',
          'R2 bucket',
          "Staging's retention sweep would delete production's job output.",
        ) ??
        shared(
          'encodeWorkflow',
          'encode Workflow',
          "Both environments' jobs would share one instance namespace.",
        ) ??
        shared(
          'maintenanceWorkflow',
          'maintenance Workflow',
          'One environment would consume the other maintenance run key.',
        ) ??
        shared(
          'supabaseProject',
          'Supabase project',
          'Both environments would migrate the same Postgres database.',
        ) ??
        shared(
          'googleProject',
          'Google Cloud project',
          'Both environments would provision the same cloud project.',
        ) ??
        shared('cloudRunJob', 'Cloud Run Job', 'Both environments would execute in one job.') ??
        shared(
          'runner',
          'Cloud Run runner identity',
          'The runner would cross environment boundaries.',
        ) ??
        shared(
          'dispatcher',
          'Cloud Run dispatcher identity',
          'The dispatcher would cross environment boundaries.',
        );

      if (problem !== null) {
        return problem;
      }

      // The image is compared only between two *enabled* environments, and only
      // when they name a digest rather than a build path.
      if (value.image !== null && value.image === otherValue.image && value.image.startsWith('@')) {
        return (
          `${environment} and ${other} both resolve to the pinned image digest "${value.image}". ` +
          'A digest is one built artifact, so a rollback in one environment would replace the ' +
          "other's image. Use a build path for both, and record the digest per release."
        );
      }
    }
  }

  return null;
};

/**
 * Resolve and fully validate the destination for one environment.
 *
 * Pure and offline. Every input is a parameter, so the whole authority is
 * reachable from a test without a repository, a credential or a network.
 */
export const resolveTarget = (
  environment: string,
  options: {
    values?: DeploymentValues;
    project?: string;
    requiredSecretNames?: readonly string[];
    profile?: 'legacy' | 'supabase';
  } = {},
): TargetResult => {
  const values = options.values ?? effectiveDeploymentValues();
  let profile = options.profile;
  if (profile === undefined) {
    const environmentProfile = process.env.STARTER_BACKEND_PROFILE;
    if (environmentProfile !== undefined && !['legacy', 'supabase'].includes(environmentProfile)) {
      return fail(
        'STARTER_BACKEND_PROFILE must be legacy or supabase.',
        'Select an explicit supported deployment profile.',
      );
    }
    profile = environmentProfile === 'supabase' ? 'supabase' : 'legacy';
  }

  // Refused before any other work, so an unknown word can never be resolved
  // against a default. `--env prod` must not reach the production entry it
  // resembles, and `--env local` must not reach anything at all: `local` is a
  // *runtime* (`bun run dev`), not a place a Worker can be deployed to.
  if (!(DEPLOYABLE_ENVIRONMENTS as readonly string[]).includes(environment)) {
    return fail(
      `"${environment}" is not a deployable environment.`,
      `Environments: ${DEPLOYABLE_ENVIRONMENTS.join(', ')}. ` +
        '`local` is a runtime (`bun run dev`), not a deployment target.',
    );
  }

  // A malformed CI map is refused before anything is inferred from it. Without this
  // the typo is read as "no value configured", and the remedy an operator is given
  // is for a problem they do not have.
  const configuredProblems: Record<string, string[]> = values.configurationProblems ?? {};
  const problems = [...(configuredProblems['*'] ?? []), ...(configuredProblems[environment] ?? [])];
  if (problems.length > 0) {
    return fail(
      `The deployment configuration for ${environment} is malformed:\n  ${problems.join('\n  ')}`,
      'Fix the value in the repository variable, then re-run the plan. Nothing has been changed.',
    );
  }

  const isolated = environmentIsolationProblem(values);
  if (isolated !== null) {
    return fail(
      isolated,
      'Give each environment its own Worker name and D1 database id. This is refused ' +
        'before anything is changed, because the alternative is a staging release ' +
        'reaching live traffic.\n' +
        '  bun run deploy:configure -- --env staging --worker <name>\n' +
        '  bun run deploy:configure -- --env production --worker <name>',
    );
  }

  const accountId = values.accountId;
  if (accountId === null) {
    return fail(
      'No Cloudflare account id is configured.',
      'bun run deploy:configure -- --account <32-hex>\n' +
        '  (recorded in the gitignored overlay; it is configuration, not a secret)',
    );
  }
  if (!ACCOUNT_ID.test(accountId)) {
    return fail(
      `"${accountId}" is not a 32-character hexadecimal Cloudflare account id.`,
      'Find it at https://dash.cloudflare.com → Workers & Pages → Account ID.',
    );
  }

  const topology = topologyFor(environment as DeploymentEnvironment, values);
  if (topology === null) {
    return fail(
      `This project has no topology for the "${environment}" environment.`,
      `Add an "environments.${environment}" entry to the deployment overlay, or remove ` +
        'the "environments" object entirely if the project genuinely has one environment. ' +
        'Refusing rather than defaulting: serving a staging request with production ' +
        'names is the worst outcome this layer exists to prevent.',
    );
  }

  const workerName = topology.workerName;
  if (workerName === null) {
    return fail(
      `No Worker name is configured for ${environment}.`,
      `bun run deploy:configure -- --env ${environment} --worker <name>`,
    );
  }
  if (!WORKER_NAME.test(workerName)) {
    return fail(
      `"${workerName}" is not a valid Cloudflare Worker name.`,
      'Lowercase letters, digits and dashes; must start with a letter or digit. A name ' +
        'wrangler rejects fails the deploy; one it *accepts* publishes to a Worker you ' +
        'did not intend, which is why it is checked here.',
    );
  }

  const rawOrigin = topology.origin;
  if (rawOrigin === null) {
    return fail(
      `No public origin is configured for ${environment}, so a deploy could not be verified.`,
      `bun run deploy:configure -- --env ${environment} --origin https://<host>`,
    );
  }
  const parsed = parseOrigin(rawOrigin);
  if (!parsed.ok) {
    return fail(
      `The configured origin for ${environment} ${parsed.problem}.`,
      'Use an absolute https origin with no path, query or fragment.',
    );
  }
  const jobsProfile = topology.jobsProfile;
  if (jobsProfile === null || !(JOBS_PROFILES as readonly string[]).includes(jobsProfile)) {
    return fail(
      `The jobs profile for ${environment} is not configured or invalid.`,
      `Set jobsProfile to one of ${JOBS_PROFILES.join(', ')}.`,
    );
  }

  if (profile === 'supabase') {
    const required = [
      'supabaseProjectRef',
      'supabaseUrl',
      'supabaseAuthUrl',
      'supabasePublishableKey',
      'nativeRedirectAllowlist',
      'googleProjectId',
      'googleRegion',
      'cloudRunJobName',
      'artifactImage',
      'runnerServiceAccount',
      'dispatcherServiceAccount',
      'processorProtocol',
      'processorCpu',
      'processorMemory',
      'processorTimeoutSeconds',
      'jobsWorkerName',
      'mediaBucketName',
      'encodeWorkflowName',
      'maintenanceWorkflowName',
      'containerProfile',
    ] as const;
    const missing = required.filter((field) => topology[field] === null || topology[field] === '');
    if (missing.length > 0) {
      return fail(
        `The Supabase deployment target for ${environment} is incomplete: ${missing.join(', ')}.`,
        'Configure these fields in the repository target map, then rerun the offline plan.',
      );
    }
    if (jobsProfile !== 'encode') {
      return fail(
        `Compute is disabled for the Supabase ${environment} target.`,
        'The preview requires Cloudflare Workflows and a Cloud Run Job; configure jobsProfile as "encode".',
      );
    }
    const apiUrl = topology.supabaseUrl as string;
    const authUrl = topology.supabaseAuthUrl as string;
    if (apiUrl !== authUrl || topology.nativeApiOrigin !== parsed.origin) {
      return fail(
        'Supabase Auth and API origins, or the native API origin, do not match the configured destinations.',
        'Set supabaseAuthUrl to supabaseUrl and nativeApiOrigin to the Cloudflare Worker origin.',
      );
    }
    const apiOrigin = parseOrigin(apiUrl);
    const authOrigin = parseOrigin(authUrl);
    if (!apiOrigin.ok || !authOrigin.ok) {
      return fail(
        'Supabase API and Auth URLs must be absolute HTTPS origins without paths.',
        'Set the hosted project HTTPS origins from the same Supabase project.',
      );
    }
    const callbacks = (topology.nativeRedirectAllowlist as string)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const callbackPattern =
      /^(https:\/\/[^/?#]+\/auth\/callback|[a-z][a-z0-9+.-]*:\/\/auth\/callback)$/i;
    if (
      callbacks.length < 2 ||
      callbacks.some((callback) => !callbackPattern.test(callback)) ||
      !callbacks.includes(`${parsed.origin}/auth/callback`)
    ) {
      return fail(
        'The native redirect allowlist must contain exact web and native /auth/callback URIs, including the Worker callback.',
        'Set nativeRedirectAllowlist to a comma-delimited list of exact callback URIs.',
      );
    }
    if (topology.processorProtocol !== 'sample-v1') {
      return fail(
        'The Cloud Run image protocol does not match the integrated processor (sample-v1).',
        'Set processorProtocol to sample-v1.',
      );
    }
    if (!(topology.artifactImage as string).includes('@sha256:')) {
      return fail(
        'The Cloud Run image must be pinned by digest.',
        'Set artifactImage to an Artifact Registry URI ending in @sha256:<digest>.',
      );
    }
    if (topology.runnerServiceAccount === topology.dispatcherServiceAccount) {
      return fail(
        'Cloud Run runner and dispatcher identities must be distinct.',
        'Configure separate least-privilege service accounts.',
      );
    }
    const projectId = topology.googleProjectId as string;
    const region = topology.googleRegion as string;
    const accountSuffix = `@${projectId}.iam.gserviceaccount.com`;
    if (
      ![topology.runnerServiceAccount, topology.dispatcherServiceAccount].every(
        (identity) =>
          typeof identity === 'string' &&
          /^[a-z][a-z0-9-]*$/.test(identity.slice(0, identity.indexOf('@'))) &&
          identity.endsWith(accountSuffix),
      )
    ) {
      return fail(
        'Cloud Run runner and dispatcher identities must belong to the configured Google project.',
        'Set both service account emails to identities in googleProjectId.',
      );
    }
    const imageUri = topology.artifactImage as string;
    if (!imageUri.startsWith(`${region}-docker.pkg.dev/${projectId}/`)) {
      return fail(
        'The Artifact Registry image does not belong to the configured Google project and region.',
        'Set artifactImage to an immutable image in the configured project and region.',
      );
    }
    if (
      !['1', '2', '4', '8'].includes(topology.processorCpu as string) ||
      !['1Gi', '2Gi', '4Gi', '8Gi'].includes(topology.processorMemory as string)
    ) {
      return fail(
        'Cloud Run resource limits are outside the supported bounded profile.',
        'Use processorCpu 1, 2, 4 or 8 and processorMemory 1Gi, 2Gi, 4Gi or 8Gi.',
      );
    }
    if (!/^[a-z][a-z0-9-]{0,48}[a-z0-9]$/.test(topology.cloudRunJobName as string)) {
      return fail('Cloud Run Job name is malformed.', 'Use a lowercase Cloud Run resource name.');
    }
    const timeoutSeconds = Number(topology.processorTimeoutSeconds);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 900) {
      return fail(
        'processorTimeoutSeconds must be an integer from 60 through 900.',
        'Set a timeout within the processor bound.',
      );
    }
    if (!/^[a-z0-9-]{20}$/.test(topology.supabaseProjectRef as string)) {
      return fail(
        'Supabase project ref must be a 20-character project identity.',
        'Copy the exact project ref from Supabase settings.',
      );
    }
    if (!apiUrl.startsWith('https://') || !authUrl.startsWith('https://')) {
      return fail(
        'Supabase API and Auth URLs must use HTTPS.',
        'Set the hosted project HTTPS URLs.',
      );
    }
    if (topology.mailFrom === null || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(topology.mailFrom)) {
      return fail(
        'A valid verified mail sender is required for the Supabase target.',
        'Set mailFrom to the verified sender address.',
      );
    }
    const supabase: NonNullable<ResolvedTarget['supabase']> = {
      projectRef: topology.supabaseProjectRef as string,
      url: apiUrl,
      authUrl,
      publishableKey: topology.supabasePublishableKey as string,
      nativeRedirectAllowlist: callbacks,
      googleProjectId: topology.googleProjectId as string,
      googleRegion: topology.googleRegion as string,
      jobName: topology.cloudRunJobName as string,
      image: topology.artifactImage as string,
      runnerServiceAccount: topology.runnerServiceAccount as string,
      dispatcherServiceAccount: topology.dispatcherServiceAccount as string,
      protocol: topology.processorProtocol as string,
      cpu: topology.processorCpu as string,
      memory: topology.processorMemory as string,
      timeoutSeconds,
    };
    const target: ResolvedTarget = {
      deploymentProfile: 'supabase',
      environment: environment as TargetEnvironment,
      project: options.project ?? DEPLOYMENT_CONFIG.projectName,
      accountId: accountId.toLowerCase(),
      workerName,
      d1DatabaseId: '',
      origin: parsed.origin,
      wranglerConfig: `${CLIENT_DIR_RELATIVE}/wrangler.jsonc`,
      jobsWranglerConfig: `${JOBS_DIR_RELATIVE}/wrangler.jsonc`,
      compute: {
        enabled: true,
        profile: 'encode',
        jobsWorkerName: topology.jobsWorkerName,
        mediaBucketName: topology.mediaBucketName,
        encodeWorkflowName: topology.encodeWorkflowName,
        maintenanceWorkflowName: topology.maintenanceWorkflowName,
        containerImage: supabase.image,
        imageProtocol: supabase.protocol,
        containerProfile: topology.containerProfile,
      },
      mailFrom: topology.mailFrom,
      nativeApiOrigin: topology.nativeApiOrigin,
      supabase,
      requiredSecretNames: options.requiredSecretNames ?? SUPABASE_REMOTE_SECRET_NAMES,
      requiredVarNames: REQUIRED_REMOTE_VAR_NAMES,
    };
    const incoherent = targetCompatibilityProblem(target);
    if (incoherent !== null) {
      return fail(incoherent.reason, incoherent.remedy);
    }
    return { ok: true, target };
  }

  const databaseId = topology.d1DatabaseId;
  if (databaseId === null) {
    return fail(
      `No D1 database id is configured for ${environment}.`,
      `bun run deploy:configure -- --env ${environment} --provision`,
    );
  }

  const computeEnabled = jobsProfile === 'encode';

  const resolvedTarget: ResolvedTarget = {
    deploymentProfile: 'legacy',
    environment: environment as TargetEnvironment,
    project: options.project ?? DEPLOYMENT_CONFIG.projectName,
    accountId: accountId.toLowerCase(),
    workerName,
    d1DatabaseId: databaseId,
    origin: parsed.origin,
    wranglerConfig: `${CLIENT_DIR_RELATIVE}/wrangler.jsonc`,
    jobsWranglerConfig: `${JOBS_DIR_RELATIVE}/wrangler.jsonc`,
    compute: {
      enabled: computeEnabled,
      profile: jobsProfile as JobsProfile,
      jobsWorkerName: topology.jobsWorkerName,
      mediaBucketName: topology.mediaBucketName,
      encodeWorkflowName: topology.encodeWorkflowName,
      maintenanceWorkflowName: topology.maintenanceWorkflowName,
      containerImage: topology.containerImage,
      imageProtocol: topology.imageProtocol,
      containerProfile: topology.containerProfile,
    },
    mailFrom: topology.mailFrom ?? '',
    nativeApiOrigin: topology.nativeApiOrigin,
    supabase: null,
    requiredSecretNames: options.requiredSecretNames ?? REQUIRED_REMOTE_SECRET_NAMES,
    requiredVarNames: REQUIRED_REMOTE_VAR_NAMES,
  };

  // The target's own coherence, checked after the individual fields so the
  // complaint names the resource that is missing rather than a later symptom.
  // `targetCompatibilityProblem` imports this module's type only, so this is not
  // a runtime cycle.
  const incoherent = targetCompatibilityProblem(resolvedTarget);
  if (incoherent !== null) {
    return fail(incoherent.reason, incoherent.remedy);
  }

  return {
    ok: true,
    target: resolvedTarget,
  };
};

/**
 * The origin a fresh project would serve on, for display only.
 *
 * Never used as a value: it is a guess, and `resolveTarget` refuses to plan
 * against a guess. It exists so `deploy:configure` can print the shape of what
 * the operator is about to type.
 */
export const suggestOrigin = (workerName: string): string =>
  `https://${workerName}.<account-subdomain>.workers.dev`;
