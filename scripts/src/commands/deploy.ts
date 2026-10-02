// scripts/src/commands/deploy.ts
//
// Thin adapter: argv, phase routing, exit code. The work is in
// `../deploy/deploy.ts` and the domain modules it composes.
//
// `main` is async because two phases do real I/O (`preflight` talks to the
// provider, `verify` fetches the release) and the adapter must await it rather
// than wrap it in an `await`-and-forget that would return before the work ran.

import { main, usageText } from '../deploy/deploy.ts';
import { type Command, EXIT, wantsHelp } from '../shared/command.ts';

export const deployCommand: Command = {
  name: 'deploy',
  summary: 'plan, preflight, apply, verify or report the Cloudflare deployment',
  usage: 'deploy <plan|preflight|apply|verify|status> [--env staging|production] [--yes]',

  async run(argv) {
    if (argv.length === 0 && wantsHelp(argv)) {
      process.stdout.write(`${usageText()}\n`);
      return EXIT.ok;
    }

    return main(argv);
  },
};
