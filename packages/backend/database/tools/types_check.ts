import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const tracked = join(packageRoot, 'src/supabase/database.types.ts');
const normalizeGeneratedTypes = (types: string): string =>
  types
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
const dbUrl = process.env.SUPABASE_DB_URL;
if (dbUrl === undefined || !dbUrl.startsWith('postgresql://postgres:postgres@127.0.0.1:')) {
  throw new Error(
    'SUPABASE_DB_URL must identify the allocated local Postgres service before checking generated types.',
  );
}
const directory = await mkdtemp(join(tmpdir(), 'starter-db-types-'));
try {
  const generated = join(directory, 'database.types.ts');
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
    await writeFile(generated, normalizeGeneratedTypes(result.stdout));
    const expected = await readFile(tracked, 'utf8');
    const actual = await readFile(generated, 'utf8');
    if (expected !== actual) {
      process.stderr.write(
        'Generated Supabase database types differ from src/supabase/database.types.ts. Run `bun run db:types` after resetting local migrations.\n',
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(
        'Generated Supabase database types match the tracked migration output.\n',
      );
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
