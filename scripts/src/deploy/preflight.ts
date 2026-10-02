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
import type { ResolvedTarget } from './target.ts';

export type PreflightFinding =
  | { check: 'credential'; ok: false; detail: string; remedy: string }
  | { check: 'account'; ok: false; detail: string; remedy: string }
  | { check: 'database'; ok: false; detail: string; remedy: string }
  | { check: 'worker'; ok: false; detail: string; remedy: string }
  | { check: 'worker'; ok: true; detail: string };

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
export const preflightCommands = (target: ResolvedTarget): { check: string; args: string[] }[] => [
  { check: 'account', args: ['whoami'] },
  { check: 'database', args: ['d1', 'info', target.d1DatabaseId, '--json'] },
  { check: 'worker', args: ['deployments', 'list', '--name', target.workerName, '--json'] },
];

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

  return { ok: true, findings, commands };
};

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/** Render a report for a person. Never prints a credential. */
export const renderPreflight = (target: ResolvedTarget, report: PreflightReport): string => {
  const lines = [`Preflight (${target.environment} -> ${target.workerName})`, ''];

  for (const finding of report.findings) {
    lines.push(`  ${finding.ok ? 'ok  ' : 'FAIL'} ${finding.check}: ${finding.detail}`);
    if (!finding.ok) {
      lines.push(`       ${finding.remedy.replace(/\n/g, '\n       ')}`);
    }
  }

  if (report.ok) {
    lines.push('', 'Account, database and Worker all match. Nothing has been changed.');
  }

  return lines.join('\n');
};
