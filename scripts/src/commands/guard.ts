// scripts/src/commands/guard.ts

import { main as guardsMain } from '../guards/run_guards.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';

const USAGE = [
  'Usage: guard [--only <guard-id>] [--root <dir>] [--json]',
  '',
  'Whole-repository invariants with an empty baseline. No waiver file: a guard that',
  'fails is a defect to fix, not debt to record.',
  '',
  '  --only <guard-id>   Run one guard instead of all of them.',
  "  --root <dir>        Scan <dir> instead of this repository. The guard's own",
  '                     tests use this to run the real command against a',
  '                     disposable fixture tree, so the command and the exit',
  '                     status are under test and not just the rule.',
  '  --json              Machine-readable output.',
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
    const onlyIndex = argv.indexOf('--only');
    const rootIndex = argv.indexOf('--root');
    const known = new Set(['--only', '--root', '--json', '--whole-repo', '--help', '-h']);

    // `--only`'s and `--root`'s operands are values, not flags. Checking them would
    // report every valid `--only architecture` as an unknown flag. `-1` when the flag
    // is absent, so no real index is skipped.
    const operandIndexes = [onlyIndex + 1, rootIndex + 1].filter((index) => index > 0);
    const unknown = argv.filter((arg, index) => !known.has(arg) && !operandIndexes.includes(index));

    if (unknown.length > 0) {
      return fail(`Unknown flag "${unknown[0]}".\n\n${USAGE}`, EXIT.usage);
    }
    if (onlyIndex !== -1 && startsWithDash(argv[onlyIndex + 1])) {
      return fail(`--only needs a guard id.\n\n${USAGE}`, EXIT.usage);
    }
    if (rootIndex !== -1 && startsWithDash(argv[rootIndex + 1])) {
      return fail(`--root needs a directory.\n\n${USAGE}`, EXIT.usage);
    }

    // `--whole-repo` is accepted here rather than passed through silently: it was the
    // old narrower scope, and `guard` already runs every guard over every project.
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

const startsWithDash = (value: string | undefined): boolean =>
  value === undefined || value.startsWith('-');
