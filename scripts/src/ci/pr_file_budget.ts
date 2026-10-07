import { spawnSync } from 'node:child_process';

export interface PrFileBudgetResult {
  ok: boolean;
  count: number;
  maxFiles: number;
  base: string;
  paths: string[];
}

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Could not resolve PR budget base or paths: ${(result.stderr || result.error?.message || 'git failed').trim()}`,
    );
  }
  return result.stdout;
};

const paths = (text: string): string[] => text.split('\0').filter((path) => path.length > 0);

export const checkPrFileBudget = (options: {
  cwd: string;
  base: string;
  maxFiles: number;
  head?: string;
}): PrFileBudgetResult => {
  const { cwd, base, maxFiles, head = 'HEAD' } = options;
  if (base.trim() === '') {
    throw new Error('A PR budget base is required.');
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error('The maximum file count must be a positive integer.');
  }
  const resolvedBase = git(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).trim();
  if (resolvedBase === '') {
    throw new Error(`The PR budget base "${base}" is not a commit.`);
  }

  const committed = paths(
    git(cwd, ['diff', '--no-renames', '--name-only', '-z', `${resolvedBase}...${head}`]),
  );
  const pending = paths(git(cwd, ['diff', '--no-renames', '--name-only', '-z', resolvedBase]));
  const untracked = paths(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']));
  const changed = [...new Set([...committed, ...pending, ...untracked])].sort();
  return {
    ok: changed.length <= maxFiles,
    count: changed.length,
    maxFiles,
    base: resolvedBase,
    paths: changed,
  };
};
