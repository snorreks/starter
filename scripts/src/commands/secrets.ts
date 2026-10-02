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
  '  init               write .sops.yaml naming your own age recipients',
  '  encrypt <path>     invoke sops to encrypt a plaintext file in place',
  '  decrypt <path>     invoke sops to decrypt to an explicit ignored destination (--out)',
  '  doctor             probe sops and age, and check .sops.yaml recipients',
  '  exec <cmd>         invoke sops to run a command with secrets in its environment',
  '  update-recipients  update the age recipients in .sops.yaml',
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
