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

/** What is still unconfigured. Read-only. */
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

  const scopes = values.environments === undefined ? { default: values } : values.environments;
  for (const [environment, targets] of Object.entries(scopes)) {
    const scope = values.environments === undefined ? '' : ` in ${environment}`;
    if (targets.workerName === null) {
      problems.push(`No Worker name configured${scope}.`);
    }
    if (targets.d1DatabaseId === null) {
      problems.push(`No D1 database id configured${scope}.`);
    }
  }

  if (
    values.environments === undefined &&
    values.d1DatabaseId !== null &&
    describeResolution('d1DatabaseId') === 'local-file'
  ) {
    // Naming the source is what stops the next question being "where did this id
    // come from, and is it mine?"
    notices.push(`D1 database id read from ${LOCAL_DEPLOYMENT_FILE}.`);
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
      'No custom domain configured. The application will be reachable at *.workers.dev only.',
    );
  }
  if (values.r2BucketNames.uploads === null) {
    notices.push(
      'No R2 upload bucket configured. That is fine: uploads are a documented future ' +
        'capability and nothing in the application reads a bucket.',
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
  } = {},
): number => {
  const root = options.root ?? REPO_ROOT;
  const credentialed = options.hasCredential ?? hasCloudflareCredential;
  const create =
    options.create ??
    ((): { ok: boolean; stdout: string; stderr: string } =>
      captureWrangler(['d1', 'create', 'starter-api']));

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
        `Nothing was written. Add it to ${LOCAL_DEPLOYMENT_FILE} by hand.\n`,
    );
    return 1;
  }

  // The account id is knowable only with a credential, and every account-scoped
  // endpoint needs it — the Observability log query being the one that surfaced
  // this. Read it rather than asking, so `--provision` leaves a configuration that
  // can actually query logs.
  const account = /\b[0-9a-f]{32}\b/i.exec(created.stdout)?.[0] ?? null;

  // Under `root`, not `CLIENT_DIR`. `root` is a parameter precisely so this can be
  // driven against a throwaway tree; resolving the repository's own wrangler.jsonc
  // here ignored that, and the test suite wrote its fixture UUID into the
  // committed file — a resource id in a file the `registry-valid` guard exists to
  // keep free of one, and a test that mutates the repository it runs in.
  const wranglerPath = wranglerConfigAt(root);
  if (existsSync(wranglerPath)) {
    const text = readFileSync(wranglerPath, 'utf8');
    const updated = text.includes('"database_id"')
      ? text.replace(/("database_id"\s*:\s*)"[^"]*"/, `$1"${id}"`)
      : text.replace(/("database_name"\s*:\s*"[^"]*",)/, `$1\n      "database_id": "${id}",`);

    if (updated !== text) {
      writeFileSync(wranglerPath, updated);
      process.stdout.write(`D1 database id written to wrangler.jsonc: ${id}\n`);
    }
  }

  const write =
    options.write ??
    ((current: LocalDeploymentValues): LocalDeploymentValues => ({
      ...current,
      d1DatabaseId: id,
      accountId: account ?? current.accountId,
    }));

  writeLocalValues(write, root);

  process.stdout.write(`D1 database id written to ${LOCAL_DEPLOYMENT_FILE}: ${id}\n`);
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
export const setAccount = (args: readonly string[], root: string = REPO_ROOT): number => {
  const accountIndex = args.indexOf('--account');
  const account = accountIndex === -1 ? undefined : args[accountIndex + 1];

  if (account === undefined || !/^[0-9a-f]{32}$/i.test(account)) {
    process.stderr.write(
      '--account needs a 32-character hex Cloudflare account id.\n' +
        '  Find it at https://dash.cloudflare.com → Workers & Pages → Account ID.\n' +
        '  Nothing has been changed.\n',
    );
    return 2;
  }

  const workerIndex = args.indexOf('--worker');
  const workerName = workerIndex === -1 ? undefined : args[workerIndex + 1];

  if (workerName?.startsWith('-') === true) {
    process.stderr.write(
      `--worker takes the Worker's name: --worker <name>\n` +
        '  Nothing has been changed. A Worker name is a single value, and accepting a\n' +
        '  target as well is how the previous two-argument form recorded "api" as a name.\n',
    );
    return 2;
  }

  writeLocalValues(
    (current) => ({
      ...current,
      accountId: account.toLowerCase(),
      ...(workerName === undefined ? {} : { workerName }),
    }),
    root,
  );

  process.stdout.write(`Account id written to ${LOCAL_DEPLOYMENT_FILE}.\n`);
  if (workerName !== undefined) {
    process.stdout.write(`Worker name written: ${workerName}\n`);
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
    return provisionDatabase();
  }

  if (args.includes('--account')) {
    return setAccount(args, REPO_ROOT);
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
    '\nNext steps:\n' +
      '  bun run deploy:configure -- --provision   # create the D1 database\n' +
      '  bun run deploy:configure -- --check       # verify\n' +
      '  bun run deploy:check                     # validate the deploy plan (dry run)\n',
  );
  return 0;
};

export type { DeploymentEnvironment };
export { WRANGLER_CONFIG };
