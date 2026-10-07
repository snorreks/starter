// scripts/src/commands/db.ts
//
// Thin adapter over the D1 domain modules. `db` owns the subcommand word so the
// three entrypoints are one command with three actions rather than three commands
// with overlapping names.

import { main as migrateMain } from '../db/migrate.ts';
import { main as seedMain } from '../db/seed.ts';
import { main as statusMain } from '../db/status.ts';
import { runDatabaseIntegration, runDatabaseTypeCommand } from '../db/supabase_local.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';

const USAGE = [
  'Usage: db migrate (--local | --remote <staging|production> [--yes]) [--dry-run]',
  '       db status',
  '       db seed',
  '       db test:database',
  '       db types | types:check',
].join('\n');

export const dbCommand: Command = {
  name: 'db',
  summary: 'D1 migrations, status and seed',
  usage: USAGE,

  run(argv) {
    const [subcommand, ...rest] = argv;

    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }

    if (subcommand === undefined) {
      return fail(`Specify a db subcommand.\n${USAGE}`, EXIT.usage);
    }

    switch (subcommand) {
      case 'migrate':
        return migrateMain(rest);
      case 'status':
        return statusMain(rest);
      case 'seed':
        return seedMain(rest);
      case 'test:database':
        return runDatabaseIntegration();
      case 'types':
        return runDatabaseTypeCommand('db:types');
      case 'types:check':
        return runDatabaseTypeCommand('db:types:check');
      default:
        return fail(`Unknown db subcommand "${subcommand}".\n${USAGE}`, EXIT.usage);
    }
  },
};
