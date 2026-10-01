// scripts/src/secrets/index.ts
//
//   bun run secrets:encrypt -- <file>...
//   bun run secrets:decrypt -- <file>...
//   bun run setup:secrets            # doctor
//
// A generic secret workflow with **no inherited configuration**. The source
// project shipped a `.sops.yaml` naming two specific age recipients and two
// files of ciphertext for a different project; both are gone. What remains is
// the mechanism plus an onboarding path that requires the operator to supply
// their own recipients.
//
// Nothing here decrypts, generates or re-keys anything on its own.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';

export const SOPS_CONFIG = join(REPO_ROOT, '.sops.yaml');
export const RECIPIENTS_FILE = join(REPO_ROOT, '.age/recipients.txt');

/** Exit codes, so a caller can distinguish "unavailable" from "worked". */
export const EXIT = {
  ok: 0,
  notImplemented: 3,
} as const;

export interface SecretsReport {
  sopsAvailable: boolean;
  ageAvailable: boolean;
  configured: boolean;
  recipients: number;
  problems: string[];
  nextSteps: string[];
}

const available = (command: string, args: readonly string[]): boolean =>
  spawnSync(command, [...args], { stdio: 'ignore' }).status === 0;

export const inspectSecrets = (): SecretsReport => {
  const problems: string[] = [];
  const nextSteps: string[] = [];

  const sopsAvailable = available('sops', ['--version']);
  const ageAvailable = available('age', ['--version']);

  if (!sopsAvailable) {
    problems.push('sops is not installed. Secret encryption needs it.');
    nextSteps.push('Install sops: https://github.com/getsops/sops');
  }
  if (!ageAvailable) {
    problems.push('age is not installed. Secret encryption needs it.');
    nextSteps.push('Install age: https://github.com/FiloSottile/age');
  }

  let recipients = 0;
  const configured = existsSync(SOPS_CONFIG);

  if (configured) {
    const text = readFileSync(SOPS_CONFIG, 'utf8');
    recipients = (text.match(/age1[0-9a-z]{20,}/g) ?? []).length;

    if (recipients === 0) {
      problems.push(
        '.sops.yaml exists but names no age recipient. Encryption would produce ' +
          'a file nobody can decrypt.',
      );
      nextSteps.push('Add your own public key to .sops.yaml');
    }
  } else {
    problems.push(
      'No .sops.yaml. This is expected in a fresh template: recipients are ' +
        'project-specific and must not be inherited.',
    );
    nextSteps.push('Create .sops.yaml with your own age recipient (see docs/secrets.md)');
  }

  return { sopsAvailable, ageAvailable, configured, recipients, problems, nextSteps };
};

/** Operations this module does not perform. */
const NOT_IMPLEMENTED = [
  'encrypt',
  'decrypt',
  'init',
  'doctor',
  'edit',
  'exec',
  'update-recipients',
];

export const main = (args: readonly string[]): number => {
  // Every advertised operation is a refusal until it is implemented. The problem
  // this replaces is not that they are missing — it is that they exit 0. A command
  // named `secrets init` that printed a report and returned success was read by a
  // script, a Makefile and a person alike as "the recipients file was created".
  const operation = args.find((arg) => !arg.startsWith('-'));
  if (operation !== undefined && NOT_IMPLEMENTED.includes(operation)) {
    process.stderr.write(
      `secrets ${operation} is NOT IMPLEMENTED. Nothing was read, written, encrypted or created.\n\n` +
        'For encryption and decryption, run sops directly, so the target file is always\n' +
        'explicit and never guessed:\n' +
        '  sops -e secrets/production.enc.env   > secrets/production.enc.env.new\n' +
        '  sops -d secrets/production.enc.env   > apps/backend/api/.dev.vars\n' +
        '\nDecrypted output must go to a gitignored path.\n' +
        'The remaining operations (init, edit, exec, update-recipients, doctor) arrive\n' +
        'with the phase that also wires direnv. See docs/secrets.md.\n',
    );
    return EXIT.notImplemented;
  }

  const report = inspectSecrets();

  process.stdout.write('Secrets\n');
  process.stdout.write(`  sops       ${report.sopsAvailable ? 'available' : 'MISSING'}\n`);
  process.stdout.write(`  age        ${report.ageAvailable ? 'available' : 'MISSING'}\n`);
  process.stdout.write(
    `  configured ${report.configured ? `yes (${report.recipients} recipient(s))` : 'no'}\n`,
  );

  for (const problem of report.problems) {
    process.stdout.write(`\n  problem: ${problem}\n`);
  }
  if (report.nextSteps.length > 0) {
    process.stdout.write('\nNext:\n');
    for (const step of report.nextSteps) {
      process.stdout.write(`  - ${step}\n`);
    }
  }

  // Reached only when no operation word matched at all — i.e. `secrets` with flags
  // but no operation. Everything named in the usage was refused at the top.
  return 0;
};
