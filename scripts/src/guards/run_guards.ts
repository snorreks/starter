// scripts/src/guards/run_guards.ts
//
//   bun run guard             # every guard
//   bun run guard -- --json   # machine-readable
//   bun run guard -- --profile   # per-guard elapsed time
//   bun run guard -- --only architecture
//   bun run guard -- --root /tmp/a-fixture-tree
//
// Runs in about a second and a half across the whole repository on the machine this
// was measured on, and the number is printed rather than asserted: see
// `scripts/tests/new_roots_guards.test.ts` and the timing note in docs/lint.md.
//
// Every guard is a hard invariant with an empty baseline. There is no waiver
// file and no ledger: the architecture is new, so there is no pre-existing debt
// to record, and a baseline that starts non-empty is a place for the next
// failure to hide.
//
// Nothing here is cached, deliberately. A guard result that is read from a cache is
// only as fresh as the cache key, and this one reads the whole repository through a
// parser — so a key that forgot a tsconfig `paths` change, an `exports` entry or an
// alias would silently certify a tree nobody checked. Measured at a second or two
// against a static lane that already spends minutes on typecheck and lint, there is
// nothing here to buy.

import { resolve as resolvePath } from 'node:path';
import { ALL_GUARDS, type GuardResult, REPO_ROOT } from './boundary.ts';

export interface GuardTiming {
  readonly id: string;
  readonly ms: number;
}

export interface GuardReport {
  passed: boolean;
  total: number;
  failing: number;
  guards: GuardResult[];
  /** Wall time per guard. Always collected; `--profile` is what prints it. */
  timings: GuardTiming[];
}

export interface GuardSelection {
  readonly only?: string;
  /** Repository root to scan. Defaults to the repository this file lives in. */
  readonly root: string;
  /** Print per-guard elapsed time after the report. */
  readonly profile: boolean;
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
  const profile = args.includes('--profile');
  return only === undefined ? { profile, root } : { only, profile, root };
};

export const runAll = (
  selection: GuardSelection = { profile: false, root: REPO_ROOT },
): GuardReport => {
  const selected =
    selection.only === undefined
      ? ALL_GUARDS
      : ALL_GUARDS.filter((guard) => guard.id === selection.only);

  if (selected.length === 0) {
    process.stderr.write(
      `No guard named "${selection.only}". Available: ${ALL_GUARDS.map((guard) => guard.id).join(', ')}\n`,
    );
    return { passed: false, total: 0, failing: 0, guards: [], timings: [] };
  }

  const guards: GuardResult[] = [];
  const timings: GuardTiming[] = [];
  for (const guard of selected) {
    const started = performance.now();
    guards.push(guard.run(selection.root));
    timings.push({ id: guard.id, ms: performance.now() - started });
  }
  const failing = guards.filter((guard) => guard.violations.length > 0).length;

  return { passed: failing === 0, total: guards.length, failing, guards, timings };
};

const render = (report: GuardReport, profile: boolean): string => {
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

  if (profile) {
    const total = report.timings.reduce((sum, timing) => sum + timing.ms, 0);
    lines.push('');
    lines.push('  elapsed, per guard:');
    for (const timing of [...report.timings].sort((a, b) => b.ms - a.ms)) {
      lines.push(`    ${timing.ms.toFixed(0).padStart(6)} ms  ${timing.id}`);
    }
    lines.push(`    ${total.toFixed(0).padStart(6)} ms  total`);
  }

  return lines.join('\n');
};

export const main = (args: readonly string[]): number => {
  const selection = readSelection(args);
  const report = runAll(selection);

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(report, selection.profile)}\n`);
  }

  return report.passed ? 0 : 1;
};
