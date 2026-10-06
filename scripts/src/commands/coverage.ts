// scripts/src/commands/coverage.ts

import { runCoverage } from '../coverage/coverage.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';

const USAGE = [
  'Usage: coverage [--no-run]',
  '',
  'One coverage number for the credential-free unit lane.',
  '',
  'Runs every project`s test task with Bun`s lcov reporter, merges the reports',
  'into coverage/lcov.info and prints the totals. Branch coverage is not reported:',
  'Bun emits no BRDA records.',
  '',
  '  --no-run   Merge the reports already on disk instead of running the lane.',
  '             Use this to re-render a number without spending the test run.',
  '',
  'The number covers the projects that reported, and every workspace package that',
  'did not is named in the output. It reports and never gates: no threshold is',
  'checked.',
].join('\n');

export const coverageCommand: Command = {
  name: 'coverage',
  summary: 'merged coverage for the unit lane',
  usage: USAGE,

  async run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }

    const known = new Set(['--no-run', '--help', '-h']);
    const unknown = argv.filter((arg) => !known.has(arg));
    if (unknown.length > 0) {
      return fail(`Unknown flag "${unknown[0]}".\n\n${USAGE}`, EXIT.usage);
    }

    const { code } = await runCoverage({ runTests: !argv.includes('--no-run') });
    return code;
  },
};
