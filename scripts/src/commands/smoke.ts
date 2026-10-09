// scripts/src/commands/smoke.ts

import type { Command } from '../shared/command.ts';
import { EXIT, fail, wantsHelp } from '../shared/command.ts';
import { runTemplateSmoke } from '../smoke/template_smoke.ts';

const USAGE = `smoke [--keep] [--steps <n>] [--without-heavy]

Rehearses a fresh checkout of this template in a temporary directory: no .git, no
node_modules, no build output, no local state, no credential. Installs with a
frozen lockfile, runs setup, verifies fresh local Supabase, builds, checks the
artifact, typechecks, lints and runs the whole-repository guards.

  --keep            leave the temporary checkout on disk and print its path
  --steps <n>       run only the first n steps (used to keep the unit suite quick)
  --without-heavy   delete the native and compute examples from the COPY first, then
                    rehearse the web half. This repository ships both; the flag
                    answers what a downstream project that keeps only the web app
                    gets. It never touches this checkout.

Identity references are reported, not rewritten. The rename is a deliberate,
documented operation — see docs/rename-checklist.md.`;

const run = async (args: readonly string[]): Promise<number> => {
  if (wantsHelp(args)) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }

  const unknown = args.filter(
    (arg) =>
      arg !== '--keep' &&
      arg !== '--without-heavy' &&
      !/^--steps(=\d+)?$/.test(arg) &&
      !/^\d+$/.test(arg),
  );
  if (unknown.length > 0) {
    return fail(`unknown option(s): ${unknown.join(', ')}\n\n${USAGE}`, EXIT.usage);
  }

  // `--steps` takes a positive integer, in three spellings. Every one of them is
  // validated before the rehearsal starts, because the failure mode is the whole
  // point of the command:
  //
  //   `--steps=0`     ran `plan.slice(0, 0)`, executed nothing, and printed `ok`
  //   `--steps`       value undefined -> NaN -> treated as "no limit": the whole run
  //   `--steps=-1`    rejected as an unknown option, by accident of the filter
  //
  // A rehearsal that reports success without executing a step is exactly the failure
  // this command exists to catch in the template, so it must not be possible here.
  const stepsArg = args.find((arg) => arg.startsWith('--steps='));
  const bareSteps = args.includes('--steps');
  const positional = args.find((arg) => /^\d+$/.test(arg));

  let maxSteps: number | undefined;
  const stepsSource = stepsArg ?? (bareSteps ? '--steps' : (positional ?? undefined));

  if (stepsSource !== undefined) {
    let raw: string;
    if (stepsSource.startsWith('--steps=')) {
      raw = stepsSource.slice('--steps='.length);
    } else if (stepsSource === '--steps') {
      // The flag with no value. Under a `??` fallback this read as "no limit",
      // which is the opposite of what it looks like it means.
      raw = '';
    } else {
      raw = stepsSource;
    }

    const parsed = Number(raw);

    if (!Number.isInteger(parsed) || parsed < 1) {
      return fail(
        `${stepsSource} needs a positive integer; ${JSON.stringify(raw)} is not one.\n` +
          '  `--steps=0` would run no step and then report ok, which is the failure\n' +
          '  this command exists to catch.\n\n' +
          USAGE,
        EXIT.usage,
      );
    }

    maxSteps = parsed;
  }

  const keep = args.includes('--keep');
  const withoutHeavy = args.includes('--without-heavy');
  const report = runTemplateSmoke({
    keep,
    withoutHeavyExamples: withoutHeavy,
    ...(maxSteps === undefined ? {} : { maxSteps }),
  });

  // What was removed, from the report — not a fixed sentence.
  //
  // It used to name four directories and two workflows unconditionally, so a
  // rehearsal that deleted nothing still claimed it had, and a reader checking the
  // claim had nothing to check against. `removed` is empty when nothing was deleted,
  // and the notice says so.
  if (withoutHeavy) {
    if (report.removed.length === 0) {
      process.stdout.write(
        '\n--without-heavy was requested but nothing was present to remove.\n' +
          '  The rehearsal that follows is therefore the ordinary one.\n',
      );
    } else {
      process.stdout.write(
        `\nRemoved from the disposable copy (${report.removed.length} path(s)):\n` +
          report.removed.map((path) => `  ${path}`).join('\n') +
          '\nThe web half is what the remaining steps prove.\n' +
          'Note the first two steps: removing a workspace makes bun.lock stale, so the\n' +
          'lockfile is regenerated and then re-checked with --frozen-lockfile.\n',
      );
    }
  }

  for (const step of report.steps) {
    const seconds = (step.durationMs / 1000).toFixed(1);
    process.stdout.write(`  ${step.ok ? 'ok   ' : 'FAIL '} ${step.step.padEnd(22)} ${seconds}s\n`);
    if (!step.ok) {
      process.stdout.write(
        `${step.detail
          .split('\n')
          .map((line) => `        ${line}`)
          .join('\n')}\n`,
      );
    }
  }

  if (report.identityReferences.length > 0) {
    process.stdout.write(
      `\n${report.identityReferences.length} committed reference(s) to the template identity, outside the files that document the rename:\n` +
        report.identityReferences.map((ref) => `  ${ref}`).join('\n') +
        '\n  These are the places docs/rename-checklist.md has to keep true.\n',
    );
  }

  if (!report.ok) {
    // The temporary checkout is gone unless it was asked for. Printing a path that
    // no longer exists is worse than saying nothing about it.
    if (keep) {
      process.stdout.write(`\nTemporary checkout kept at ${report.dir}\n`);
    } else {
      process.stderr.write(
        '\nThe temporary checkout was removed. Re-run with --keep to inspect it.\n',
      );
    }
  }

  process.stdout.write(`\n${report.ok ? 'ok' : 'FAILED'}\n`);
  return report.ok ? EXIT.ok : EXIT.failed;
};

export const smokeCommand: Command = {
  name: 'smoke',
  summary: 'Rehearse a fresh checkout of this template with no credentials and no prior state',
  usage: USAGE,
  run,
};
