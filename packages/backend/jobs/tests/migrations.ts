import { existsSync, readdirSync } from 'node:fs';

/** Refuse to test an empty schema when migrations move or disappear. */
export const discoverMigrations = (directory: string): string[] => {
  if (!existsSync(directory)) {
    throw new Error(`Expected SQL migrations directory at ${directory}.`);
  }
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    throw new Error(`Expected at least one .sql migration in ${directory}.`);
  }
  return files;
};
