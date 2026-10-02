// scripts/src/commands/workflows.ts

import { auditWorkflows } from '../ci/workflow_policy.ts';
import type { Command } from '../shared/command.ts';
import { EXIT, fail, wantsHelp } from '../shared/command.ts';

const USAGE = `workflows [--json]

Checks .github/workflows/*.yml against the properties this repository's CI depends
on: declared permissions, a bounded job, an action pinned to a commit SHA, and no
credential in a workflow that runs pull-request code.

  bun run workflows          # human report, nonzero on any finding
  bun run workflows --json   # machine-readable`;

const run = async (args: readonly string[]): Promise<number> => {
  if (wantsHelp(args)) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }

  const json = args.includes('--json');
  const report = auditWorkflows();

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.findings.length === 0 ? EXIT.ok : EXIT.failed;
  }

  if (report.checked.length === 0) {
    return fail(
      'no workflow files were found, so nothing was checked.\n' +
        '  A repository with no CI reports success on every push.',
      EXIT.failed,
    );
  }

  for (const name of report.checked) {
    const own = report.findings.filter((finding) => finding.workflow === name);
    process.stdout.write(
      own.length === 0
        ? `  ok    ${name}\n`
        : `  FAIL  ${name}\n${own.map((finding) => `          ${finding.rule}: ${finding.detail}`).join('\n')}\n`,
    );
  }

  process.stdout.write(
    `\n${report.findings.length === 0 ? 'ok' : `${report.findings.length} finding(s)`} across ${report.checked.length} workflow(s).\n`,
  );

  return report.findings.length === 0 ? EXIT.ok : EXIT.failed;
};

export const workflowsCommand: Command = {
  name: 'workflows',
  summary: 'Check the CI workflows for unpinned actions, unbounded jobs and stray credentials',
  usage: USAGE,
  run,
};
