// scripts/src/index.ts
//
// Command router. `bun run scripts -- <command>` dispatches here, and every
// package.json script points at its own entry file directly.
//
// The router exists so `bun run scripts -- <command>` works without knowing a
// path, and so `--help` can list what actually exists rather than a hand-written
// list that drifts.

export type Command = {
  name: string;
  summary: string;
  run: (args: readonly string[]) => Promise<number> | number;
};

export const main = async (args: readonly string[]): Promise<number> => {
  const [name, ...rest] = args;

  if (name === undefined || name === '--help' || name === '-h') {
    const { helpText } = await import('./lib/logs/cli.ts');
    process.stdout.write(`${helpText()}\n`);
    process.stdout.write('\nOther commands:\n');
    process.stdout.write('  bun run setup              check the toolchain, create local state\n');
    process.stdout.write('  bun run db:migrate         apply migrations locally\n');
    process.stdout.write('  bun run deploy:check       validate the Cloudflare deploy plan\n');
    process.stdout.write('  bun run guard              boundary and invariant checks\n');
    process.stdout.write('  bun run contract --help    the contract workflow\n');
    return 0;
  }

  if (name === 'logs') {
    const { main: logsMain } = await import('./lib/logs/cli.ts');
    return logsMain(rest);
  }

  if (name === 'setup') {
    const { main: setupMain } = await import('./lib/setup/index.ts');
    return setupMain(rest);
  }

  if (name === 'guard') {
    const { main: guardMain } = await import('./lib/guards/run_guards.ts');
    return guardMain(rest);
  }

  if (name === 'contract') {
    const { main: contractMain } = await import('./lib/contract/cli.ts');
    return contractMain(rest);
  }

  if (name === 'deploy') {
    const { main: deployMain } = await import('./lib/deploy/index.ts');
    return deployMain(rest);
  }

  if (name === 'db') {
    const { main: migrateMain } = await import('./lib/db/migrate.ts');
    return migrateMain(rest);
  }

  process.stderr.write(`Unknown command "${name}". Try --help.\n`);
  return 2;
};

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
