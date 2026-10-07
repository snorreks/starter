import { checkPrFileBudget } from '../ci/pr_file_budget.ts';
import type { Command } from '../shared/command.ts';
import { EXIT, fail, wantsHelp } from '../shared/command.ts';
import { REPO_ROOT } from '../shared/paths.ts';

const USAGE = `pr-budget --base <commit-or-ref> [--max-files <count>]

Counts paths changed from the required PR base through HEAD, pending tracked changes,
and checkout-owned untracked files. Renames count as a deletion plus an addition.

  bun run pr:budget -- --base origin/main --max-files 99`;

const run = async (args: readonly string[]): Promise<number> => {
  if (wantsHelp(args)) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }
  let base = '';
  let maxFiles = 99;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base' && args[i + 1] !== undefined) {
      base = args[++i];
    } else if (args[i] === '--max-files' && args[i + 1] !== undefined) {
      maxFiles = Number(args[++i]);
    } else {
      return fail(`Unknown or incomplete argument: ${args[i]}\n${USAGE}`, EXIT.usage);
    }
  }
  if (!base) {
    return fail(`A PR budget base is required.\n${USAGE}`, EXIT.usage);
  }
  try {
    const result = checkPrFileBudget({ cwd: REPO_ROOT, base, maxFiles });
    process.stdout.write(
      `PR path budget: ${result.count}/${result.maxFiles} paths (base ${result.base})\n`,
    );
    return result.ok
      ? EXIT.ok
      : fail(
          `Changed path count ${result.count} exceeds the maximum ${result.maxFiles}.`,
          EXIT.failed,
        );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), EXIT.usage);
  }
};

export const prBudgetCommand: Command = {
  name: 'pr-budget',
  summary: 'Enforce the changed-path limit against an explicit PR base',
  usage: USAGE,
  run,
};
