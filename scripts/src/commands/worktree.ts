import { spawnSync } from 'node:child_process';
import { importTrustedReviewSettings } from '../setup/worktree_environment.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { publicToolEnvironment } from '../shared/private_environment.ts';
import { runBounded } from '../shared/run_bounded.ts';

const USAGE = `worktree bootstrap [--from <absolute-dotenv>]

Install the locked workspace dependencies and resolve Chromium for a fresh worktree.
Nix hosts run setup inside the pinned flake; other hosts use their installed Bun.
--from imports only optional visual-review settings into a new, private .env.e2e.
Existing .env.e2e files are never overwritten. Deployment and hosted service keys are refused.`;

export const bootstrapWorktree = async (root = REPO_ROOT, sourcePath?: string): Promise<number> => {
  let imported: string[] = [];
  try {
    if (sourcePath !== undefined) {
      imported = importTrustedReviewSettings(root, sourcePath);
    }
  } catch (error) {
    return fail(
      `Worktree settings import failed: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.refused,
    );
  }
  if (imported.length > 0) {
    process.stdout.write(`Imported optional review settings: ${imported.join(', ')}\n`);
  }

  const env = publicToolEnvironment(process.env);
  const nix =
    process.env.IN_NIX_SHELL === undefined
      ? spawnSync('nix', ['--version'], { cwd: root, env, stdio: 'ignore' })
      : { error: undefined, status: 0 };
  const command =
    nix.error === undefined && nix.status === 0
      ? { command: 'nix', args: ['develop', '--command', 'bun', 'run', 'setup'] }
      : { command: 'bun', args: ['run', 'setup'] };
  const result = await runBounded({
    ...command,
    cwd: root,
    env,
    timeoutMs: 15 * 60_000,
    maxBytes: 16 * 1024 * 1024,
    stdio: 'inherit',
  });
  if (result.code !== 0) {
    return fail(
      `Worktree setup failed with exit ${result.code}. Fix the named prerequisite and rerun \`bun run worktree:bootstrap\`.`,
      result.code === 127 ? EXIT.unavailable : EXIT.failed,
    );
  }
  process.stdout.write(`Worktree setup ready at ${root}.\n`);
  return EXIT.ok;
};

export const worktreeCommand: Command = {
  name: 'worktree',
  summary: 'bootstrap a fresh isolated checkout',
  usage: USAGE,
  async run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }
    if (argv[0] !== 'bootstrap') {
      return fail(USAGE, EXIT.usage);
    }
    let sourcePath: string | undefined;
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index] !== '--from' || sourcePath !== undefined || argv[index + 1] === undefined) {
        return fail(`Invalid worktree bootstrap arguments.\n\n${USAGE}`, EXIT.usage);
      }
      sourcePath = argv[index + 1];
      index += 1;
    }
    return bootstrapWorktree(REPO_ROOT, sourcePath);
  },
};
