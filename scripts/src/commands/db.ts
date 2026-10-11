// scripts/src/commands/db.ts
//
// Thin adapter over the Postgres domain modules. `db` owns the subcommand word so the
// three entrypoints are one command with three actions rather than three commands
// with overlapping names.

import { main as migrateMain } from '../db/migrate.ts';
import { main as seedMain } from '../db/seed.ts';
import { main as statusMain } from '../db/status.ts';
import {
  runDatabaseIntegration,
  runDatabaseTypeCommand,
  stopDevSupabaseLocal,
} from '../db/supabase_local.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';

const USAGE = [
  'Usage: db migrate (--local | --remote <staging|production> [--yes]) [--dry-run]',
  '       db status',
  '       db seed',
  '       db stop',
  '       db test:database',
  '       db types | types:check',
].join('\n');

export const dbCommand: Command = {
  name: 'db',
  summary: 'Postgres migrations, status and seed',
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
        if (rest.length > 0) {
          return fail(`Unexpected arguments for db ${subcommand}.\n${USAGE}`, EXIT.usage);
        }
        return runDatabaseIntegration();
      case 'types':
        if (rest.length > 0) {
          return fail(`Unexpected arguments for db ${subcommand}.\n${USAGE}`, EXIT.usage);
        }
        return runDatabaseTypeCommand('db:types');
      case 'types:check':
        if (rest.length > 0) {
          return fail(`Unexpected arguments for db ${subcommand}.\n${USAGE}`, EXIT.usage);
        }
        return runDatabaseTypeCommand('db:types:check');
      case 'stop':
        if (rest.length > 0) {
          return fail(`Unexpected arguments for db ${subcommand}.\n${USAGE}`, EXIT.usage);
        }
        // The counterpart to a stack `bun run dev` reused: a run that adopts a
        // database does not stop it, so something has to say when it should go.
        return stopDevSupabaseLocal().then(
          (outcome) => {
            if (!outcome.stopped) {
              return fail(outcome.message, EXIT.refused);
            }
            process.stdout.write(`${outcome.message}\n`);
            return EXIT.ok;
          },
          (error: unknown) =>
            fail(
              `The local development database did not stop: ${
                error instanceof Error ? error.message : String(error)
              }`,
              EXIT.failed,
            ),
        );
      default:
        return fail(`Unknown db subcommand "${subcommand}".\n${USAGE}`, EXIT.usage);
    }
  },
};
