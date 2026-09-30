// scripts/src/lib/secrets/index.ts
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
import { REPO_ROOT } from '../paths.ts';

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

export const main = (args: readonly string[]): number => {
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

  // Encrypt/decrypt are not implemented here, and say so with a nonzero exit.
  //
  // They are one-line `sops -e/-d` invocations, and a wrapper that guesses the
  // recipient or the in-place flag is how a secret gets written to the wrong file.
  // The real commands (init, doctor, edit, encrypt, decrypt, exec, update-keys)
  // arrive with the phase that also ships direnv; until then these two print the
  // raw sops invocations and exit 3.
  //
  // Previously they printed the same guidance and exited 0, so a script — or CI —
  // wrapping `bun run secrets:encrypt` saw success and concluded a file had been
  // encrypted. Printing instructions and exiting zero is an always-success fake.
  if (args.includes('encrypt') || args.includes('decrypt')) {
    const operation = args.includes('encrypt') ? 'encrypt' : 'decrypt';
    process.stderr.write(
      `secrets:${operation} is NOT IMPLEMENTED. Nothing was read, written or encrypted.\n\n` +
        'Run sops directly, so the target file is always explicit:\n' +
        '  sops -e secrets/production.enc.env   > secrets/production.enc.env.new\n' +
        '  sops -d secrets/production.enc.env   > apps/backend/api/.dev.vars\n' +
        '\nDecrypted output must go to a gitignored path.\n' +
        '\nThis repository wires real secrets:encrypt / secrets:decrypt (plus init,\n' +
        'edit, exec and update-keys) in the phase that also adds direnv. See docs/secrets.md.\n',
    );
    return EXIT.notImplemented;
  }

  return 0;
};

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
