// scripts/src/commands/guard.ts

import { type Command, EXIT, wantsHelp } from '../shared/command.ts';
import { main as guardsMain } from '../guards/run_guards.ts';

const USAGE = [
  'Usage: guard [--only <guard-id>] [--json]',
  '',
  'Whole-repository invariants with an empty baseline. No waiver file: a guard that',
  'fails is a defect to fix, not debt to record.',
].join('\n');

export const guardCommand: Command = {
  name: 'guard',
  summary: 'whole-repository invariants',
  usage: USAGE,

  run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }
    return guardsMain(argv);
  },
};