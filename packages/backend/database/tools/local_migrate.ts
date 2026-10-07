import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const dbUrl = process.env.SUPABASE_DB_URL;
if (dbUrl === undefined || !dbUrl.startsWith('postgresql://postgres:postgres@127.0.0.1:')) {
  throw new Error(
    'SUPABASE_DB_URL must identify the allocated local Postgres service before applying migrations.',
  );
}
const result = spawnSync(
  'bun',
  [
    'run',
    '--cwd',
    packageRoot,
    'supabase',
    '--',
    'migration',
    'up',
    '--db-url',
    `${dbUrl}?sslmode=disable`,
  ],
  { stdio: 'inherit', timeout: 120_000, env: process.env },
);
if (result.error !== undefined) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
