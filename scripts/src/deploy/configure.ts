// scripts/src/deploy/configure.ts
//
// Write this project's Cloudflare configuration.
//
//   bun run deploy:configure                 # interactive: asks for names
//   bun run deploy:configure -- --dry-run    # show what would change
//
// A template cannot ship resource ids: they belong to whoever instantiates it.
// So the starting state is "nothing is provisioned", every tool reports that as
// an actionable error, and this command is the one place it becomes real.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeploymentEnvironment } from '@starter/schemas';
import { PROCESSOR_PROTOCOL_ID } from '@starter/schemas/jobs';
import { hasCloudflareCredential, REPO_ROOT } from '../cloudflare/wrangler.ts';
import { JOBS_PROFILES } from '../registry/app_registry.ts';
import {
  type DeploymentValues,
  LOCAL_DEPLOYMENT_FILE,
  type LocalDeploymentValues,
  localConfigProblem,
  readLocalValues,
  resolveDeploymentValues,
} from '../registry/deployment_values.ts';
import { CLIENT_DIR_RELATIVE } from '../shared/paths.ts';
import { CONTAINER_PROFILES } from './compatibility.ts';
import {
  DEPLOYABLE_ENVIRONMENTS,
  environmentIsolationProblem,
  resolveTarget,
  suggestOrigin,
} from './target.ts';

/**
 * The committed wrangler config, relative to a repository root.
 *
 * Relative rather than `CLIENT_DIR` because every reader of it also takes a
 * `root`. An absolute path joined onto a caller's `root` is the `root` discarded,
 * and the only test that would have noticed wrote its fixture UUID into the
 * committed file while reporting success.
 */
const WRANGLER_CONFIG = `${CLIENT_DIR_RELATIVE}/wrangler.jsonc`;

/** The same file, resolved against a caller-supplied root. */
const wranglerConfigAt = (root: string): string => join(root, WRANGLER_CONFIG);

export interface ConfigCheck {
  ok: boolean;
  problems: string[];
  notices: string[];
}

const stripJsonComments = (input: string): string =>
  input.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** What is still unconfigured. Read-only. Offline: no credential, no network. */
export const inspectConfig = (
  values: DeploymentValues = resolveDeploymentValues(),
): ConfigCheck => {
  const problems: string[] = [];
  const notices: string[] = [];

  const malformed = localConfigProblem();
  if (malformed !== null) {
    problems.push(malformed);
  }

  if (!hasCloudflareCredential()) {
    // Previously: "Set CLOUDFLARE_API_TOKEN, or run `wrangler login`." The second
    // half was advice that could not work: `hasCloudflareCredential` reads only
    // the environment variable, so a `wrangler login` left the tooling reporting
    // "no credential" while the operator believed they were authenticated.
    problems.push(
      'No Cloudflare credential. Set CLOUDFLARE_API_TOKEN. This tooling does not read ' +
        'the OAuth credentials `wrangler login` writes to a per-user directory.',
    );
  }

  if (values.accountId === null) {
    problems.push(
      'No Cloudflare account id configured.\n' +
        `  The Observability log endpoint is account-scoped, so it cannot be queried\n` +
        `  without one. Write it to ${LOCAL_DEPLOYMENT_FILE}, or export\n` +
        '  CLOUDFLARE_ACCOUNT_ID.',
    );
  }

  // Reported per environment through the same authority the deploy uses, so this
  // report and `bun run deploy:check --env <env>` can never disagree about what is
  // missing. Reporting the top-level single set instead would say "configured"
  // for a project whose environments are not — which is how provisioning appeared
  // to complete while every deploy still refused.
  const isolation = environmentIsolationProblem(values);
  if (isolation !== null) {
    problems.push(isolation);
  }

  for (const environment of DEPLOYABLE_ENVIRONMENTS) {
    const resolved = resolveTarget(environment, { values });
    if (!resolved.ok) {
      problems.push(`${environment}: ${resolved.reason}`);
    }
  }

  if (!existsSync(wranglerConfigAt(REPO_ROOT))) {
    problems.push(`wrangler.jsonc is missing at ${WRANGLER_CONFIG}.`);
  } else {
    const text = readFileSync(wranglerConfigAt(REPO_ROOT), 'utf8');
    try {
      JSON.parse(stripJsonComments(text));
    } catch (error) {
      problems.push(
        `wrangler.jsonc is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`,
      );
    }
  }

  if (values.customDomain === null) {
    notices.push(
      'No custom domain configured. Applications will be reachable at *.workers.dev only.',
    );
  }
  if (values.r2BucketNames.uploads === null) {
    notices.push(
      'No R2 upload bucket configured. That is fine: uploads are a documented future ' +
        'capability, nothing in the application reads a bucket, and this command cannot ' +
        'create one. See docs/deployment.md for what adding it would require.',
    );
  }

  return { ok: problems.length === 0, problems, notices };
};

