// scripts/src/commands/stripe.ts
//
// `bun run stripe:setup` — declare the catalogue in a Stripe account.
//
// Reads `@starter/billing` and reconciles. Two things this command will not do,
// both stated in its own output:
//
//   * **Write to a `.env` file.** The previous generation of this command wrote a
//     webhook secret into `.env.local` with a string replace. That file is
//     read by every tool in the tree, is not the file the Worker reads, and is
//     not protected the way a run-owned 0600 file is. This command resolves ids
//     and prints them; where a secret belongs is the deployment's decision, made
//     through the deployment's channel.
//   * **Report success against an emulator.** stripe-mock accepts writes and keeps
//     nothing, so "created 5 objects" against it would be true of the API calls
//     and false of the account. When the target is local this says so in the
//     summary line rather than leaving it to be discovered later.

import { readFileSync } from 'node:fs';
import { STRIPE_MOCK_LIMITS } from '../local/stripe_service.ts';
import {
  type StripeCredentials,
  syncStripeCatalog,
  syncWebhookEndpoint,
} from '../setup/stripe_catalog.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';

const USAGE = [
  'Usage: stripe setup [--dry-run] [--webhook-url <https url>] [--yes]',
  '',
  'Declares every product and price in @starter/billing as a Stripe object.',
  'Idempotent: an object that already matches is left alone, and a price whose',
  'amount changed is rolled forward rather than edited, because Stripe prices are',
  'immutable and editing one would keep billing the old amount.',
  '',
  'Targets, in resolution order:',
  '  1. STRIPE_API_BASE + STRIPE_SECRET_KEY in the environment',
  '  2. the same two in STARTER_DEV_VARS_PATH, which `bun run dev --stack stripe`',
  '     writes — so `bun run dev --stack stripe` in one terminal and this in',
  '     another provision the emulator together',
  '',
  'The secret key is read from a variable or a 0600 file and sent in a header. It',
  'is never an argument, never printed, and never written back to disk.',
  '',
  'Options:',
  '  --dry-run           read only; report what would change and mutate nothing',
  '  --webhook-url URL   also reconcile the webhook endpoint at this URL',
  '  --yes               accepted for symmetry with the other mutating commands;',
  '                      this command has no prompts, because a plan that needs',
  '                      confirmation is `bun run stripe:setup -- --dry-run`',
].join('\n');

/** Read `KEY=value` from a dotenv file without pulling in a dependency for it. */
const readVarsFile = (path: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) {
      // Values are JSON-encoded by `writeOwnedVars`, so a URL with a query string
      // survives the round trip instead of being truncated at the first `&`.
      try {
        out[match[1] as string] = JSON.parse(match[2] as string) as string;
      } catch {
        out[match[1] as string] = match[2] as string;
      }
    }
  }
  return out;
};

const resolveCredentials = (): StripeCredentials | { problem: string; remedy: string } => {
  const fromFile =
    process.env.STARTER_DEV_VARS_PATH === undefined
      ? {}
      : readVarsFile(process.env.STARTER_DEV_VARS_PATH);

  const apiBase = (process.env.STRIPE_API_BASE ?? fromFile.STRIPE_API_BASE ?? '').trim();
  const secretKey = (process.env.STRIPE_SECRET_KEY ?? fromFile.STRIPE_SECRET_KEY ?? '').trim();

  if (apiBase.length === 0 || secretKey.length === 0) {
    return {
      problem: 'No Stripe target is configured.',
      remedy:
        '  Local:    bun run dev --stack stripe    (then re-run this in another terminal)\n' +
        '  Real:     export STRIPE_API_BASE=https://api.stripe.com\n' +
        '            export STRIPE_SECRET_KEY=sk_test_…\n' +
        '            bun run setup:secrets           to place it through the supported channel',
    };
  }
  return { apiBase, secretKey };
};

const ICON: Record<string, string> = {
  created: '+',
  updated: '~',
  unchanged: '=',
  skipped: '-',
  failed: 'x',
};

