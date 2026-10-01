// scripts/src/commands/dev.ts
//
// Thin adapter for the local development processes.
//
// `dev api` is the only implementation of "run the Worker locally". There used
// to be two: this module and `apps/backend/api/scripts/dev-worker.sh`. They
// disagreed about ports, about where the log file went, and about whether the
// child survived teardown — so a command that worked from the repository root
// failed from the API directory. One implementation, one owner.

import { main as devApiMain } from '../dev-api.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';

const USAGE = [
  'Usage: dev api',
  '',
  'Runs the Worker on API_PORT (default 8787) and captures its log stream to',
  '.wrangler/logs/api.ndjson inside this checkout.',
  '',
  'State is per-checkout, so two worktrees on one machine run independently. The',
  "child's exit status is this command's exit status, and signals are forwarded,",
  'so a caller that starts and stops the server gets a truthful result.',
].join('\n');

export const devCommand: Command = {
  name: 'dev',
  summary: 'run a local development process',
  usage: USAGE,

  run(argv) {
    if (argv.length === 0) {
      return fail(USAGE, EXIT.usage);
    }
    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }

    const [target] = argv;
    if (target !== 'api') {
      return fail(`Unknown dev target "${target}".\n${USAGE}`, EXIT.usage);
    }
    return devApiMain();
  },
};
