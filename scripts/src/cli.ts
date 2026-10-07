// scripts/src/cli.ts
//
// The one command dispatcher for this workspace.
//
//   bun run scripts -- <command> [args]
//   bun run scripts -- --help
//   bun run scripts -- <command> --help
//
// Everything else — package.json scripts, CI and the Pi wrappers — goes through
// here, so there is exactly one implementation of each operation and one place
// that decides which commands exist.
//
// Commands are imported lazily. `bun run scripts -- logs --help` should not pay
// for the deploy, database and secrets modules to load, and the table has to be a
// map of loaders rather than a static array of values for that to be true.

import { type Command, EXIT, fail } from './shared/command.ts';

type CommandLoader = () => Promise<Command>;

const COMMANDS: Record<string, CommandLoader> = {
  cached: async () => (await import('./commands/cached.ts')).cachedCommand,
  ci: async () => (await import('./commands/ci.ts')).ciCommand,
  configure: async () => (await import('./commands/configure.ts')).configureCommand,
  contract: async () => (await import('./commands/contracts.ts')).contractCommand,
  coverage: async () => (await import('./commands/coverage.ts')).coverageCommand,
  db: async () => (await import('./commands/db.ts')).dbCommand,
  deploy: async () => (await import('./commands/deploy.ts')).deployCommand,
  dev: async () => (await import('./commands/dev.ts')).devCommand,
  doctor: async () => (await import('./commands/setup.ts')).doctorCommand,
  guard: async () => (await import('./commands/guard.ts')).guardCommand,
  logs: async () => (await import('./commands/logs.ts')).logsCommand,
  native: async () => (await import('./commands/native.ts')).nativeCommand,
  'pr-budget': async () => (await import('./commands/pr_budget.ts')).prBudgetCommand,
  secrets: async () => (await import('./commands/secrets.ts')).secretsCommand,
  setup: async () => (await import('./commands/setup.ts')).setupCommand,
  smoke: async () => (await import('./commands/smoke.ts')).smokeCommand,
  workflows: async () => (await import('./commands/workflows.ts')).workflowsCommand,
  worktree: async () => (await import('./commands/worktree.ts')).worktreeCommand,
  update: async () => (await import('./commands/update.ts')).updateCommand,
  evidence: async () => (await import('./commands/evidence.ts')).evidenceCommand,
  e2e: async () => (await import('./commands/e2e.ts')).e2eCommand,
  visual: async () => (await import('./commands/visual.ts')).visualCommand,
};

const names = (): string[] => Object.keys(COMMANDS).sort();

const renderHelp = async (): Promise<string> => {
  const summaries = await Promise.all(
    names().map(async (name) => {
      const command = await COMMANDS[name]();
      return `  ${name.padEnd(9)} ${command.summary}`;
    }),
  );

  return [
    'Usage: bun run scripts -- <command> [args]',
    '       bun run scripts -- <command> --help',
    '',
    'Commands:',
    ...summaries,
    '',
    'Exit codes: 0 ok, 1 the work failed, 2 bad invocation, 3 prerequisite unavailable, 4 refused.',
  ].join('\n');
};

/**
 * Dispatch one argv and return the exit code.
 *
 * Returning rather than calling `process.exit` keeps the whole CLI reachable from
 * a test without spawning it.
 */
export const main = async (argv: readonly string[]): Promise<number> => {
  const [name, ...rest] = argv;

  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    process.stdout.write(`${await renderHelp()}\n`);
    return EXIT.ok;
  }

  const loader = COMMANDS[name];

  if (loader === undefined) {
    return fail(
      `Unknown command "${name}".\nAvailable: ${names().join(', ')}\n` +
        'Run `bun run scripts -- --help` for the list.',
      EXIT.usage,
    );
  }

  try {
    const command = await loader();
    const { needsDeploymentCredential, withDeploymentCredential } = await import(
      './deploy/local_credential.ts'
    );
    if (needsDeploymentCredential({ command: name, args: rest })) {
      return await withDeploymentCredential({
        run: async () => {
          const { effectiveDeploymentValues } = await import('./registry/deployment_values.ts');
          const accountId = effectiveDeploymentValues().accountId;
          if (accountId === null || !/^[0-9a-f]{32}$/i.test(accountId)) {
            return fail(
              "No valid Cloudflare account ID configured. Refusing to use Wrangler's cached account. Run deploy:configure -- --account <32-hex>.",
              EXIT.unavailable,
            );
          }
          const previous = process.env.CLOUDFLARE_ACCOUNT_ID;
          process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
          try {
            return await command.run(rest);
          } finally {
            if (previous === undefined) {
              delete process.env.CLOUDFLARE_ACCOUNT_ID;
            } else {
              process.env.CLOUDFLARE_ACCOUNT_ID = previous;
            }
          }
        },
      });
    }
    return await command.run(rest);
  } catch (error) {
    // An unexpected throw is a defect, not a usage error. Name the command and
    // exit nonzero rather than letting a stack trace be the whole interface.
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return fail(`${name} failed: ${detail}`, EXIT.failed);
  }
};

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}

export { COMMANDS };
