// scripts/src/lib/guards/run_guards.ts
//
//   bun run guard             # every guard
//   bun run guard -- --json   # machine-readable
//   bun run guard -- --only workspace-boundary
//
// Runs in about a second across the whole repository, with no dependencies.
//
// Every guard is a hard invariant with an empty baseline. There is no waiver
// file and no ledger: the architecture is new, so there is no pre-existing debt
// to record, and a baseline that starts non-empty is a place for the next
// failure to hide.

import { ALL_GUARDS, type GuardResult, REPO_ROOT } from './boundary.ts';

export type GuardReport = {
  passed: boolean;
  total: number;
  failing: number;
  guards: GuardResult[];
};

export const runAll = (only?: string): GuardReport => {
  const selected =
    only === undefined ? ALL_GUARDS : ALL_GUARDS.filter((guard) => guard.id === only);

  if (selected.length === 0) {
    process.stderr.write(
      `No guard named "${only}". Available: ${ALL_GUARDS.map((guard) => guard.id).join(', ')}\n`,
    );
    return { passed: false, total: 0, failing: 0, guards: [] };
  }

  const guards = selected.map((guard) => guard.run(REPO_ROOT));
  const failing = guards.filter((guard) => guard.violations.length > 0).length;

  return { passed: failing === 0, total: guards.length, failing, guards };
};

const render = (report: GuardReport): string => {
  const lines: string[] = [];

  for (const guard of report.guards) {
    if (guard.violations.length === 0) {
      lines.push(`  ok    ${guard.label} (${guard.id})`);
      continue;
    }
    lines.push(`  FAIL  ${guard.label} (${guard.id}) — ${guard.violations.length} violation(s)`);
    for (const violation of guard.violations) {
      lines.push(`        ${violation.file}:${violation.line}`);
      lines.push(`          ${violation.message}`);
    }
  }

  lines.push('');
  lines.push(
    report.passed
      ? `${report.total} guard(s) passed.`
      : `${report.failing} of ${report.total} guard(s) failed.`,
  );
  return lines.join('\n');
};

export const main = (args: readonly string[]): number => {
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1];
  const report = runAll(only);

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(report)}\n`);
  }

  return report.passed ? 0 : 1;
};

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
