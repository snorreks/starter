// scripts/src/deploy/preflight.ts
//
// The authenticated half of a deployment: "is the account the one I think it is,
// and are the resources I am about to touch the ones I named?"
//
// Separated from the offline plan for one reason: the plan must be answerable with
// no credential, no network and no side effects, so it can be reviewed and run in
// CI on a fork. Everything that *needs* an identity lives here instead.
//
// Every check in this file is read-only. None of them creates, migrates, deploys
// or decrypts. `wrangler whoami` and `wrangler d1 info` answer questions; that is
// the entire contract, and it is what makes it safe to run before every apply.
//
// The three failures it exists to catch are the ones that are otherwise only
// visible *after* a mutation:
//
//   * **Wrong account.** A token for account B, a configured account id for A.
//     Wrangler would happily act on B; the plan said A. Everything after that
//     succeeds and the data lands somewhere nobody was looking.
//   * **Wrong or missing resource.** The D1 id is stale, was deleted, or belongs
//     to another account.
//   * **Wrong Worker.** The name is configured but no such Worker exists in this
//     account, which is the normal state for a first staging deploy and a
//     surprising one for production.
//
// `preflight` returns findings rather than throwing, and `main` maps them to an
// exit code, so a caller can distinguish "refused" from "the check could not run".

import { captureWrangler } from '../cloudflare/wrangler.ts';
import { describeCredential } from './credentials.ts';
import { googleResourcePlan, inspectGoogleResources } from './providers/google.ts';
import {
  inspectSupabaseAuthConfig,
  runSupabaseMigration,
  supabaseMigrationArgs,
} from './providers/supabase.ts';
import { bucketExists } from './provision.ts';
import type { ResolvedTarget } from './target.ts';

type PreflightFindingBody =
  | { check: 'credential'; ok: false; detail: string; remedy: string }
  | { check: 'account'; ok: false; detail: string; remedy: string }
  | { check: 'database'; ok: false; detail: string; remedy: string }
  | { check: 'worker'; ok: false; detail: string; remedy: string }
  | { check: 'worker'; ok: true; detail: string }
  | {
      check: 'bucket' | 'secrets' | 'jobs secrets';
      ok: boolean;
      detail: string;
      remedy?: string;
      warn?: boolean;
    }
  | { check: 'container'; ok: false; detail: string; remedy: string }
  | { check: 'container'; ok: true; detail: string }
  | {
      check: 'jobs secrets' | 'cloud-run' | 'supabase' | 'google' | 'callbacks' | 'target';
      ok: boolean;
      detail: string;
      remedy?: string;
    }
  | { check: 'mail'; ok: false; detail: string; remedy: string }
  | { check: 'mail'; ok: true; detail: string };

/**
 * One check's answer, with the qualifier that a passed check may still be partial.
 */
export type PreflightFinding = PreflightFindingBody & {
  /**
   * Passed, but the check could not establish the whole claim.
   *
   * Distinct from `ok`, and rendered distinctly. "No deployed version carries a
   * container binding, so the entitlement is unproven" is not the same answer as
   * "the entitlement is fine", and a preflight that renders both as `ok` is a
   * report nobody can read under pressure.
   */
  warn?: boolean;
};

export interface PreflightReport {
  ok: boolean;
  findings: PreflightFinding[];
  /**
   * The argv each check *would* run, for a report a reviewer can check without a
   * credential. Recorded rather than executed when `dryRun` is set.
   */
  commands: string[][];
}

/**
 * The read-only commands a preflight runs.
 *
 * Exported so the workflow, the docs and the tests all name the same argv, and so
 * a future edit that makes one of these mutating fails a test rather than
 * silently turning a check into an action.
 */
