// scripts/src/deploy/configure.ts
//
// Write this project's Cloudflare configuration.
//
//   bun run deploy:configure                 # interactive: asks for names
//   bun run deploy:configure -- --provision  # create the D1 database
//   bun run deploy:configure -- --dry-run    # show what would change
//
// A template cannot ship resource ids: they belong to whoever instantiates it.
// So the starting state is "nothing is provisioned", every tool reports that as
// an actionable error, and this command is the one place it becomes real.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeploymentEnvironment } from '@starter/schemas';
import { captureWrangler, hasCloudflareCredential, REPO_ROOT } from '../cloudflare/wrangler.ts';
import { DEPLOYMENT_CONFIG } from '../registry/app_registry.ts';
import {
  type DeploymentValues,
  describeResolution,
  LOCAL_DEPLOYMENT_FILE,
  type LocalDeploymentValues,
  localConfigProblem,
  readLocalValues,
  resolveDeploymentValues,
} from '../registry/deployment_values.ts';
import { CLIENT_DIR_RELATIVE } from '../shared/paths.ts';
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

/**
 * The text of `"env": { "<environment>": { … } }`, or `null` when the config has no
 * such block.
 *
 * Brace-matched by hand rather than by parsing, because `wrangler.jsonc` is JSONC:
 * stripping the comments to parse it and writing the parsed form back would delete
 * every comment in the file — and those comments are where this repository records
 * *why* the file is shaped as it is. Only the `database_id` inside the matched
 * span is ever rewritten, so the rest is preserved byte for byte.
 */
const extractEnvBlock = (text: string, environment: DeploymentEnvironment): string | null => {
  const marker = new RegExp(`"${environment}"\\s*:\\s*\\{`);
  const match = marker.exec(text);
  if (match === null) {
    return null;
  }

  let depth = 0;
  for (let index = match.index + match[0].length - 1; index < text.length; index += 1) {
    if (text[index] === '{') {
      depth += 1;
    }
    if (text[index] === '}') {
      depth -= 1;
    }
    if (depth === 0) {
      return text.slice(match.index, index + 1);
    }
  }

  return null;
};

/** The same file, resolved against a caller-supplied root. */
const wranglerConfigAt = (root: string): string => join(root, WRANGLER_CONFIG);

/**
 * The gitignored overlay, read for one environment.
 *
 * `null` when the config carries no `env.<environment>` block *and* no top-level
 * `d1_databases`, and the resolved string when it does. A `wrangler.jsonc` with a
 * single top-level entry answers for every `--env`, which is exactly the shape
 * this repository warns about: two environments, one database, and no error.
 *
 * Exported so `migrationStep` can compare what the tooling resolved against what
 * Wrangler would reach. Both commands name the binding `DB`, so the argv alone
 * cannot tell the two databases apart.
 */
