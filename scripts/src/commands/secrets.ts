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
  'Operations:',
  '  encrypt <path>     encrypt a plaintext file for the project recipients   [NOT IMPLEMENTED]',
  '  decrypt <path>     decrypt to an explicit ignored destination             [NOT IMPLEMENTED]',
  '',
  'Also advertised, also not implemented — they exit nonzero rather than report',
  'success, because none of them does the work its name says:',
  "  init               create this project's age recipients file and .sops.yaml",
  '  doctor             check sops, age and the recipients this project needs',
  '  edit <path>        decrypt to an ignored file, open $EDITOR, re-encrypt',
  '  exec <cmd>         run a command with the secrets in its environment',
  '  update-recipients  add or remove age recipients across the ciphertext',
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
