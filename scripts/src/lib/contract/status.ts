// scripts/src/lib/contract/status.ts
//
// What exists, and what state it is in. Read-only.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACTS_DIR } from './cli.ts';

export interface ContractRow {
  id: string;
  file: string;
  type: string;
  status: string;
}

const FIELD = (frontmatter: string, key: string): string => {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontmatter);
  return match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? 'unknown';
};

export const readContracts = (dir = CONTRACTS_DIR): ContractRow[] => {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((name) => /^C-\d+.*\.md$/.test(name))
    .sort()
    .map((name) => {
      const content = readFileSync(join(dir, name), 'utf8');
      const frontmatter = content.split('---')[1] ?? '';
      return {
        id: FIELD(frontmatter, 'id'),
        file: name,
        type: FIELD(frontmatter, 'contract_type'),
        status: FIELD(frontmatter, 'status'),
      };
    });
};

export const main = (): number => {
  const rows = readContracts();

  if (rows.length === 0) {
    process.stdout.write('No contracts yet.\nCreate one with: bun run contract new "<title>"\n');
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