/**
 * Merge new values into the gitignored local file, leaving other keys alone.
 *
 * Read-modify-write rather than overwrite, because the file also carries worker
 * names and the account id, and `--provision` for the database must not erase a
 * worker name someone already set.
 */
export const writeLocalValues = (
  update: (current: LocalDeploymentValues) => LocalDeploymentValues,
  root: string = REPO_ROOT,
): void => {
  const path = join(root, LOCAL_DEPLOYMENT_FILE);
  const problem = localConfigProblem(root);
  if (problem !== null) {
    throw new Error(problem);
  }
  const current = readLocalValues(root);
  const next = update(current);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
};

/**
 * Record the account id, and optionally the Worker name, without provisioning.
 *
 * Separate from `--provision` because the account id is needed by read-only paths
 * — the Observability log query above all — and requiring a database creation to
 * set it would make asking a question about yesterday's logs a mutating command.
 *
 * `--worker` takes **one** argument: the Worker's name.
 *
 *     bun run deploy:configure -- --worker starter-web
 *
 * The previous form took two — an app and a name — because there were two Workers
 * with two names to record. It also had a defect worth naming, because the same
 * argument shape will be reintroduced by anyone who assumes more than one target
 * exists: given a single argument, that form read the *target* as the name and
 * recorded the literal string `"api"`. The plan then printed `--name api`, which
 * wrangler accepts as a valid Worker name, so nothing failed until the deploy
 * published to the wrong place.
 *
 * One argument and no target removes that whole class of mistake: there is nothing
 * left to misread. `root` is a parameter so this is testable against a throwaway
 * directory. It was hardcoded to `REPO_ROOT`, which meant the one operation that
 * *writes* the local overlay had no test at all.
 */
/**
 * Record configuration without provisioning anything: the account id, a Worker
 * name, a public origin.
 *
 *     bun run deploy:configure -- --account <32-hex>
 *     bun run deploy:configure -- --env staging --worker starter-web-staging
 *     bun run deploy:configure -- --env staging --origin https://starter.example
 *
 * Every write is nonsecret by construction — an account id, a Worker name and a
 * public hostname are all configuration. Nothing here takes a secret, and that is
 * why these values live in a gitignored overlay rather than in SOPS: an encrypted
 * file whose only contents are public would make "is this configured?" a question
 * that requires a decryption key.
 *
 * `--worker` takes **one** argument: the Worker's name. The previous form took
 * two — an app and a name — because there were two Workers. Given a single
 * argument it read the *target* as the name and recorded the literal string
 * `"api"`, which wrangler accepts, so nothing failed until the deploy published to
 * the wrong place.
 *
 * `--env` is required for `--worker` and `--origin`. Without it they would land in
 * the single-set fallback, which is the value both environments used to read — the
 * exact ambiguity the per-environment layer removes.
 *
 * `root` is a parameter so this is testable against a throwaway directory. It was
 * hardcoded to `REPO_ROOT`, which meant the one operation that *writes* the local
 * overlay had no test at all.
 */
