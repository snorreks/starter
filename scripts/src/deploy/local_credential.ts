import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { REPO_ROOT } from '../shared/paths.ts';
import { CREDENTIAL_ENV_VAR } from './credentials.ts';

/** Dedicated local deploy credential; never loaded by dev, build, or offline plans. */
export const LOCAL_CREDENTIAL_FILE = '.env.deploy';

/** Whether this CLI invocation needs the optional local deploy credential. */
export const needsDeploymentCredential = (options: {
  command: string;
  args: readonly string[];
}): boolean => {
  const { command, args } = options;
  if (args.includes('--help') || args.includes('-h')) {
    return false;
  }
  if (command === 'deploy') {
    return !args.some((arg) => arg === 'plan' || arg === 'status' || arg === '--dry-run');
  }
  if (command === 'configure') {
    return args.includes('--provision');
  }
  if (command === 'db') {
    // `--dry-run` prints the command it would run and stops, the same as
    // `deploy plan`. Asking it for the deploy credential would refuse a run that
    // reaches no remote and would name a `.env.deploy` it never needs.
    return args.includes('--remote') && !args.includes('--dry-run');
  }
  return (
    command === 'logs' &&
    args.includes('--mode') &&
    (args.includes('staging') || args.includes('production'))
  );
};

/**
 * Supply the repo-local token only for the duration of an authenticated command.
 * Injected/CI credentials win. File failures name the boundary, never its contents.
 */
export const withDeploymentCredential = async (options: {
  run: () => number | Promise<number>;
  root?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number> => {
  const env = options.env ?? process.env;
  if (env[CREDENTIAL_ENV_VAR]?.trim()) {
    return options.run();
  }
  const root = options.root ?? REPO_ROOT;
  const path = join(root, LOCAL_CREDENTIAL_FILE);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return options.run();
    }
    throw new Error('Cannot inspect .env.deploy. Nothing has been loaded.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) {
    throw new Error('.env.deploy must be a regular file of at most 16 KiB, not a symlink.');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('Refusing readable-by-others .env.deploy. Run chmod 600 .env.deploy.');
  }
  const gitOptions = { cwd: root, encoding: 'utf8' as const, timeout: 5_000, maxBuffer: 16_384 };
  const tracked = spawnSync(
    'git',
    ['ls-files', '--error-unmatch', '--', LOCAL_CREDENTIAL_FILE],
    gitOptions,
  );
  const ignored = spawnSync(
    'git',
    ['check-ignore', '--quiet', '--', LOCAL_CREDENTIAL_FILE],
    gitOptions,
  );
  if (tracked.status !== 1 || ignored.status !== 0) {
    throw new Error(
      'Refusing .env.deploy: it must be gitignored and untracked in this repository.',
    );
  }
  let parsed: ReturnType<typeof parseEnv>;
  try {
    parsed = parseEnv(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Cannot parse .env.deploy. Contents suppressed.');
  }
  if (
    Object.keys(parsed).some((key) => key !== CREDENTIAL_ENV_VAR) ||
    !parsed[CREDENTIAL_ENV_VAR]?.trim()
  ) {
    throw new Error('.env.deploy must contain only a nonempty CLOUDFLARE_API_TOKEN.');
  }
  const previous = env[CREDENTIAL_ENV_VAR];
  env[CREDENTIAL_ENV_VAR] = parsed[CREDENTIAL_ENV_VAR];
  try {
    return await options.run();
  } finally {
    if (previous === undefined) {
      delete env[CREDENTIAL_ENV_VAR];
    } else {
      env[CREDENTIAL_ENV_VAR] = previous;
    }
  }
};