export const preflightCommands = (target: ResolvedTarget): { check: string; args: string[] }[] => {
  const commands: { check: string; args: string[] }[] = [
    { check: 'account', args: ['whoami'] },
    ...(target.deploymentProfile === 'legacy'
      ? [{ check: 'database', args: ['d1', 'info', target.d1DatabaseId, '--json'] }]
      : [{ check: 'supabase migrations', args: supabaseMigrationArgs(target, 'list') }]),
    { check: 'worker', args: ['deployments', 'list', '--name', target.workerName, '--json'] },
    // Names only, never values: `wrangler secret list` reports what is installed
    // and nothing else. That is the property that makes this check safe to run
    // before every apply and safe to paste into a ticket.
    //
    // The same call the check makes, not a second hand-written copy of it: this list
    // is what a report shows an operator as "the commands that were run", and a copy
    // that drifted is a report that describes something else.
    { check: 'secrets', args: secretListArgv(target.workerName, target.environment) },
  ];

  if (target.deploymentProfile === 'supabase' && target.compute.jobsWorkerName !== null) {
    commands.push({
      check: 'jobs secrets',
      args: secretListArgv(target.compute.jobsWorkerName, target.environment),
    });
  }

  if (target.compute.enabled && target.compute.mediaBucketName !== null) {
    commands.push({ check: 'bucket', args: ['r2', 'bucket', 'list', '--json'] });
    if (target.deploymentProfile === 'legacy') {
      commands.push({
        check: 'container',
        args: ['deployments', 'list', '--name', target.compute.jobsWorkerName ?? '', '--json'],
      });
    }
  }

  return commands;
};

/**
 * The secret names `wrangler secret list --json` reports as installed.
 *
 * Parsed as JSON with a substring fallback, because the field has been spelled both
 * ways across Wrangler versions and a check that silently reads nothing would
 * report every environment as missing its secrets — which is a false alarm that
 * trains people to ignore this line.
 */
/**
 * The array a Wrangler `--json` result carries.
 *
 * Wrangler answers either a bare array or `{ result: [...] }` depending on the
 * subcommand, and both spellings are in active use across the commands this
 * repository makes. Written out rather than chained because a nested ternary
 * expressing "which of two shapes did we get" is exactly the shape a reader has to
 * stop and parse.
 */
const arrayFromWrangler = (parsed: unknown): unknown[] => {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const result = (parsed as { result?: unknown }).result;
    if (Array.isArray(result)) {
      return result;
    }
  }
  return [];
};

/**
 * The argv that reads installed secret NAMES for a Worker.
 *
 * Exported so a test can hold every flag against the pinned CLI's own help output.
 * That test is the only thing that catches a flag this repository made up: the
 * behavioural tests inject a fake `run`, so they pass against an argv that no
 * version of wrangler would accept.
 */
export const secretListArgv = (workerName: string, _environment: string): string[] => [
  'secret',
  'list',
  '--name',
  workerName,
  // Legacy secret commands append --env to --name. The validated target already
  // includes its environment identity; suffixing again queries a different Worker.
  '--format',
  'json',
];

export const installedSecretNames = (stdout: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const list = arrayFromWrangler(parsed);

    const names = list
      .map((entry) =>
        typeof entry === 'object' && entry !== null
          ? (entry as { name?: unknown }).name
          : undefined,
      )
      .filter((name): name is string => typeof name === 'string');

    if (names.length > 0) {
      return names;
    }
  } catch {
    // Fall through to the textual form below rather than reporting "none", which
    // is indistinguishable from a real empty list.
  }

  return [...stdout.matchAll(/"name"\s*:\s*"([A-Z0-9_]+)"/g)].map((match) => match[1] as string);
};

/**
 * Whether a deployed jobs Worker version carries a container binding.
 *
 * This is the only container-entitlement signal available read-only through
 * Wrangler: there is no "list my entitlements" call it exposes, but a version that
 * was accepted *with* a container binding cannot exist on an account without the
 * entitlement — the upload would have been rejected. So absence of such a version is
 * reported as "not proven", never as "not entitled": those are different claims and
 * only the second one would stop somebody who has the plan.
 */
