// scripts/src/commands/configure.ts
//
// Thin adapter for reading and completing the Cloudflare deployment
// configuration. The work is in `../deploy/configure.ts`.
//
// `--provision` is the only step here that creates a remote resource, so it is
// an explicit operation rather than something reached by default. A read-only
// check must never provision as a side effect.

import { main as configureMain } from '../deploy/configure.ts';
import { type Command, EXIT, wantsHelp } from '../shared/command.ts';

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

    const code = configureMain(argv);
    if (code === 0) {
      return EXIT.ok;
    }

    // Absence is reported as its own code so a job can tell "not configured yet,
    // which is expected in the template" from "the thing I asked for did not
    // work". `--check` and `--dry-run` report absence; `--provision` does not —
    // it was asked to create a resource and failed, which is a failure. Mapping
    // both to `unavailable` told a CI job that a failed provision was a missing
    // prerequisite, and "unavailable" is the code that means "not my fault, retry
    // later".
    const reportingAbsence = argv.includes('--check') || argv.includes('--dry-run');
    return reportingAbsence ? EXIT.unavailable : EXIT.failed;
  },
};
