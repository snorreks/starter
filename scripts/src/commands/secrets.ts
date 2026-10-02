// scripts/src/commands/secrets.ts
//
// Thin adapter over the SOPS domain module. The operation names are the SOPS
// vocabulary rather than a project-specific one, so a person who knows `sops` can
// guess this command.

import { main as secretsMain } from '../secrets/secrets.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';

const USAGE = [
  'Usage: secrets <operation> [options]',
  '',
  'Operations — every one of these runs the real sops and age binaries and reports',
  'their status. Each was exercised against a real sops 3.13 and a real age',
  'identity while this text was written:',
  '  init               write .sops.yaml naming your own age recipients',
  '  encrypt <path>     encrypt a plaintext file in place',
  '  decrypt <path>     decrypt to an explicit ignored destination (--out)',
  '  doctor             check sops, age and the recipients this project needs',
  '  exec <cmd>         run a command with the secrets in its environment',
  '  update-recipients  add or remove age recipients across the ciphertext',
  '',
  'One operation is refused rather than implemented, because it would be a second',
  'code path to a file `sops` already edits in place:',
  '  edit <path>        use `sops <file>` directly',
  '',
  '`doctor` prints the state it can see — sops, age and the recipients file — and',
  'exits 3, so it is a report and not a passing health check.',
  '',
  'Plaintext is never printed. Decryption requires an explicit destination path',
  'or `exec`; encryption requires the recipients to use.',
].join('\n');

export const secretsCommand: Command = {
  name: 'secrets',
  summary: 'SOPS: init, doctor, edit, encrypt, decrypt, exec',
  usage: USAGE,

  run(argv) {
    // `--help` on its own describes the operation list; `--help` after an
    // operation is that operation's own help, handled downstream.
    if (wantsHelp(argv) && argv.length === 1) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }
    if (argv.length === 0) {
      return fail(USAGE, EXIT.usage);
    }
    return secretsMain(argv);
  },
};
