// scripts/src/commands/setup.ts
//
// `setup` and `doctor` are separate commands rather than one command with a
// `--doctor` flag, because they are invoked from different places: directory
// activation runs setup, and a person runs doctor when something is wrong. The
// implementation is shared either way.

import { type Command, EXIT, wantsHelp } from '../shared/command.ts';
import { inspect, renderReport, runSetup } from '../setup/setup.ts';

const SETUP_USAGE = [
  'Usage: setup',
  '',
  'Idempotent. Prepares dependencies, local defaults and the Playwright browsers',
  'matching the locked version. Safe to run repeatedly, and cheap on a warm',
  'checkout because readiness is cached by lockfile, config and tool versions.',
].join('\n');

const DOCTOR_USAGE = [
  'Usage: doctor',
  '',
  'Tests capabilities and versions rather than command existence: each check runs',
  'the tool and reads what it reports.',
].join('\n');

export const setupCommand: Command = {
  name: 'setup',
  summary: 'prepare this checkout (idempotent)',
  usage: SETUP_USAGE,

  run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${SETUP_USAGE}\n`);
      return EXIT.ok;
    }
    return runSetup();
  },
};

export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'check capabilities and versions',
  usage: DOCTOR_USAGE,

  run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${DOCTOR_USAGE}\n`);
      return EXIT.ok;
    }

    const report = inspect();
    process.stdout.write(`${renderReport(report)}\n`);

    if (!report.ok) {
      process.stderr.write(`\nMissing required capabilities: ${report.missingRequired.join(', ')}\n`);
      for (const check of report.checks) {
        if (!check.ok && check.remedy) {
          process.stderr.write(`  ${check.name}: ${check.remedy}\n`);
        }
      }
    }

    return report.ok ? EXIT.ok : EXIT.failed;
  },
};