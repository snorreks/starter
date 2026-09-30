// scripts/src/commands/ci.ts
//
// Renders check results as a GitHub step summary and writes the evidence file.
//
// Deliberately small. It takes a result list and prints it; the caller decides
// what the exit code means. It exists so a lane that was skipped is visibly not a
// pass, which is the failure mode this repository cares about most.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';
import { type CheckResult, renderSummary } from '../ci/report.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { join } from 'node:path';

const USAGE = 'Usage: ci <results.json> [--out <path>]';

export const ciCommand: Command = {
  name: 'ci',
  summary: 'render check results as a step summary',
  usage: USAGE,

  run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }

    const outIndex = argv.indexOf('--out');
    const positional = argv.filter((_arg, index) => index !== outIndex && index !== outIndex + 1);
    const input = positional[0];

    if (input === undefined) {
      return fail(USAGE, EXIT.usage);
    }

    let results: CheckResult[];
    try {
      results = JSON.parse(readFileSync(input, 'utf8')) as CheckResult[];
    } catch (error) {
      return fail(`could not read ${input}: ${String(error)}`, EXIT.failed);
    }

    const summary = renderSummary(results);

    const destination = outIndex === -1 ? undefined : argv[outIndex + 1];
    if (destination !== undefined) {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, `${summary}\n`);
    } else {
      mkdirSync(join(REPO_ROOT, '.evidence'), { recursive: true });
      writeFileSync(join(REPO_ROOT, '.evidence/verification.md'), `${summary}\n`);
    }

    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummary !== undefined && stepSummary !== '') {
      writeFileSync(stepSummary, `${summary}\n`, { flag: 'a' });
    }

    process.stdout.write(`${summary}\n`);

    const notClean = results.some((r) => r.status === 'blocked' || r.status === 'failed');
    return notClean ? EXIT.failed : EXIT.ok;
  },
};
