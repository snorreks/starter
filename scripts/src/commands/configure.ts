// scripts/src/commands/configure.ts
//
// Thin adapter for reading and completing the Cloudflare deployment
// configuration. The work is in `../deploy/configure.ts`.
//
// `--provision` is the only step here that creates a remote resource, so it is
// an explicit operation rather than something reached by default. A read-only
// check must never provision as a side effect.

import { type Command, EXIT, wantsHelp } from '../shared/command.ts';
import { main as configureMain } from '../deploy/configure.ts';

const USAGE = [
  'Usage: configure [--check | --provision]',
  '',
  'No flag        report what is configured and what is missing',
  '--check        exit nonzero unless every value is present',
  '--provision    create the D1 database named in the registry (remote)',
].join('\n');

export const configureCommand: Command = {
  name: 'configure',
  summary: 'read or complete the Cloudflare deployment configuration',
  usage: USAGE,

  run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }

    // Absence is reported as its own code so a job can tell "not configured yet,
    // which is expected in the template" from "configured wrongly".
    const code = configureMain(argv);
    return code === 0 ? EXIT.ok : EXIT.unavailable;
  },
};