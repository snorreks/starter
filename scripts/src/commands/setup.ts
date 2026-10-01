// scripts/src/commands/setup.ts
//
// `setup` and `doctor` are separate commands rather than one command with a
// `--doctor` flag, because they are invoked from different places: directory
// activation runs setup, and a person runs doctor when something is wrong. The
// implementation is shared either way.

import { inspect, renderReport, runSetup } from '../setup/setup.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';

const SETUP_USAGE = [
  'Usage: setup [--force] [--quiet]',
  '',
  'Idempotent. Prepares dependencies, local defaults and the Playwright browsers',
  'matching the locked version. Safe to run repeatedly, and cheap on a warm',
  'checkout because readiness is cached by lockfile, config and tool versions.',
  '',
  '  --force  re-run the steps a warm checkout would skip. It does not reinstall',
  '           dependencies that are already present.',
  '  --quiet  suppress progress output.',
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
    // Forwarded: the usage above documents `--force` and `--quiet`, and they did
    // not reach `runSetup`, so a documented flag changed nothing.
    const known = new Set(['--force', '--quiet']);
    const unknown = argv.filter((arg) => !known.has(arg));

    if (unknown.length > 0) {
      return fail(`Unknown flag "${unknown[0]}".\n\n${SETUP_USAGE}`, EXIT.usage);
    }

    return runSetup(argv);
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
      process.stderr.write(
        `\nMissing required capabilities: ${report.missingRequired.join(', ')}\n`,
      );
      for (const check of report.checks) {
        if (!check.ok && check.remedy) {
          process.stderr.write(`  ${check.name}: ${check.remedy}\n`);
        }
      }
    }

    return report.ok ? EXIT.ok : EXIT.failed;
  },
};
