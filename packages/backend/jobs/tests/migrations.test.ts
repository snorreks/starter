import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverMigrations } from './migrations.ts';

test('missing and empty migration directories name the expected path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jobs-migrations-'));
  try {
    expect(() => discoverMigrations(join(directory, 'missing'))).toThrow(
      join(directory, 'missing'),
    );
    writeFileSync(join(directory, 'README.md'), 'No migrations');
    expect(() => discoverMigrations(directory)).toThrow(
      `Expected at least one .sql migration in ${directory}.`,
    );
    writeFileSync(join(directory, '0002.sql'), 'SELECT 2;');
    writeFileSync(join(directory, '0001.sql'), 'SELECT 1;');
    expect(discoverMigrations(directory)).toEqual(['0001.sql', '0002.sql']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
