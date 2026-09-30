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
import { REPO_ROOT } from '../guards/boundary.ts';

export const SOPS_CONFIG = join(REPO_ROOT, '.sops.yaml');
export const RECIPIENTS_FILE = join(REPO_ROOT, '.age/recipients.txt');

export type SecretsReport = {
  sopsAvailable: boolean;
  ageAvailable: boolean;
  configured: boolean;
  recipients: number;
  problems: string[];
  nextSteps: string[];
};

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
    nextSteps.push('Create .sops.yaml with your own age recipient (see docs/guides/secrets.md)');
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

  // Encrypt/decrypt are intentionally not implemented as a blind wrapper.
  // They are one-line `sops -e/-d` invocations, and a wrapper that guesses the
  // recipient or the in-place flag is how a secret gets written to the wrong
  // file.
  if (args.includes('encrypt') || args.includes('decrypt')) {
    process.stdout.write(
      '\nRun sops directly, so the target file is always explicit:\n' +
        '  sops -e secrets/production.enc.env   > secrets/production.enc.env.new\n' +
        '  sops -d secrets/production.enc.env   > apps/backend/api/.dev.vars\n' +
        '\nDecrypted output must go to a gitignored path.\n',
    );
  }

  return 0;
};

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