export const setConfig = (args: readonly string[], root: string = REPO_ROOT): number => {
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };

  const rawEnvironment = valueAfter('--env');

  if (rawEnvironment !== undefined && !DEPLOYABLE_ENVIRONMENTS.includes(rawEnvironment as never)) {
    process.stderr.write(
      `--env must be ${DEPLOYABLE_ENVIRONMENTS.join(' or ')} (got "${rawEnvironment}").\n` +
        '  Nothing has been changed. `local` is a runtime, not a deployment target.\n',
    );
    return 2;
  }

  const environment = rawEnvironment as DeploymentEnvironment | undefined;

  const account = valueAfter('--account');
  const workerName = valueAfter('--worker');
  const origin = valueAfter('--origin');
  const jobsWorkerName = valueAfter('--jobs-worker');
  const mediaBucketName = valueAfter('--media-bucket');
  const encodeWorkflowName = valueAfter('--encode-workflow');
  const maintenanceWorkflowName = valueAfter('--maintenance-workflow');
  const containerImage = valueAfter('--image');
  const imageProtocol = valueAfter('--image-protocol');
  const containerProfile = valueAfter('--container-profile');
  const jobsProfile = valueAfter('--jobs-profile');
  const mailFrom = valueAfter('--mail-from');
  const nativeApiOrigin = valueAfter('--native-api-origin');

  const computeFlags = [
    ['--jobs-worker', jobsWorkerName],
    ['--media-bucket', mediaBucketName],
    ['--encode-workflow', encodeWorkflowName],
    ['--maintenance-workflow', maintenanceWorkflowName],
    ['--image', containerImage],
    ['--image-protocol', imageProtocol],
    ['--container-profile', containerProfile],
    ['--jobs-profile', jobsProfile],
  ] as const;

  // Refuse an unknown flag rather than ignoring it.
  //
  // Silently ignoring `--jobs-workr` produced a run that reported success, changed
  // nothing, and left the operator believing the compute half was configured — the
  // exact "succeeds while doing nothing" this repository treats as its worst outcome.
  // A flag this command does not implement is a typo until proven otherwise.
  const KNOWN = new Set([
    '--env',
    '--account',
    '--worker',
    '--origin',
    '--mail-from',
    '--native-api-origin',
    ...computeFlags.map(([flag]) => flag),
  ]);
  const unknownFlag = args.find((arg) => arg.startsWith('--') && !KNOWN.has(arg));
  if (unknownFlag !== undefined) {
    process.stderr.write(
      `Unknown flag "${unknownFlag}". Nothing has been changed.\n` +
        `  This command writes: ${[...KNOWN].join(', ')}\n` +
        '  An unrecognised flag is ignored by most tools and silently changes nothing\n' +
        '  here; it is refused so a typo cannot read as a successful configuration.\n',
    );
    return 2;
  }

  const nothingToWrite =
    account === undefined &&
    workerName === undefined &&
    origin === undefined &&
    mailFrom === undefined &&
    nativeApiOrigin === undefined &&
    computeFlags.every(([, value]) => value === undefined);

  if (nothingToWrite) {
    process.stderr.write(
      'Nothing to write. Nonsecret configuration only; nothing here takes a secret.\n' +
        '  --account <32-hex>\n' +
        '  --env <env> --worker <name>          the web Worker\n' +
        '  --env <env> --origin https://<host>  the public origin\n' +
        '  --env <env> --mail-from <address>   the verified sender\n' +
        '  --env <env> --native-api-origin https://<host>\n' +
        '  --env <env> --jobs-worker <name> --media-bucket <name>\n' +
        '  --env <env> --encode-workflow <name> --maintenance-workflow <name>\n' +
        '  --env <env> --image <path-or-reference> --image-protocol <id>\n' +
        '  --env <env> --container-profile <name> --jobs-profile disabled|encode\n',
    );
    return 2;
  }

  if (workerName?.startsWith('-') === true) {
    process.stderr.write(
      "--worker takes the Worker's name: --worker <name>\n" +
        '  Nothing has been changed. A Worker name is a single value, and accepting a\n' +
        '  target as well is how the previous two-argument form recorded "api" as a name.\n',
    );
    return 2;
  }

  if (workerName !== undefined && environment === undefined) {
    process.stderr.write(
      '--worker needs --env. Nothing has been changed.\n' +
        '  Staging and production are different Workers; a name written without an\n' +
        '  environment is the shared value both of them used to read.\n',
    );
    return 2;
  }

  if (origin !== undefined && environment === undefined) {
    process.stderr.write(
      '--origin needs --env. Nothing has been changed.\n' +
        '  An origin is per environment: staging and production answer on different\n' +
        '  hostnames, and one shared value means both are verified against the same\n' +
        '  address.\n',
    );
    return 2;
  }

  // Each compute flag is environment-scoped, for the same reason `--worker` is: a
  // shared value across staging and production is a shared resource, and refusing
  // here is cheaper than discovering it during a migration.
  for (const [flag, value] of computeFlags) {
    if (value !== undefined && environment === undefined) {
      process.stderr.write(
        `${flag} needs --env. Nothing has been changed.\n` +
          '  A jobs Worker, a bucket, a profile and an image protocol are per\n' +
          "  environment: staging's maintenance sweep deleting production's output is the\n" +
          '  failure this separation exists to prevent.\n',
      );
      return 2;
    }
  }

  if (jobsProfile !== undefined && !(JOBS_PROFILES as readonly string[]).includes(jobsProfile)) {
    process.stderr.write(
      `--jobs-profile must be one of: ${JOBS_PROFILES.join(', ')} (got "${jobsProfile}").\n` +
        '  "disabled" is a real refusal that leaves notes and auth working; "encode"\n' +
        '  admits jobs and therefore needs an image and a bucket.\n' +
        '  Nothing has been changed.\n',
    );
    return 2;
  }

  if (
    containerProfile !== undefined &&
    !(CONTAINER_PROFILES as readonly string[]).includes(containerProfile)
  ) {
    process.stderr.write(
      `--container-profile must be a profile the platform offers: ${CONTAINER_PROFILES.join(', ')}\n` +
        `  (got "${containerProfile}"). apps/backend/media/README.md records the measurements\n` +
        '  behind "basic". Nothing has been changed.\n',
    );
    return 2;
  }

  if (imageProtocol !== undefined && imageProtocol !== PROCESSOR_PROTOCOL_ID) {
    // Not pedantry: a protocol this source does not implement is an image that
    // rejects every encode at the container boundary, discovered as a failed job.
    process.stderr.write(
      `--image-protocol must be "${PROCESSOR_PROTOCOL_ID}", which is what this source speaks\n` +
        `  (got "${imageProtocol}"). Changing the processor protocol is a source change with a\n` +
        '  golden fixture, not a configuration value. Nothing has been changed.\n',
    );
    return 2;
  }

  // Workflow identities follow the Worker-name shape Cloudflare accepts, because an
  // unaccepted one fails at deploy time with an error naming neither the plan nor the
  // cause. Same rule and same reason as `workerName`, which is why it lives here and
  // not in the resolver.
  const WORKFLOW_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
  for (const [flag, value] of [
    ['--encode-workflow', encodeWorkflowName],
    ['--maintenance-workflow', maintenanceWorkflowName],
  ] as const) {
    if (value !== undefined && !WORKFLOW_NAME.test(value)) {
      process.stderr.write(
        `"${value}" is not a valid Workflow name for ${flag}.\n` +
          '  Lowercase letters, digits and dashes; must start with a letter or digit.\n' +
          '  Nothing has been changed.\n',
      );
      return 2;
    }
  }

  if (containerImage !== undefined && containerImage.trim() === '') {
    process.stderr.write(
      '--image takes a Dockerfile path or a pinned reference, not an empty string.\n' +
        '  Nothing has been changed. Omit the flag to leave it unconfigured.\n',
    );
    return 2;
  }

  if (
    mediaBucketName !== undefined &&
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(mediaBucketName)
  ) {
    process.stderr.write(
      `"${mediaBucketName}" is not a valid R2 bucket name.\n` +
        '  Lowercase letters, digits, dots and dashes; 3 to 63 characters.\n' +
        '  Nothing has been changed.\n',
    );
    return 2;
  }

  if (mailFrom !== undefined && !/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(mailFrom)) {
    process.stderr.write(
      `--mail-from must be an email address (got "${mailFrom}").\n` +
        '  It must be on a domain your mail provider has verified, or delivery fails in\n' +
        '  a way that reads as a deployment problem. Nothing has been changed.\n',
    );
    return 2;
  }

  if (nativeApiOrigin !== undefined && !/^https:\/\/[^/?#]+$/.test(nativeApiOrigin)) {
    process.stderr.write(
      `--native-api-origin must be an absolute https URL with no path (got "${nativeApiOrigin}").\n` +
        '  It is compiled into a packaged binary and cannot be corrected after signing.\n' +
        '  Nothing has been changed.\n',
    );
    return 2;
  }

  if (account !== undefined && !/^[0-9a-f]{32}$/i.test(account)) {
    process.stderr.write(
      '--account needs a 32-character hex Cloudflare account id.\n' +
        '  Find it at https://dash.cloudflare.com → Workers & Pages → Account ID.\n' +
        '  Nothing has been changed.\n',
    );
    return 2;
  }

  if (origin !== undefined && !/^https:\/\/[^/?#]+$/.test(origin)) {
    process.stderr.write(
      `--origin "${origin}" is not an absolute https URL with no path, query or fragment.\n` +
        '  Nothing has been changed. It is the base URL Supabase Auth issues cookies for\n' +
        '  and the address verification fetches.\n',
    );
    return 2;
  }

  writeLocalValues((current) => {
    const environments = { ...(current.environments ?? {}) };
    if (environment !== undefined) {
      const entry: Record<string, string | null> = { ...(environments[environment] ?? {}) };
      const assign = (field: string, value: string | undefined): void => {
        if (value !== undefined) {
          entry[field] = value;
        }
      };
      assign('workerName', workerName);
      assign('origin', origin);
      assign('mailFrom', mailFrom);
      assign('nativeApiOrigin', nativeApiOrigin);
      assign('jobsWorkerName', jobsWorkerName);
      assign('mediaBucketName', mediaBucketName);
      assign('encodeWorkflowName', encodeWorkflowName);
      assign('maintenanceWorkflowName', maintenanceWorkflowName);
      assign('containerImage', containerImage);
      assign('imageProtocol', imageProtocol);
      assign('containerProfile', containerProfile);
      assign('jobsProfile', jobsProfile);
      environments[environment] = entry;
    }
    return {
      ...current,
      ...(account === undefined ? {} : { accountId: account.toLowerCase() }),
      ...(environment === undefined ? {} : { environments }),
    };
  }, root);

  const written: [string, string | undefined][] = [
    ['Worker name', workerName],
    ['Origin', origin],
    ['Mail from', mailFrom],
    ['Native API origin', nativeApiOrigin],
    ['Jobs Worker', jobsWorkerName],
    ['Media bucket', mediaBucketName],
    ['Encode workflow', encodeWorkflowName],
    ['Maintenance workflow', maintenanceWorkflowName],
    ['Image', containerImage],
    ['Image protocol', imageProtocol],
    ['Container profile', containerProfile],
    ['Jobs profile', jobsProfile],
  ];
  for (const [label, value] of written) {
    if (value !== undefined) {
      process.stdout.write(`${label} for ${environment}: ${value}\n`);
    }
  }

  if (account !== undefined) {
    process.stdout.write(`Account id written to ${LOCAL_DEPLOYMENT_FILE}.\n`);
  }
  if (workerName !== undefined && origin === undefined && environment !== undefined) {
    process.stdout.write(
      `\nStill needed for ${environment}:\n` +
        `  bun run deploy:configure -- --env ${environment} --origin ${suggestOrigin(workerName)}\n` +
        '  Replace the placeholder with the real workers.dev subdomain, or a custom domain.\n',
    );
  }

  return 0;
};

export const main = (args: readonly string[]): number => {
  if (args.includes('--provision')) {
    process.stderr.write(
      'The Postgres provisioning option was removed. Use `bun run deploy:provision` for configured Cloudflare resources.\n',
    );
    return 2;
  }

  if (args.includes('--check') || args.includes('--dry-run')) {
    const check = inspectConfig();
    process.stdout.write(`Cloudflare configuration: ${check.ok ? 'complete' : 'incomplete'}\n`);
    for (const problem of check.problems) {
      process.stdout.write(`  problem: ${problem}\n`);
    }
    for (const notice of check.notices) {
      process.stdout.write(`  notice:  ${notice}\n`);
    }
    return check.ok ? 0 : 1;
  }

  const WRITE_FLAGS = [
    '--account',
    '--worker',
    '--origin',
    '--mail-from',
    '--native-api-origin',
    '--jobs-worker',
    '--media-bucket',
    '--encode-workflow',
    '--maintenance-workflow',
    '--image',
    '--image-protocol',
    '--container-profile',
    '--jobs-profile',
  ];
  if (WRITE_FLAGS.some((flag) => args.includes(flag))) {
    return setConfig(args, REPO_ROOT);
  }

  const check = inspectConfig();
  process.stdout.write('Cloudflare configuration\n\n');
  for (const problem of check.problems) {
    process.stdout.write(`  problem: ${problem}\n`);
  }
  for (const notice of check.notices) {
    process.stdout.write(`  notice:  ${notice}\n`);
  }
  process.stdout.write(
    '\nNext steps, per environment:\n' +
      '  bun run deploy:configure -- --account <32-hex>\n' +
      '  bun run deploy:configure -- --env staging --worker <name>\n' +
      '  bun run deploy:configure -- --env staging --origin https://<host>\n' +
      '  bun run deploy:configure -- --check                # verify\n' +
      '  bun run deploy:check --env staging                # the offline plan\n',
  );
  return 0;
};

export type { DeploymentEnvironment };
export { WRANGLER_CONFIG };
