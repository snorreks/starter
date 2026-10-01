// scripts/src/secrets/secrets.ts
//
//   bun run secrets:doctor                        # what is installed and configured
//   bun run secrets:init -- age1...               # write .sops.yaml
//   bun run secrets:encrypt -- <file>...          # encrypt in place
//   bun run secrets:decrypt -- <file> [--out p]   # decrypt to stdout or a file
//   bun run secrets:exec --env K=<ct> -- <cmd>    # run with secrets in the env
//   bun run secrets:update-recipients -- age1...  # add a person
//
// A generic secret workflow with **no inherited configuration**. The source project
// shipped a `.sops.yaml` naming two specific age recipients and two files of
// ciphertext for a different project; both are gone. Recipients identify people, not
// projects, so nothing here is committed that names one.
//
// Every operation runs the real `sops` binary and reports *its* exit status. The
// refusal that used to stand here — "NOT IMPLEMENTED, exit 3" — was correct and
// incomplete; the operation that replaced it refuses for real reasons (no recipient,
// tracked output path, wrong usage) and names which one applied.

import { existsSync } from 'node:fs';
import { REPO_ROOT } from '../shared/paths.ts';
import {
  decryptFile,
  EXIT,
  encryptFile,
  execWithSecrets,
  initConfig,
  isGitIgnored,
  probeTools,
  readRecipients,
  SOPS_CONFIG,
  updateRecipients,
} from './sops.ts';

export { EXIT, SOPS_CONFIG };

export interface SecretsReport {
  sopsAvailable: boolean;
  ageAvailable: boolean;
  configured: boolean;
  recipients: number;
  problems: string[];
  nextSteps: string[];
}

export const inspectSecrets = (): SecretsReport => {
  const problems: string[] = [];
  const nextSteps: string[] = [];

  const tools = probeTools();

  if (!tools.sops) {
    problems.push('sops is not installed, or does not run. Secret encryption needs it.');
    nextSteps.push('Install sops: https://github.com/getsops/sops');
  }
  if (!tools.age) {
    problems.push('age is not installed, or does not run. sops needs it for age recipients.');
    nextSteps.push('Install age: https://github.com/FiloSottile/age');
  }

  const configured = existsSync(SOPS_CONFIG);
  const recipients = readRecipients(SOPS_CONFIG);

  if (configured && recipients.length === 0) {
    problems.push(
      '.sops.yaml exists but names no age recipient. Encryption would produce ' +
        'a file nobody can decrypt.',
    );
    nextSteps.push('Add your own public key: bun run secrets:update-recipients -- age1...');
  } else if (!configured) {
    // Not an error: this is the state of a fresh clone, and saying so is more useful
    // than refusing. It *is* a problem for `encrypt`, which checks separately.
    problems.push(
      'No .sops.yaml. Expected in a fresh clone: recipients are project-specific and ' +
        'must not be inherited.',
    );
    nextSteps.push('bun run secrets:init -- age1...   (after: age-keygen -o .age/key.txt)');
  }

  return {
    sopsAvailable: tools.sops,
    ageAvailable: tools.age,
    configured,
    recipients: recipients.length,
    problems,
    nextSteps,
  };
};

const USAGE = [
  'Usage:',
  '  bun run secrets:doctor                        report what is installed',
  '  bun run secrets:init -- age1...               write .sops.yaml',
  '  bun run secrets:encrypt -- <file>...          encrypt in place',
  '  bun run secrets:decrypt -- <file> [--out p]   decrypt to stdout or a gitignored path',
  '  bun run secrets:exec --env KEY=<ct> -- <cmd>  run a command with secrets in its env',
  '  bun run secrets:update-recipients -- age1...  add a recipient, keeping the existing ones',
].join('\n');

/** Everything after a bare `--`, which is what a wrapped command receives. */
const afterDoubleDash = (args: readonly string[]): string[] => {
  const index = args.indexOf('--');
  return index === -1 ? [] : args.slice(index + 1);
};

/** Positional arguments, skipping flags and the values they consume. */
const positional = (args: readonly string[]): string[] => {
  const out: string[] = [];
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === '--out' || arg === '--env') {
      skipNext = true;
      continue;
    }
    if (arg.startsWith('-')) {
      continue;
    }
    out.push(arg);
  }

  return out;
};

/** `--env KEY=<ciphertext>` pairs. */
const envPairs = (args: readonly string[]): Record<string, string> => {
  const pairs: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--env') {
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) {
      continue;
    }
    const split = value.indexOf('=');
    if (split > 0) {
      pairs[value.slice(0, split)] = value.slice(split + 1);
    }
  }

  return pairs;
};