export const containerEntitlementProven = (stdout: string): boolean =>
  /"containers?"\s*:\s*\[?\s*\{/.test(stdout) || /"container"\s*:\s*\{/.test(stdout);

/**
 * Extract every 32-hex token from `whoami` output.
 *
 * A *list*, not a single match: `whoami` can report several accounts when one
 * token has access to more than one, and a token with access to both the account
 * you meant and the account you did not is precisely the case where "the first
 * match is mine" would be wrong.
 */
export const accountsIn = (stdout: string): string[] => {
  const found = new Set<string>();
  for (const match of stdout.matchAll(/[0-9a-f]{32}/gi)) {
    found.add(match[0].toLowerCase());
  }
  return [...found];
};

/**
 * Run the authenticated checks against a target.
 *
 * `run` is injectable so the whole flow — including every refusal — is reachable
 * without a credential, a network or a Cloudflare account. That is not a
 * convenience: these are the checks whose *whole value* is what happens on a real
 * account, so testing them against a fake that always says yes proves only that
 * the function returns.
 */
export const preflight = (
  target: ResolvedTarget,
  options: {
    env?: NodeJS.ProcessEnv;
    run?: (args: readonly string[]) => { ok: boolean; stdout: string; stderr: string };
    /** A Worker that does not exist yet is expected on a first staging deploy. */
    allowMissingWorker?: boolean;
  } = {},
): PreflightReport => {
  const env = options.env ?? process.env;
  const run = options.run ?? captureWrangler;
  const commands = preflightCommands(target).map((entry) => entry.args);
  const findings: PreflightFinding[] = [];

  const credential = describeCredential(env);
  if (credential.mode === null) {
    return {
      ok: false,
      commands,
      findings: [
        {
          check: 'credential',
          ok: false,
          detail: credential.problem ?? 'No Cloudflare credential.',
          remedy: credential.remedy ?? `Set ${credential.source ?? 'CLOUDFLARE_API_TOKEN'}.`,
        },
      ],
    };
  }

  // ── account ────────────────────────────────────────────────────────────────
  const whoami = run(['whoami']);

  if (!whoami.ok) {
    findings.push({
      check: 'account',
      ok: false,
      detail: `\`wrangler whoami\` failed: ${firstLine(whoami.stderr) || 'no detail'}`,
      remedy:
        'The credential was rejected. Check that the token is still valid and has not been ' +
        'revoked, then run `bun run deploy:check --env ' +
        target.environment +
        '` again.',
    });
    return { ok: false, findings, commands };
  }

  const accounts = accountsIn(whoami.stdout);

  if (!accounts.includes(target.accountId.toLowerCase())) {
    findings.push({
      check: 'account',
      ok: false,
      // The configured account id is printed, never the token. It is
      // nonsecret configuration and naming it is the difference between "wrong
      // account" and "some wrong account".
      detail:
        `This credential can act on account(s) ${accounts.join(', ') || '(none reported)'}, ` +
        `but this project is configured for ${target.accountId}.`,
      remedy:
        'Either the token is for a different account, or the configured account id is wrong.\n' +
        '  Nothing has been changed. Set the right one with:\n' +
        '    bun run deploy:configure -- --account <32-hex>',
    });
    return { ok: false, findings, commands };
  }

  // ── database ───────────────────────────────────────────────────────────────
  if (target.deploymentProfile === 'legacy') {
    const database = run(['d1', 'info', target.d1DatabaseId, '--json']);

    if (!database.ok) {
      findings.push({
        check: 'database',
        ok: false,
        detail: `The D1 database ${target.d1DatabaseId} is not readable in this account.`,
        remedy:
          'It does not exist, it belongs to another account, or this token cannot read it.\n' +
          `  Provision the ${target.environment} database with:\n` +
          `    bun run deploy:configure -- --env ${target.environment} --provision\n` +
          '  Nothing has been changed.',
      });
      return { ok: false, findings, commands };
    }

    // A D1 database that exists but belongs to a different account still answers
    // `d1 info`, so the exit code alone is not the check. When wrangler reports a
    // different account for the database, that is the mismatch this layer is for.
    const databaseAccounts = accountsIn(database.stdout).filter((id) => id !== target.accountId);
    if (databaseAccounts.length > 0) {
      findings.push({
        check: 'database',
        ok: false,
        detail:
          `The D1 database ${target.d1DatabaseId} reports account ` +
          `${databaseAccounts.join(', ')}, not ${target.accountId}.`,
        remedy:
          'Staging and production must be separate databases. Refusing before anything is ' +
          'changed, because migrating the wrong one is the outcome this prevents.',
      });
      return { ok: false, findings, commands };
    }
  }

  // ── worker ─────────────────────────────────────────────────────────────────
  const worker = run(['deployments', 'list', '--name', target.workerName, '--json']);

  if (!worker.ok) {
    if (options.allowMissingWorker === true) {
      findings.push({
        check: 'worker',
        ok: true,
        detail: `The Worker "${target.workerName}" has no deployments yet.`,
      });
    } else {
      findings.push({
        check: 'worker',
        ok: false,
        detail: `\`wrangler deployments list --name ${target.workerName}\` failed.`,
        remedy:
          'Either the Worker does not exist in this account, or this token cannot read it.\n' +
          `  On a first ${target.environment} deploy it is expected to not exist yet; pass\n` +
          '  `--allow-new-worker` if this is the first deploy of this environment.',
      });
      return { ok: false, findings, commands };
    }
  } else {
    findings.push({
      check: 'worker',
      ok: true,
      detail: `The Worker "${target.workerName}" exists in this account.`,
    });
  }

  // ── secrets ──────────────────────────────────────────────────────────────────
  //
  // Presence, never value. This is the check that catches the most common real
  // state of a first deployment: the Worker deploys, `/health` answers 200, and
  // nobody can confirm an account because the runtime secret was never installed.
  // The Cloudflare API token is *not* a substitute — it authorises this tooling and
  // is never readable by the Worker.
  // The presence check, never the value. This is the check that catches the most
  // common real state of a first deployment: the Worker deploys, `/health` answers
  // 200, and nobody can confirm an account because the runtime secret was never
  // installed. The Cloudflare API token is *not* a substitute — it authorises this
  // tooling and is never readable by the Worker.
  //
  // `--format json`, not `--json`. wrangler 4.142.0 has no `--json` flag on
  // `secret list`; it has `--format [choices: "json", "pretty"]`. Passing the
  // invented flag made Clap print usage and exit non-zero, so this check reported
  // "this token cannot list them" on every run, including the ones where the
  // secrets were installed and `wrangler secret list` answered them. The argv is a
  // named export so a test can hold it against the pinned CLI's own help, which is
  // the only thing that catches a flag this repository invented.
  const secrets = run(secretListArgv(target.workerName, target.environment));
  if (!secrets.ok) {
    findings.push({
      check: 'secrets',
      ok: options.allowMissingWorker === true,
      detail:
        options.allowMissingWorker === true
          ? `The Worker ${target.workerName} has no readable version yet; first-deploy provisioning will install its runtime secrets.`
          : `Could not read the secrets of "${target.workerName}".`,
      ...(options.allowMissingWorker === true ? { warn: true } : {}),
      remedy:
        'This token cannot list them, or the Worker has no version yet.\n' +
        '  On a first deploy that is expected — install them with:\n' +
        `    bun run deploy:secrets --env ${target.environment} --yes --install`,
    });
  } else {
    const installed = new Set(installedSecretNames(secrets.stdout));
    const webSecretNames =
      target.deploymentProfile === 'supabase'
        ? target.requiredSecretNames.filter((name) => name !== 'GOOGLE_DISPATCHER_CREDENTIAL')
        : target.requiredSecretNames;
    const missing = webSecretNames.filter((name) => !installed.has(name));
    if (missing.length > 0) {
      findings.push({
        check: 'secrets',
        ok: options.allowMissingWorker === true,
        detail:
          `${target.workerName} does not have ${missing.join(', ')} installed. ` +
          'A release without these is live and unable to confirm an account or send mail.',
        ...(options.allowMissingWorker === true ? { warn: true } : {}),
        remedy:
          '  Install them by value; they are not the deployment credential and never\n' +
          '  appear in argv:\n' +
          `    bun run deploy:secrets --env ${target.environment} --yes --install\n` +
          '  Then re-run this preflight. Nothing has been changed.',
      });
    } else {
      findings.push({
        check: 'secrets',
        ok: true,
        detail: `${target.workerName} has ${target.requiredSecretNames.join(', ')} installed (names only).`,
      });
    }
  }

  if (target.deploymentProfile === 'supabase' && target.compute.jobsWorkerName !== null) {
    const jobsName = target.compute.jobsWorkerName;
    const jobsSecrets = run(secretListArgv(jobsName, target.environment));
    const requiredJobsSecrets = target.requiredSecretNames.filter(
      (name) => name !== 'RESEND_API_KEY',
    );
    const installedJobs = jobsSecrets.ok
      ? new Set(installedSecretNames(jobsSecrets.stdout))
      : new Set<string>();
    const missingJobsSecrets = requiredJobsSecrets.filter((name) => !installedJobs.has(name));
    const complete = jobsSecrets.ok && missingJobsSecrets.length === 0;
    let detail: string;
    if (complete) {
      detail = `${jobsName} has its required secret names installed.`;
    } else if (jobsSecrets.ok) {
      detail = `${jobsName} is missing ${missingJobsSecrets.join(', ')}.`;
    } else {
      detail = `Could not list secret names for ${jobsName}.`;
    }
    findings.push({
      check: 'jobs secrets',
      ok: complete || options.allowMissingWorker === true,
      detail,
      ...(!complete && options.allowMissingWorker === true ? { warn: true } : {}),
      ...(complete
        ? {}
        : {
            remedy: `Install the missing target secrets with \`bun run deploy:secrets --env ${target.environment} --yes --install\`.`,
          }),
    });
  }

  // ── compute ──────────────────────────────────────────────────────────────────
  if (target.compute.enabled && target.compute.mediaBucketName !== null) {
    const buckets = run(['r2', 'bucket', 'list', '--json']);
    const present = buckets.ok && bucketExists(buckets.stdout, target.compute.mediaBucketName);

    if (!present) {
      findings.push({
        check: 'bucket',
        ok: options.allowMissingWorker === true,
        detail: `The R2 bucket ${target.compute.mediaBucketName} is not readable in this account.`,
        ...(options.allowMissingWorker === true ? { warn: true } : {}),
        remedy:
          'It does not exist, it belongs to another account, or this token cannot read it.\n' +
          `    bun run deploy:provision --env ${target.environment} --yes\n` +
          '  Nothing has been changed.',
      });
    } else {
      findings.push({
        check: 'bucket',
        ok: true,
        detail: `The private R2 bucket ${target.compute.mediaBucketName} exists.`,
      });
    }

    const jobsName = target.compute.jobsWorkerName;
    if (target.deploymentProfile === 'supabase') {
      findings.push({
        check: 'cloud-run',
        ok: true,
        detail: `Cloud Run Job ${target.supabase?.jobName} is checked through the authenticated Google provider preflight.`,
      });
    } else {
      if (jobsName === null) {
        findings.push({
          check: 'container',
          ok: false,
          detail: `The ${target.environment} jobs profile is "encode" but names no jobs Worker.`,
          remedy: `    bun run deploy:configure -- --env ${target.environment} --jobs-worker <name>`,
        });
      } else {
        const deployments = run(['deployments', 'list', '--name', jobsName, '--json']);
        if (!deployments.ok) {
          findings.push({
            check: 'container',
            ok: false,
            detail: `The jobs Worker "${jobsName}" has no deployments in this account.`,
            remedy:
              'Containers require the Workers Paid plan and an accepted container image.\n' +
              `  Deploy it once, then re-run this preflight:\n` +
              `    bun run deploy:apply --env ${target.environment} --yes --only jobs\n` +
              '  Nothing has been changed.',
          });
        } else if (!containerEntitlementProven(deployments.stdout)) {
          // Reported as unproven rather than as a refusal, and the distinction is
          // deliberate: an empty deployment list on a first deploy says nothing
          // about the account, and refusing here would block the deploy that would
          // establish it.
          findings.push({
            check: 'container',
            ok: true,
            detail:
              `No deployed ${jobsName} version carries a container binding yet, so the container ` +
              'entitlement is NOT PROVEN by this preflight. It is established by the first ' +
              'successful jobs deploy, not by a check this tooling can run read-only.',
            warn: true,
          });
        } else {
          findings.push({
            check: 'container',
            ok: true,
            detail: `${jobsName} has a deployed version carrying a container binding.`,
          });
        }
      }
    }
  }

  // ── mail ─────────────────────────────────────────────────────────────────────
  //
  // Half checkable, and said so. Whether a sender domain is verified is a fact
  // about Resend's account, and no read-only Cloudflare call can answer it. What is
  // checkable here is that a sender is configured at all, and what is not checkable
  // is named as not checked — a deployment record that implies mail was verified
  // when only an address was configured is exactly the kind of claim this
  // repository treats as worse than an absent one.
  findings.push({
    check: 'mail',
    ok: true,
    detail:
      `MAIL_FROM is ${target.mailFrom}. Sender-domain verification with the mail provider is ` +
      "NOT CHECKED by this preflight: it is a fact about that provider's account, and no " +
      'read-only Cloudflare call can answer it. Confirm it in the provider dashboard.',
    warn: true,
  });

  // Derived from the findings, not asserted.
  //
  // This returned a literal `true` while recording failing `secrets`, `bucket` and
  // `container` findings — so a release whose runtime secrets were not installed
  // passed preflight with `ok: true` and the failure only visible if a human read
  // the findings. That is precisely the report shape this repository treats as
  // worse than no report: a green line over a release nobody can sign in to.
  //
  // `warn` findings deliberately do not fail: they say the check could not establish
  // the whole claim, which is a different answer from "the check failed".
  return { ok: findings.every((finding) => finding.ok), findings, commands };
};

/** Read-only checks for the second and third providers in the Supabase profile. */
export const preflightSupabaseProviders = async (
  target: ResolvedTarget,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<PreflightReport> => {
  if (target.deploymentProfile !== 'supabase' || target.supabase === null) {
    return {
      ok: false,
      findings: [
        {
          check: 'target',
          ok: false,
          detail: 'Supabase provider preflight requires the resolved Supabase target.',
        },
      ],
      commands: [],
    };
  }
  const env = options.env ?? process.env;
  const commands = [
    supabaseMigrationArgs(target, 'list'),
    ...(target.compute.enabled ? [['GET', 'Google Cloud Run Job and IAM inventory']] : []),
  ];
  const findings: PreflightFinding[] = [];
  if (!env.SUPABASE_ACCESS_TOKEN) {
    findings.push({
      check: 'supabase',
      ok: false,
      detail: 'SUPABASE_ACCESS_TOKEN is required for read-only hosted project discovery.',
      remedy: 'Provide the environment-scoped token to authenticated preflight.',
    });
  } else {
    const migrations = runSupabaseMigration(target, 'list', { env });
    findings.push({
      check: 'supabase',
      ok: migrations.code === 0,
      detail:
        migrations.code === 0
          ? `Supabase project ${target.supabase.projectRef} is readable; migration status was listed.`
          : `Supabase migration discovery failed with exit ${migrations.code}.`,
      ...(migrations.code === 0
        ? {}
        : { remedy: 'Check project identity and read permissions. No mutation was attempted.' }),
    });
    try {
      const auth = await inspectSupabaseAuthConfig({
        target,
        accessToken: env.SUPABASE_ACCESS_TOKEN,
      });
      const allowlist =
        typeof auth.uri_allow_list === 'string'
          ? auth.uri_allow_list.split(',').map((entry) => entry.trim())
          : [];
      const expected = target.supabase.nativeRedirectAllowlist;
      const complete = expected.every((uri) => allowlist.includes(uri));
      findings.push({
        check: 'callbacks',
        ok: true,
        detail: complete
          ? 'Supabase Auth contains the resolved native and web callback allowlist.'
          : 'Supabase Auth callback configuration does not contain the complete resolved allowlist.',
        ...(complete
          ? {}
          : {
              warn: true,
              remedy: `Run bun run deploy:apply --env ${target.environment} --yes to apply the reviewed callback configuration.`,
            }),
      });
    } catch (error) {
      findings.push({
        check: 'callbacks',
        ok: false,
        detail:
          error instanceof Error ? error.message : 'Supabase Auth configuration could not be read.',
        remedy:
          'Check Management API read access and the resolved project ref. Preflight is read-only.',
      });
    }
  }
  if (!target.compute.enabled) {
    findings.push({
      check: 'google',
      ok: true,
      warn: true,
      detail: 'Compute is disabled: Google Cloud Run and IAM discovery was NOT RUN.',
    });
  } else if (!env.GOOGLE_ACCESS_TOKEN) {
    findings.push({
      check: 'google',
      ok: false,
      detail: 'GOOGLE_ACCESS_TOKEN is required for read-only Cloud Run and IAM discovery.',
      remedy:
        'Obtain a short-lived token through the configured workload identity and rerun preflight.',
    });
  } else {
    try {
      const inventory = await inspectGoogleResources({
        target,
        accessToken: env.GOOGLE_ACCESS_TOKEN,
      });
      const plan = googleResourcePlan(target);
      const missingApis = plan.requiredApis.filter((api) => !inventory.enabledApis.includes(api));
      const missingIdentities = [
        ...(inventory.runnerExists ? [] : [`runner ${inventory.runner}`]),
        ...(inventory.dispatcherExists ? [] : [`dispatcher ${inventory.dispatcher}`]),
      ];
      const missing = [
        ...(inventory.job === null ? [`Cloud Run Job ${plan.job}`] : []),
        ...missingIdentities,
        ...missingApis.map((api) => `API ${api}`),
      ];
      findings.push({
        check: 'google',
        ok: true,
        detail:
          missing.length === 0
            ? `Cloud Run Job and separate runner/dispatcher identities are readable in ${target.supabase.googleProjectId}.`
            : `Read-only discovery succeeded. Provision will create/enable: ${missing.join(', ')}.`,
        ...(missing.length === 0 ? {} : { warn: true }),
      });
    } catch (error) {
      findings.push({
        check: 'google',
        ok: false,
        detail: error instanceof Error ? error.message : 'Google resource discovery failed.',
        remedy: 'Correct the project, region or read permissions. Preflight performs no mutations.',
      });
    }
  }
  return { ok: findings.every((finding) => finding.ok), findings, commands };
};

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/** Render a report for a person. Never prints a credential. */
export const renderPreflight = (target: ResolvedTarget, report: PreflightReport): string => {
  const lines = [`Preflight (${target.environment} -> ${target.workerName})`, ''];

  for (const finding of report.findings) {
    let mark = 'ok  ';
    if (!finding.ok) {
      mark = 'FAIL';
    } else if (finding.warn === true) {
      // A passed-but-partial check is not the same answer as a passed one, and
      // rendering both as `ok` is a report nobody can read while something is wrong.
      mark = 'warn';
    }
    lines.push(`  ${mark} ${finding.check}: ${finding.detail}`);
    if (!finding.ok) {
      lines.push(
        `       ${(finding.remedy ?? 'Resolve the provider finding, then rerun preflight.').replace(/\n/g, '\n       ')}`,
      );
    }
  }

  if (report.ok) {
    lines.push('', 'Every check above passed. Nothing has been changed.');
  }

  return lines.join('\n');
};
