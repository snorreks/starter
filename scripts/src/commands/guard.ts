// scripts/src/commands/guard.ts

import { main as guardsMain } from '../guards/run_guards.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';

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

    // `guardsMain` reads the flags it knows and ignores the rest, so an unknown
    // flag used to run the *default* guards and exit 0 or 1 as if it had been
    // understood. A typo in a guard invocation then reads as "the guards ran" —
    // which is the one thing a guard command must never imply when it did not.
    // `--whole-repo` is accepted here rather than passed through silently.
    const onlyIndex = argv.indexOf('--only');
    const operand = onlyIndex === -1 ? undefined : argv[onlyIndex + 1];
    const known = new Set(['--only', '--json', '--whole-repo', '--help', '-h']);
    // Skip `--only`'s operand: it is a guard id, not a flag, so checking it would
    // report every valid `--only workspace-boundary` as an unknown flag. `-1` when
    // there is no `--only`, so no real index is skipped.
    const operandIndex = onlyIndex === -1 ? -1 : onlyIndex + 1;

    const unknown = argv.filter((arg, index) => !known.has(arg) && index !== operandIndex);

    if (unknown.length > 0) {
      return fail(`Unknown flag "${unknown[0]}".\n\n${USAGE}`, EXIT.usage);
    }
    if (onlyIndex !== -1 && (operand === undefined || operand.startsWith('-'))) {
      return fail(`--only needs a guard id.\n\n${USAGE}`, EXIT.usage);
    }

    // Accepted by this command rather than forwarded: `guardsMain` has no such
    // mode, so it was being ignored while the caller believed the scope changed.
    const forwarded = argv.filter((arg) => arg !== '--whole-repo');

    if (argv.includes('--whole-repo')) {
      process.stderr.write(
        'Whole-repository guards are now the default: there is no narrower scope ' +
          'left to select, and `guard` already runs every guard over every project.\n',
      );
    }

    return guardsMain(forwarded);
  },
};