/**
 * Print what the operation said, and return the code *it* chose.
 *
 * The first version returned `result.ok ? EXIT.ok : EXIT.failed`, discarding the
 * code the operation had carefully computed. Every distinct outcome therefore
 * arrived at the caller as `failed` — a typo, a missing tool and a deliberate refusal
 * were indistinguishable. That is the same defect as the "not implemented" exit 3
 * this replaced, one level up: the exit code is the machine-readable part, and
 * flattening it makes a caller guess from stderr.
 */
const report = (result: { ok: boolean; code: number; stderr: string }): number => {
  if (result.stderr.trim() !== '') {
    process.stderr.write(`${result.stderr}\n`);
  }
  return result.ok ? EXIT.ok : result.code;
};

export const main = (args: readonly string[]): number => {
  const operation = positional(args)[0];
  const rest = positional(args).slice(1);
  const outIndex = args.indexOf('--out');
  const out = outIndex === -1 ? undefined : args[outIndex + 1];

  switch (operation) {
    case 'doctor':
      return doctor();

    case 'init':
      return initConfig(rest[0], REPO_ROOT);

    case 'update-recipients':
      return updateRecipients(rest, REPO_ROOT);

    case 'encrypt': {
      if (rest.length === 0) {
        process.stderr.write(
          'secrets:encrypt needs at least one file.\n' +
            '  This command never guesses a target: encrypting the wrong file commits it\n' +
            '  to your team. Usage: bun run secrets:encrypt -- .dev.vars\n' +
            '  Nothing was encrypted.\n',
        );
        return EXIT.usage;
      }
      // Every file is attempted, so one bad path does not leave the rest silently
      // unprocessed; the worst status wins, because a partial success that reports
      // success is the failure mode this command existed to end.
      // Every file is attempted, so one bad path does not silently leave the rest
      // unprocessed. The code reported is the *first* failure, not the last: with
      // several files the order the operator named them in is the order they will
      // read the output in, so the first message is the one they will act on. A
      // partial success must not report success — that is the failure this whole
      // command existed to end.
      let firstFailure: number = EXIT.ok;
      for (const path of rest) {
        const code = report(encryptFile(path, REPO_ROOT));
        if (code !== EXIT.ok && firstFailure === EXIT.ok) {
          firstFailure = code;
        }
      }
      return firstFailure;
    }

    case 'decrypt': {
      if (rest.length === 0) {
        process.stderr.write(
          'secrets:decrypt needs a file.\n' +
            '  Nothing was decrypted.\n' +
            '  Usage: bun run secrets:decrypt -- secrets/app.enc.env --out .dev.vars\n',
        );
        return EXIT.usage;
      }
      return report(decryptFile(rest[0], out, REPO_ROOT));
    }

    case 'exec':
      return report(execWithSecrets(afterDoubleDash(args), envPairs(args), REPO_ROOT));

    case 'edit': {
      // A real operation, and deliberately narrow: sops already provides `sops edit`.
      // Re-implementing it here would add a second code path to a file, so this
      // refuses and says what to run — which is the honest answer for an operation
      // that genuinely should not exist.
      process.stderr.write(
        'secrets:edit is NOT IMPLEMENTED, deliberately. sops owns editing a file in\n' +
          '  place; a wrapper here would be a second code path to the same file.\n' +
          '  Run: sops <file>\n' +
          '  Nothing was opened or changed.\n',
      );
      return EXIT.refused;
    }

    case undefined:
      return doctor();

    default:
      process.stderr.write(`Unknown operation "${operation}".\n\n${USAGE}\n`);
      return EXIT.usage;
  }
};

/** Print the report. Exits nonzero when a required prerequisite is missing. */
const doctor = (): number => {
  const state = inspectSecrets();

  process.stdout.write('Secrets\n');
  process.stdout.write(`  sops       ${state.sopsAvailable ? 'available' : 'MISSING'}\n`);
  process.stdout.write(`  age        ${state.ageAvailable ? 'available' : 'MISSING'}\n`);
  process.stdout.write(
    `  configured ${state.configured ? `yes (${state.recipients} recipient(s))` : 'no'}\n`,
  );
  process.stdout.write(
    `  gitignored ${isGitIgnored(join('.dev.vars'), REPO_ROOT) ? '.dev.vars is ignored' : '.dev.vars is TRACKED'}\n`,
  );

  for (const problem of state.problems) {
    process.stdout.write(`\n  problem: ${problem}\n`);
  }
  if (state.nextSteps.length > 0) {
    process.stdout.write('\nNext:\n');
    for (const step of state.nextSteps) {
      process.stdout.write(`  - ${step}\n`);
    }
  }

  // A missing tool is the only thing that makes the whole family unusable; an
  // unconfigured recipient is the expected state of a fresh clone.
  return state.sopsAvailable && state.ageAvailable ? EXIT.ok : EXIT.unavailable;
};

import { join } from 'node:path';