export const wranglerDatabaseId = (
  environment: DeploymentEnvironment,
  root: string = REPO_ROOT,
): string | null => {
  const path = wranglerConfigAt(root);
  if (!existsSync(path)) {
    return null;
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(stripJsonComments(readFileSync(path, 'utf8'))) as Record<string, unknown>;
  } catch {
    // A config that does not parse is refused elsewhere, by `inspectConfig`. Here
    // it reads as "not configured", which is the safe direction: the caller
    // compares against the id it resolved and refuses on a mismatch.
    return null;
  }

  const sections: unknown[] = [doc];
  const envBlock = doc.env;
  if (typeof envBlock === 'object' && envBlock !== null) {
    const scoped = (envBlock as Record<string, unknown>)[environment];
    if (typeof scoped === 'object' && scoped !== null) {
      sections.unshift(scoped);
    }
  }

  for (const section of sections) {
    const bindings = (section as Record<string, unknown>).d1_databases;
    if (!Array.isArray(bindings)) {
      continue;
    }
    for (const binding of bindings) {
      if (binding === null || typeof binding !== 'object') {
        continue;
      }
      if ((binding as Record<string, unknown>).binding !== 'DB') {
        continue;
      }
      const id = (binding as Record<string, unknown>).database_id;
      if (typeof id === 'string' && id.trim() !== '') {
        return id.trim();
      }
    }
  }

  return null;
};

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
  // report and `bun run deploy plan --env <env>` can never disagree about what is
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
      continue;
    }
    if (describeResolution('d1DatabaseId') === 'local-file') {
      notices.push(`D1 database id read from ${LOCAL_DEPLOYMENT_FILE}.`);
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
 * Create the D1 database and record its id in both places that matter.
 *
 * It used to write only `wrangler.jsonc`, which left `deploy:check` and
 * `db:migrate` reading `null` from the registry forever — so provisioning could
 * never complete, and the documented remedy ("add the id by hand") pointed at a
 * module the `registry-valid` guard rejects. It now writes the gitignored local
 * file as well, which is what the tooling actually reads.
 */
/**
 * Create the D1 database and record its id in both places that matter.
 *
 * It used to write only `wrangler.jsonc`, which left `deploy:check` and
 * `db:migrate` reading `null` from the registry forever — so provisioning could
 * never complete, and the documented remedy ("add the id by hand") pointed at a
 * module the `registry-valid` guard rejects. It now writes the gitignored local
 * file as well, which is what the tooling actually reads.
 *
 * `create` and `write` are injectable so the whole flow can be driven without a
 * credential. That is not a testing convenience: with a hardcoded
 * `captureWrangler`, this function had *no* test at all, which is precisely how
 * the original bug survived — the write was never executed by anything.
 */
export const provisionDatabase = (
  options: {
    create?: () => { ok: boolean; stdout: string; stderr: string };
    write?: (current: LocalDeploymentValues) => LocalDeploymentValues;
    root?: string;
    hasCredential?: () => boolean;
    /** Which environment's topology this database belongs to. */
    environment?: DeploymentEnvironment;
  } = {},
): number => {
  const root = options.root ?? REPO_ROOT;
  const credentialed = options.hasCredential ?? hasCloudflareCredential;
  const environment = options.environment ?? 'staging';
  const create =
    options.create ??
    ((): { ok: boolean; stdout: string; stderr: string } =>
      // Named from the environment, so the two databases are visibly distinct at
      // the provider. The previous literal was `starter-api` — a name for an
      // application this repository deleted in PR B, applied to whichever
      // environment happened to run the command.
      captureWrangler(['d1', 'create', `${DEPLOYMENT_CONFIG.projectName}-${environment}-db`]));

  if (!credentialed()) {
    process.stderr.write('No Cloudflare credential. Nothing has been changed.\n');
    return 1;
  }

  const created = create();
  if (!created.ok) {
    process.stderr.write(`Failed to create the D1 database:\n${created.stderr}\n`);
    return 1;
  }

  // Wrangler prints the id on its own line; take the first UUID-shaped token.
  const id = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.exec(
    created.stdout,
  )?.[0];

  if (id === undefined) {
    process.stderr.write(
      'The database was created but its id could not be parsed from the output.\n' +
        `Nothing was written. Add it to ${LOCAL_DEPLOYMENT_FILE} by hand under\n` +
        `  "environments": { "${environment}": { "d1DatabaseId": "<id>" } }.\n`,
    );
    return 1;
  }

  // The account id is knowable only with a credential, and every account-scoped
  // endpoint needs it — the Observability log query being the one that surfaced
  // this. Read it rather than asking, so `--provision` leaves a configuration that
  // can actually query logs.
  const account = /\b[0-9a-f]{32}\b/i.exec(created.stdout)?.[0] ?? null;

  // The wrangler path is written under the environment's own `env.<name>` block
  // when the config has one, and at the top level otherwise — which is what
  // Wrangler itself resolves for `--env <name>` in that case. Writing it at the
  // top level for staging therefore makes it staging's *and* production's
  // database until an `env.production` block exists; `wranglerDatabaseId` and
  // `resolveTarget` both refuse that state rather than deploying into it.
  const wranglerPath = wranglerConfigAt(root);
  if (existsSync(wranglerPath)) {
    const text = readFileSync(wranglerPath, 'utf8');
    const scoped = extractEnvBlock(text, environment);

    const withId = (source: string): string =>
      source.includes('"database_id"')
        ? source.replace(/("database_id"\s*:\s*)"[^"]*"/, `$1"${id}"`)
        : source.replace(/("database_name"\s*:\s*"[^"]*",)/, `$1\n      "database_id": "${id}",`);

    const updated = scoped === null ? withId(text) : withId(scoped);

    if (updated !== text) {
      writeFileSync(wranglerPath, updated);
      process.stdout.write(`D1 database id written to wrangler.jsonc: ${id}\n`);
    }
  }

  // Per environment, not top-level. A single `d1DatabaseId` is the value that let
  // staging and production share one database: `--env staging` and `--env
  // production` both read it, so a staging release reached live data.
  // `resolveTarget` now refuses that configuration outright, but the writer has to
  // stop producing it.
  const write =
    options.write ??
    ((current: LocalDeploymentValues): LocalDeploymentValues => {
      const environments = { ...(current.environments ?? {}) };
      environments[environment] = {
        ...(environments[environment] ?? {}),
        d1DatabaseId: id,
      };
      return {
        ...current,
        environments,
        accountId: account ?? current.accountId,
      };
    });

  writeLocalValues(write, root);

  process.stdout.write(
    `D1 database id for ${environment} written to ${LOCAL_DEPLOYMENT_FILE}: ${id}\n`,
  );
  if (account !== null) {
    process.stdout.write(`Cloudflare account id recorded: ${account}\n`);
  } else {
    process.stdout.write(
      `The account id was not in wrangler's output. Set it in ${LOCAL_DEPLOYMENT_FILE}\n` +
        '  or export CLOUDFLARE_ACCOUNT_ID; the log query endpoint is account-scoped.\n',
    );
  }
  return 0;
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

  if (account === undefined && workerName === undefined && origin === undefined) {
    process.stderr.write(
      'Nothing to write. Pass --account <32-hex>, --env <env> --worker <name>, or\n' +
        '  --env <env> --origin https://<host>.\n',
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
        '  Nothing has been changed. It is the base URL Better Auth issues cookies for\n' +
        '  and the address verification fetches.\n',
    );
    return 2;
  }

  writeLocalValues((current) => {
    const environments = { ...(current.environments ?? {}) };
    if (environment !== undefined) {
      environments[environment] = {
        ...(environments[environment] ?? {}),
        ...(workerName === undefined ? {} : { workerName }),
        ...(origin === undefined ? {} : { origin }),
      };
    }
    return {
      ...current,
      ...(account === undefined ? {} : { accountId: account.toLowerCase() }),
      ...(environment === undefined ? {} : { environments }),
    };
  }, root);

  if (account !== undefined) {
    process.stdout.write(`Account id written to ${LOCAL_DEPLOYMENT_FILE}.\n`);
  }
  if (workerName !== undefined) {
    process.stdout.write(`Worker name for ${environment}: ${workerName}\n`);
  }
  if (origin !== undefined) {
    process.stdout.write(`Origin for ${environment}: ${origin}\n`);
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

  if (args.includes('--provision')) {
    // `indexOf` returns -1 when `--env` is absent, and `args[-1 + 1]` is `args[0]` —
    // which is the string `--provision`, so the documented
    // `bun run deploy:configure -- --provision` was rejected as an invalid
    // environment. An absent flag is not an error here; `provisionDatabase` applies
    // its own `staging` default, which is what an operator who named no
    // environment means.
    const envIndex = args.indexOf('--env');
    const rawEnvironment = envIndex === -1 ? undefined : args[envIndex + 1];
    if (
      rawEnvironment !== undefined &&
      !DEPLOYABLE_ENVIRONMENTS.includes(rawEnvironment as never)
    ) {
      process.stderr.write(
        `--env must be ${DEPLOYABLE_ENVIRONMENTS.join(' or ')} (got "${rawEnvironment}").\n` +
          '  Nothing has been created.\n',
      );
      return 2;
    }
    return provisionDatabase({
      environment: (rawEnvironment as DeploymentEnvironment | undefined) ?? 'staging',
    });
  }

  if (args.includes('--account') || args.includes('--worker') || args.includes('--origin')) {
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
      '  bun run deploy:configure -- --env staging --provision\n' +
      '  bun run deploy:configure -- --check                # verify\n' +
      '  bun run deploy:check --env staging                # the offline plan\n',
  );
  return 0;
};

export type { DeploymentEnvironment };
export { WRANGLER_CONFIG };
