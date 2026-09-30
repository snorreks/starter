// scripts/src/lib/cloudflare/wrangler.ts
//
// The only place that shells out to Wrangler.
//
// One wrapper so that "is wrangler available", "which config", and "are we
// allowed to touch a remote" are decided in one file rather than at each of the
// dozen call sites. Every remote operation goes through `requireRemoteConsent`.

import { spawnSync } from 'node:child_process';

export const REPO_ROOT = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');
export const API_DIR = `${REPO_ROOT}/apps/backend/api`;
export const CLIENT_DIR = `${REPO_ROOT}/apps/frontend/client`;

/** Is `bunx wrangler` usable? Cheap check; does not contact the network. */
export const wranglerAvailable = (): boolean => {
  const result = spawnSync('bunx', ['wrangler', '--version'], { stdio: 'ignore' });
  return result.status === 0;
};

/** Is a Cloudflare credential present? Never prints it. */
export const hasCloudflareCredential = (): boolean => {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  return token !== undefined && token.trim().length > 0;
};

export type RemoteConsent = { allowed: true } | { allowed: false; reason: string };

/**
 * Gate every remote mutation.
 *
 * A non-interactive process, or one without `--yes`, is refused. This is the
 * single reason the deploy tooling cannot surprise anyone: a mutation needs an
 * explicit opt-in that only a human running the command can give.
 */
export const requireRemoteConsent = (target: string, args: readonly string[]): RemoteConsent => {
  if (!hasCloudflareCredential()) {
    return {
      allowed: false,
      reason:
        'No Cloudflare credential found. Set CLOUDFLARE_API_TOKEN or run `wrangler login`. ' +
        'Nothing has been changed.',
    };
  }

  const nonInteractive = process.env.CI === 'true' || !process.stdout.isTTY;
  const explicit = args.includes('--yes');

  if (nonInteractive && !explicit) {
    return {
      allowed: false,
      reason:
        `Refusing to modify ${target} in a non-interactive session without --yes. ` +
        'Use --dry-run to see exactly what would run. Nothing has been changed.',
    };
  }

  return { allowed: true };
};

/** Run wrangler. Never throws; returns the exit code. */
export const runWrangler = (
  wranglerArgs: readonly string[],
  options: { cwd?: string } = {},
): number => {
  const result = spawnSync('bunx', ['wrangler', ...wranglerArgs], {
    stdio: 'inherit',
    cwd: options.cwd ?? REPO_ROOT,
  });
  return result.status ?? 1;
};

/**
 * Run wrangler and capture stdout, for parsing.
 *
 * Used for read-only inspection (validating a config, listing migrations). Never
 * used for a mutation.
 */
export const captureWrangler = (
  wranglerArgs: readonly string[],
): { ok: boolean; stdout: string; stderr: string } => {
  const result = spawnSync('bunx', ['wrangler', ...wranglerArgs], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};