export const stripeCommand: Command = {
  name: 'stripe',
  summary: 'provision the Stripe catalogue, or report what it would do',
  usage: USAGE,

  async run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }

    // The subcommand word, matching every other command in this dispatcher
    // (`deploy plan`, `db migrate`). Accepted and skipped rather than required, so
    // `bun run stripe:setup` and `bun run scripts -- stripe setup` are the same
    // command reached the same way.
    const rest = argv[0] === 'setup' ? argv.slice(1) : argv;

    let dryRun = false;
    let webhookUrl: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index] as string;
      if (arg === '--dry-run' || arg === '-n') {
        dryRun = true;
        continue;
      }
      if (arg === '--yes' || arg === '-y') {
        continue;
      }
      if (arg === '--webhook-url') {
        webhookUrl = rest[index + 1];
        index += 1;
        continue;
      }
      if (arg.startsWith('--webhook-url=')) {
        webhookUrl = arg.slice('--webhook-url='.length);
        continue;
      }
      return fail(`Unknown option "${arg}".\n${USAGE}`, EXIT.usage);
    }

    const credentials = resolveCredentials();
    if ('problem' in credentials) {
      return fail(`${credentials.problem}\n  ${credentials.remedy}`, EXIT.unavailable);
    }

    process.stdout.write(
      `Stripe catalogue sync${dryRun ? ' (dry run — nothing will be written)' : ''}\n` +
        `  target ${credentials.apiBase}\n\n`,
    );

    const report = await syncStripeCatalog(credentials, { dryRun });
    for (const outcome of report.outcomes) {
      const detail = 'reason' in outcome ? outcome.reason : outcome.id;
      process.stdout.write(`  [${ICON[outcome.action] ?? '?'}] ${outcome.name} — ${detail}\n`);
    }

    if (webhookUrl !== undefined) {
      const endpoint = await syncWebhookEndpoint(credentials, { url: webhookUrl, dryRun });
      process.stdout.write(
        `  [${ICON[endpoint.action] ?? '?'}] ${'name' in endpoint ? endpoint.name : ''} — ${
          'reason' in endpoint ? endpoint.reason : endpoint.id
        }\n`,
      );
    }

    const failures = report.outcomes.filter((outcome) => outcome.action === 'failed');
    const created = report.outcomes.filter((outcome) => outcome.action === 'created').length;

    process.stdout.write('\n');
    if (report.emulated) {
      process.stdout.write(
        'Target is a local emulator. The API calls above succeeded, but stripe-mock keeps\n' +
          'nothing, so no Stripe object exists as a result of this run.\n' +
          `${STRIPE_MOCK_LIMITS.map((limit) => `  ${limit}\n`).join('')}` +
          'Run against a real test account to provision anything.\n',
      );
    } else if (dryRun) {
      process.stdout.write('Dry run complete. Nothing was written.\n');
    } else if (failures.length > 0) {
      process.stdout.write(
        `Incomplete: ${failures.length} of ${report.outcomes.length} objects failed. Re-run to finish; ` +
          'objects already created are recognised and left alone.\n',
      );
    } else {
      process.stdout.write(
        created === 0
          ? 'Catalogue already matches Stripe; nothing changed.\n'
          : `Catalogue declared: ${created} object(s) created or rolled forward.\n`,
      );
    }

    // Exit code, and the reason for it.
    //
    // A dry run did reads and reported: `ok`. A real run against a real account
    // provisioned or reconciled: `ok` when every object landed. A real run against
    // the emulator provisioned *nothing durable*, so it is refused — exit 4, "this
    // will not work, here is why, and here is what to do instead" — rather than
    // exiting 0 having achieved nothing. That distinction is the whole reason
    // `EXIT.refused` exists separately from `EXIT.failed`.
    if (report.emulated && !dryRun) {
      return EXIT.refused;
    }
    return report.ok ? EXIT.ok : EXIT.failed;
  },
};
