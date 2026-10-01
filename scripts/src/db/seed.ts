// scripts/src/db/seed.ts
//
// Insert synthetic seed data, for a fresh local database.
//
// Synthetic only, and stated as such in the output: an E2E run that creates
// "Ada Lovelace" and expects to find it later is deterministic, whereas one
// that depends on whatever a previous run left behind is not.

import { join } from 'node:path';
import { runWrangler } from '../cloudflare/wrangler.ts';
import { API_DIR } from '../shared/paths.ts';

/** Statements are fixed and parameterless. Never interpolate input into SQL. */
export const SEED_STATEMENTS: readonly string[] = [
  // A signed-in user, so a local database is immediately usable.
  `INSERT OR IGNORE INTO users (id, name, email, email_verified, created_at, updated_at)
   VALUES ('seed_user_0001', 'Seed User', 'seed@example.invalid', 1, unixepoch(), unixepoch())`,
  `INSERT OR IGNORE INTO sessions (id, user_id, token, expires_at, created_at, updated_at)
   VALUES ('seed_session_0001', 'seed_user_0001', 'seed-token-not-a-real-secret', unixepoch() + 86400, unixepoch(), unixepoch())`,
  `INSERT OR IGNORE INTO notes (id, owner_id, title, body, created_at, updated_at) VALUES
     ('seed_note_0001', 'seed_user_0001', 'Welcome', 'This note is synthetic seed data.', unixepoch(), unixepoch()),
     ('seed_note_0002', 'seed_user_0001', 'Delete me', 'This one exists so the delete path has something to act on.', unixepoch(), unixepoch())`,
];

export const main = (_args: readonly string[] = []): number => {
  process.stdout.write(
    'Seeding the local database with synthetic data:\n' +
      '  1 user, 1 session, 2 notes — all synthetic, all addressed seed@example.invalid\n\n',
  );

  const code = runWrangler([
    'd1',
    'execute',
    'DB',
    '--local',
    '--config',
    join(API_DIR, 'wrangler.jsonc'),
    '--command',
    SEED_STATEMENTS.join('; '),
  ]);

  if (code === 0) {
    process.stdout.write('\nSeeded. The seed session token is not a real credential.\n');
  }
  return code;
};
