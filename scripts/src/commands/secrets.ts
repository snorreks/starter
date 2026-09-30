// scripts/src/commands/secrets.ts
//
// Thin adapter over the SOPS domain module. The operation names are the SOPS
// vocabulary rather than a project-specific one, so a person who knows `sops` can
// guess this command.

import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';
import { main as secretsMain } from '../secrets/secrets.ts';

const USAGE = [
  'Usage: secrets <operation> [options]',
  '',
  'Operations:',
  "  init               create this project's age recipients file and .sops.yaml",
  '  doctor             check sops, age and the recipients this project needs',
  '  edit <path>        decrypt to an ignored file, open $EDITOR, re-encrypt',
  '  encrypt <path>     encrypt a plaintext file for the project recipients',
  '  decrypt <path>     decrypt to an explicit ignored destination, or into a child',
  '  exec <cmd>         run a command with the secrets in its environment',
  '  update-recipients  add or remove age recipients across the ciphertext',
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
