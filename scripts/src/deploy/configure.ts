// scripts/src/lib/deploy/configure.ts
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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DEPLOYMENT_CONFIG, type DeploymentEnvironment } from '@starter/schemas';
import { API_DIR, captureWrangler, hasCloudflareCredential } from '../cloudflare/wrangler.ts';

const WRANGLER_CONFIG = `${API_DIR}/wrangler.jsonc`;

export interface ConfigCheck {
  ok: boolean;
  problems: string[];
  notices: string[];
}

const stripJsonComments = (input: string): string =>
  input.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** What is still unconfigured. Read-only. */
export const inspectConfig = (): ConfigCheck => {
  const problems: string[] = [];
  const notices: string[] = [];

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

  for (const [app, name] of Object.entries(DEPLOYMENT_CONFIG.workerNames)) {
    if (name === null) {
      problems.push(`No Worker name configured for "${app}".`);
    }
  }

  if (DEPLOYMENT_CONFIG.d1DatabaseIds.api === null) {
    problems.push('No D1 database id configured for the API.');
  }

  if (!existsSync(WRANGLER_CONFIG)) {
    problems.push(`wrangler.jsonc is missing at ${WRANGLER_CONFIG}.`);
  } else {
    const text = readFileSync(WRANGLER_CONFIG, 'utf8');
    try {
      JSON.parse(stripJsonComments(text));
    } catch (error) {
      problems.push(
        `wrangler.jsonc is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`,
      );
    }
  }

  if (DEPLOYMENT_CONFIG.customDomains.api === null) {
    notices.push('No custom domain configured. The API will be reachable at *.workers.dev only.');
  }
  if (DEPLOYMENT_CONFIG.r2BucketNames.uploads === null) {
    notices.push('No R2 upload bucket configured. That is fine: uploads are optional in round 1.');
  }

  return { ok: problems.length === 0, problems, notices };
};

/** Create the D1 database and write its id into wrangler.jsonc. */
export const provisionDatabase = (): number => {
  if (!hasCloudflareCredential()) {
    process.stderr.write('No Cloudflare credential. Nothing has been changed.\n');
    return 1;
  }

  const created = captureWrangler(['d1', 'create', 'starter-api']);
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
        'Nothing was written to wrangler.jsonc; add the id by hand.\n',
    );
    return 1;
  }

  const text = readFileSync(WRANGLER_CONFIG, 'utf8');
  const updated = text.includes('"database_id"')
    ? text.replace(/("database_id"\s*:\s*)"[^"]*"/, `$1"${id}"`)
    : text.replace(/("database_name"\s*:\s*"[^"]*",)/, `$1\n      "database_id": "${id}",`);

  writeFileSync(WRANGLER_CONFIG, updated);
  process.stdout.write(`D1 database id written to wrangler.jsonc: ${id}\n`);
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

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}

export type { DeploymentEnvironment };
export { WRANGLER_CONFIG };
