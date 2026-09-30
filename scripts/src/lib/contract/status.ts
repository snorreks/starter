// scripts/src/lib/contract/status.ts
//
// What contracts exist, and what state their runs are in. Read-only.
//
// Reached through `bun run contract status`, not as its own root script: two
// entry points for one command is how the documented one and the real one drift.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACTS_DIR } from './cli.ts';

export interface ContractRow {
  id: string;
  file: string;
  type: string;
  status: string;
}

/**
 * Read a contract's fields from its body.
 *
 * The templates write `**Type:** full` and `**Status:** draft` under the title.
 * This previously split on `---` looking for YAML front matter, which the
 * templates do not have, so every column of every row printed `unknown`.
 */
export const readContractRow = (file: string, body: string): ContractRow => {
  const heading = /^#\s+(\S+)\s+—\s+/m.exec(body);
  const idFromName = /^C-(\d+)/.exec(file);

  const field = (key: string): string => {
    const match = new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.+)$`, 'm').exec(body);
    return match?.[1]?.trim() ?? 'unknown';
  };

  return {
    id: heading?.[1] ?? (idFromName ? `C-${idFromName[1]}` : 'unknown'),
    file,
    type: field('Type'),
    status: field('Status'),
  };
};

export const readContracts = (dir = CONTRACTS_DIR): ContractRow[] => {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((name) => /^C-\d+.*\.md$/.test(name))
    .sort()
    .map((name) => readContractRow(name, readFileSync(join(dir, name), 'utf8')));
};

/** Standalone entry point. `bun run contract status` prefers the CLI. */
export const main = (): number => {
  const rows = readContracts();

  if (rows.length === 0) {
    process.stdout.write('No contracts yet. Create one with: bun run contract new "<title>"\n');
    return 0;
  }

  process.stdout.write(`${rows.length} contract(s)\n\n`);
  for (const row of rows) {
    process.stdout.write(
      `  ${row.id.padEnd(8)} ${row.type.padEnd(9)} ${row.status.padEnd(10)} ${row.file}\n`,
    );
  }
  return 0;
};

if (import.meta.main) {
  process.exitCode = main();
}
