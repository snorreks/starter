// scripts/src/db/seed.ts
//
// Insert synthetic seed data, for a fresh local database.
//
// Synthetic only, and stated as such in the output: an E2E run that creates
// "Ada Lovelace" and expects to find it later is deterministic, whereas one
// that depends on whatever a previous run left behind is not.

import { join } from 'node:path';
import { MOCK_NOTES, MOCK_USER } from '@starter/fixtures';
import { runWrangler } from '../cloudflare/wrangler.ts';
import { CLIENT_DIR } from '../shared/paths.ts';

const sql = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const epochSeconds = Math.floor(Date.now() / 1000);

/** SQL fixture rows are generated only from the shared mock fixture package. */
export const SEED_STATEMENTS: readonly string[] = [
  `INSERT OR IGNORE INTO users (id, name, email, email_verified, created_at, updated_at)
   VALUES (
     ${sql(MOCK_USER.id)},
     ${sql(MOCK_USER.displayName)},
     ${sql(MOCK_USER.email)},
     ${MOCK_USER.emailVerified ? 1 : 0},
     ${epochSeconds},
     ${epochSeconds}
   )`,
  ...MOCK_NOTES.map(
    (note) =>
      `INSERT OR IGNORE INTO notes (id, owner_id, title, body, created_at, updated_at)
       VALUES (
         ${sql(note.id)},
         ${sql(note.ownerId)},
         ${sql(note.title)},
         ${sql(note.body)},
         ${Math.floor(note.createdAt / 1000)},
         ${Math.floor(note.updatedAt / 1000)}
       )`,
  ),
];

export const main = (_args: readonly string[] = []): number => {
  process.stdout.write(
    'Seeding the local database with synthetic data:\n' +
      `  1 user, ${MOCK_NOTES.length} notes — all synthetic, all addressed ${MOCK_USER.email}\n\n`,
  );

  const code = runWrangler([
    'd1',
    'execute',
    'DB',
    '--local',
    '--config',
    join(CLIENT_DIR, 'wrangler.jsonc'),
    '--command',
    SEED_STATEMENTS.join('; '),
  ]);

  if (code === 0) {
    process.stdout.write(
      '\nSeeded. The emulator supplies the mock identity without a session token.\n',
    );
  }
  return code;
};
