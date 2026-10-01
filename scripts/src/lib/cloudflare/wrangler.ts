// scripts/src/lib/cloudflare/wrangler.ts
//
// The only place that shells out to Wrangler.
//
// One wrapper so that "is wrangler available", "which version", "which config",
// and "are we allowed to touch a remote" are decided in one file rather than at
// each of the dozen call sites. Every remote operation goes through
// `requireRemoteConsent`.
//
// Two invariants this module owns, both of which were violated before:
//
//   1. **The binary is the pinned one.** It resolves through `tools.wranglerBin()`,
//      never through `bunx`. See that module for why `bunx` is wrong here.
//   2. **`wrangler` appears in argv exactly once.** The plan builder emits the
//      subcommand and its arguments *without* the `wrangler` token; this module
//      prepends the binary. When the plan also included it, the process that
//      actually ran was `wrangler wrangler deploy`, which fails with a message
//      that names neither the plan nor the cause.

import { spawnSync } from 'node:child_process';
import { API_DIR, CLIENT_DIR, REPO_ROOT } from '../paths.ts';
import { missingToolMessage, wranglerBin } from '../tools.ts';

export { API_DIR, CLIENT_DIR, REPO_ROOT };

/**
 * Why wrangler is unusable, or `null` when it is usable.
 *
 * A reason rather than a boolean: the caller has to tell the operator what to do
 * about it, and the two failure modes (not installed / installed but broken) have
 * different remedies.
 */
export const wranglerUnavailableReason = (): string | null => {
  const bin = wranglerBin();
  if (bin === null) {
    return missingToolMessage('wrangler', 'apps/backend/api');
  }

  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', cwd: REPO_ROOT });
  if (probe.error !== undefined || probe.status !== 0) {
    const detail = probe.error?.message ?? probe.stderr?.trim() ?? 'unknown error';
    return `\`${bin} --version\` failed (${detail}). Run \`bun install\` and try again.`;
  }

  return null;
};

/** Is `wrangler` usable? Cheap check; does not contact the network. */
export const wranglerAvailable = (): boolean => wranglerUnavailableReason() === null;

/** The pinned wrangler version, as the binary reports it. */
export const wranglerVersion = (): string | null => {
  const bin = wranglerBin();
  if (bin === null) {
    return null;
  }
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', cwd: REPO_ROOT });
  return probe.status === 0 ? probe.stdout.trim() : null;
};

/**
 * Is a Cloudflare credential present? Never prints it.
 *
 * Only `CLOUDFLARE_API_TOKEN` is treated as a credential. `wrangler login` writes
 * an OAuth token into a per-user config directory, and this function deliberately
 * does not go looking for it: reading a developer's global wrangler state from a
 * script makes behaviour depend on machine state nobody can see in review. When
 * only the OAuth login exists, this reports "no credential" and the operator sets
 * the variable or exports the token. Phase 3 makes the supported paths explicit.
 */
export const hasCloudflareCredential = (): boolean => {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  return token !== undefined && token.trim().length > 0;
};

export type RemoteConsent = { allowed: true } | { allowed: false; reason: string };

/**
 * Gate every remote mutation.
 *
 * `--yes` is the only thing that authorises a remote mutation, in every session.
 * An interactive terminal is *not* sufficient: the description this function used
 * to carry claimed it refused "a non-interactive process, or one without
 * `--yes`", which meant an interactive shell without `--yes` proceeded silently.
 * That is the worse behaviour — the operator gets no prompt and no signal that
 * consent was assumed rather than given.
 *
 * `interactive` is a parameter so the caller can prove the behaviour at the
 * process boundary in a test rather than by reading this comment.
 */
export const requireRemoteConsent = (
  target: string,
  args: readonly string[],
  interactive: boolean = process.stdout.isTTY === true && process.env.CI !== 'true',
): RemoteConsent => {
  if (!hasCloudflareCredential()) {
    return {
      allowed: false,
      reason:
        'No Cloudflare credential found. Set CLOUDFLARE_API_TOKEN (this is the only ' +
        'credential this tooling reads). Nothing has been changed.',
    };
  }

  if (!args.includes('--yes')) {
    return {
      allowed: false,
      reason:
        `Refusing to modify ${target} without --yes.` +
        (interactive ? '' : ' (This session is non-interactive, so there is nobody to ask.)') +
        ' Use --dry-run to see exactly what would run. Nothing has been changed.',
    };
  }

  return { allowed: true };
};

/**
 * How a wrangler invocation is executed. Injectable so tests can observe argv at
 * the process boundary instead of asserting on a constant array.
 */
export interface ProcessRunner {
  run(command: string, args: readonly string[], options: { cwd: string }): number;
}

const defaultRunner: ProcessRunner = {
  run: (command, args, options) =>
    spawnSync(command, [...args], { stdio: 'inherit', cwd: options.cwd }).status ?? 1,
};

/** Injected by `main`/tests; defaults to the real process. */
let runner: ProcessRunner = defaultRunner;

export const setProcessRunner = (next: ProcessRunner | null): void => {
  runner = next ?? defaultRunner;
};

/**
 * Run wrangler. Never throws; returns the exit code.
 *
 * `wranglerArgs` must NOT include the `wrangler` token. This function supplies
 * the binary and prepends nothing else.
 */
export const runWrangler = (
  wranglerArgs: readonly string[],
  options: { cwd?: string } = {},
): number => {
  const bin = wranglerBin();
  if (bin === null) {
    process.stderr.write(`${missingToolMessage('wrangler', 'apps/backend/api')}\n`);
    return 1;
  }
  return runner.run(bin, wranglerArgs, { cwd: options.cwd ?? REPO_ROOT });
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
  const bin = wranglerBin();
  if (bin === null) {
    return { ok: false, stdout: '', stderr: missingToolMessage('wrangler', 'apps/backend/api') };
  }

  const result = spawnSync(bin, [...wranglerArgs], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};
