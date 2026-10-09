import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Install the committed hook for this worktree without redirecting its siblings. */
export const installHooks = (cwd = process.cwd()): boolean => {
  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }).trim();
  const root = git(['rev-parse', '--show-toplevel']);
  const hook = join(root, '.moon/hooks/pre-commit');
  if (!existsSync(hook)) {
    throw new Error(
      'Pre-commit hook is missing. Restore .moon/hooks/pre-commit, then run bun run setup.',
    );
  }

  const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (configured.error !== undefined || (configured.status !== 0 && configured.status !== 1)) {
    throw new Error('Could not inspect core.hooksPath. Hook installation was NOT RUN.');
  }
  const current = configured.stdout.trim();
  if (
    current !== '' &&
    current !== '.moon/hooks' &&
    resolve(root, current) !== join(root, '.moon/hooks')
  ) {
    throw new Error(
      `Existing hook manager (${current}) was not replaced. Integrate bun run pre-commit into it, or explicitly remove core.hooksPath and rerun bun run setup.`,
    );
  }

  const common = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (common.error !== undefined || (common.status !== 0 && common.status !== 1)) {
    throw new Error('Could not inspect the shared core.hooksPath. Hook installation was NOT RUN.');
  }
  if (current === '' && common.stdout.trim() === '') {
    const defaultHook = git(['rev-parse', '--git-path', 'hooks/pre-commit']);
    if (existsSync(resolve(root, defaultHook))) {
      throw new Error(
        'Existing .git/hooks/pre-commit was not replaced. Integrate bun run pre-commit into it first.',
      );
    }
  }

  chmodSync(hook, 0o755);
  const worktreeConfig = spawnSync(
    'git',
    ['config', '--local', '--get', 'extensions.worktreeConfig'],
    { cwd, encoding: 'utf8', timeout: 10_000 },
  );
  if (
    worktreeConfig.error !== undefined ||
    (worktreeConfig.status !== 0 && worktreeConfig.status !== 1)
  ) {
    throw new Error('Could not inspect extensions.worktreeConfig. Hook installation was NOT RUN.');
  }
  if (worktreeConfig.stdout.trim() !== 'true') {
    git(['config', '--local', 'extensions.worktreeConfig', 'true']);
  }

  const installed = spawnSync('git', ['config', '--worktree', '--get', 'core.hooksPath'], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (installed.error !== undefined || (installed.status !== 0 && installed.status !== 1)) {
    throw new Error(
      'Could not inspect this worktree core.hooksPath. Hook installation was NOT RUN.',
    );
  }
  const alreadyInstalled = installed.stdout.trim() === '.moon/hooks';
  if (!alreadyInstalled) {
    git(['config', '--worktree', 'core.hooksPath', '.moon/hooks']);
  }
  if (git(['config', '--worktree', '--get', 'core.hooksPath']) !== '.moon/hooks') {
    throw new Error('The worktree core.hooksPath could not be verified.');
  }

  // Remove the earlier shared setting after this checkout has its own verified
  // path. Every sibling is configured by its own setup/bootstrap run.
  if (common.stdout.trim() === '.moon/hooks') {
    git(['config', '--local', '--unset-all', 'core.hooksPath']);
  }
  return !alreadyInstalled || common.stdout.trim() === '.moon/hooks';
};

if (import.meta.main) {
  try {
    const changed = installHooks();
    process.stdout.write(`Pre-commit hook ${changed ? 'installed' : 'ready'} for this checkout.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
