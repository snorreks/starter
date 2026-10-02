// scripts/src/guards/run_guards.ts
//
//   bun run guard             # every guard
//   bun run guard -- --json   # machine-readable
//   bun run guard -- --only architecture
//   bun run guard -- --root /tmp/a-fixture-tree
//
// Runs in a few seconds across the whole repository.
//
// Every guard is a hard invariant with an empty baseline. There is no waiver
// file and no ledger: the architecture is new, so there is no pre-existing debt
// to record, and a baseline that starts non-empty is a place for the next
// failure to hide.

import { resolve as resolvePath } from 'node:path';
import { ALL_GUARDS, type GuardResult, REPO_ROOT } from './boundary.ts';

export interface GuardReport {
  passed: boolean;
  total: number;
  failing: number;
  guards: GuardResult[];
}

export interface GuardSelection {
  readonly only?: string;
  /** Repository root to scan. Defaults to the repository this file lives in. */
  readonly root: string;
}

/**
 * Read the flags this entrypoint understands.
 *
 * `--root` exists so the guard's own tests can invoke *this* entrypoint against a
 * disposable fixture tree rather than a function they imported themselves. That
 * distinction is the point: a test that calls `guardArchitecture(fixture)` proves the
 * rule, while a test that runs `bun run guard -- --root <fixture>` also proves the
 * command, the flag parsing and the exit status, which is what a developer actually
 * runs.
 */
export const readSelection = (args: readonly string[]): GuardSelection => {
  const rootIndex = args.indexOf('--root');
  const operand = args[rootIndex + 1];
  if (rootIndex !== -1 && (operand === undefined || operand.startsWith('-'))) {
    throw new Error('--root needs a directory.');
  }
  const root = rootIndex === -1 ? REPO_ROOT : resolvePath(operand as string);
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1];
  return only === undefined ? { root } : { only, root };
};

export const runAll = (selection: GuardSelection = { root: REPO_ROOT }): GuardReport => {
  const selected =
    selection.only === undefined
      ? ALL_GUARDS
      : ALL_GUARDS.filter((guard) => guard.id === selection.only);

  if (selected.length === 0) {
    process.stderr.write(
      `No guard named "${selection.only}". Available: ${ALL_GUARDS.map((guard) => guard.id).join(', ')}\n`,
    );
    return { passed: false, total: 0, failing: 0, guards: [] };
  }

  const guards = selected.map((guard) => guard.run(selection.root));
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
      // The rule id is printed because one guard now reports several distinct
      // invariants. Without it the reader sees a violation they cannot look up, and a
      // message that names the fix but not the rule it broke is half an answer.
      lines.push(`        ${violation.file}:${violation.line}  [${violation.rule}]`);
      for (const line of violation.message.split('\n')) {
        lines.push(`          ${line}`);
      }
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
  const report = runAll(readSelection(args));

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(report)}\n`);
  }

  return report.passed ? 0 : 1;
};
