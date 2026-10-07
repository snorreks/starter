import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const normalizeGeneratedTypes = (types: string): string =>
  types
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
const dbUrl = process.env.SUPABASE_DB_URL;
if (dbUrl === undefined || !dbUrl.startsWith('postgresql://postgres:postgres@127.0.0.1:')) {
  throw new Error(
    'SUPABASE_DB_URL must identify the allocated local Postgres service before generating database types.',
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
    'gen',
    'types',
    'typescript',
    '--db-url',
    `${dbUrl}?sslmode=disable`,
    '--schema',
    'public',
  ],
  { encoding: 'utf8', timeout: 120_000, env: process.env },
);
if (result.error !== undefined) {
  throw result.error;
}
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} else {
  await writeFile(
    join(packageRoot, 'src/supabase/database.types.ts'),
    normalizeGeneratedTypes(result.stdout),
  );
  process.stdout.write(
    'Generated src/supabase/database.types.ts from the allocated local migrations.\n',
  );
}
