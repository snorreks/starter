// scripts/tests/contracts_cli.test.ts
//
// The contract command, after the runner was removed.
//
// What is worth proving here is that the surface no longer advertises work it
// cannot do. The command once accepted `run` and `resume`, printed a stage
// machine, and persisted a run manifest that recorded `succeeded` stages nothing
// had performed. A brief is now a document, so the assertions are about the
// document: the template is substituted into a real file, the listing reads that
// file's own status line, and the removed subcommands say what happened instead
// of falling through to a bare usage error.
//
// Every fixture is written to a temporary directory. Nothing is asserted against
// the repository: proving a scaffolder works by writing into `docs/contracts/`
// would make the working tree the test's evidence.

import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACTS_DIR,
  contractCommand,
  main,
  nextContractId,
  scaffold,
} from '../src/commands/contracts.ts';
import { readContracts } from '../src/contracts/status.ts';
import { EXIT } from '../src/shared/command.ts';

const cleanups: string[] = [];

/** A temporary briefs directory holding the real template. */
const briefDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
  cleanups.push(dir);
  copyFileSync(join(CONTRACTS_DIR, 'TEMPLATE.md'), join(dir, 'TEMPLATE.md'));
  return dir;
};

const quiet = async (body: () => Promise<number>): Promise<number> => {
  const original = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return await body();
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
};

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('scaffolding a brief', () => {
  test('every placeholder is substituted, so no {{…}} survives into the file', () => {
    const dir = briefDir();
    const path = scaffold('Add thing export as NDJSON', dir);
    const body = readFileSync(path, 'utf8');

    expect(body).not.toContain('{{');
    expect(body).toContain('# C-001 — Add thing export as NDJSON');
    expect(body).toContain('**Status:** draft');
  });

  test('the id follows the highest one already present', () => {
    const dir = briefDir();
    writeFileSync(join(dir, 'C-007-existing.md'), '# C-007 — Existing\n\n**Status:** done\n');
    writeFileSync(join(dir, 'notes.md'), '# not a brief\n');

    expect(nextContractId(dir)).toBe('C-008');
    expect(readContracts(dir).map((row) => row.id)).toEqual(['C-007']);
  });

  test('a title with no slug-safe characters still names a readable file', () => {
    const dir = briefDir();
    const path = scaffold('!!! ???', dir);

    // The id still orders the file even when the slug is empty. A crash here would
    // be worse than an ugly name.
    expect(path).toEndWith('C-001-.md');
  });

  test('a missing template is an error, not an empty brief', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-empty-'));
    cleanups.push(dir);

    expect(() => scaffold('Anything', dir)).toThrow(/No template/);
  });
});

describe('the surface describes the real capability', () => {
  test('the usage line names only the subcommands that exist', async () => {
    const usage = contractCommand.usage;

    expect(usage).toContain('new');
    expect(usage).toContain('status');
    // `run` was advertised for the lifetime of a runner that could not run.
    expect(usage).not.toContain('run');
    expect(usage).not.toContain('resume');
    expect(usage).not.toContain('cancel');
  });

  test('`run` is refused with an explanation instead of a bare usage error', async () => {
    let message = '';
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      message += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const code = await main(['run', 'docs/contracts/TEMPLATE.md']);
      expect(code).toBe(EXIT.usage);
    } finally {
      process.stderr.write = original;
    }

    // Someone who remembers the old command learns what to do instead. Silence
    // here reads as "that flag was never valid", which sends them looking for a
    // typo rather than for a removal.
    expect(message).toContain('removed');
    expect(message).toContain('docs/contracts/README.md');
  });

  test('`new` without a title is a usage error', async () => {
    expect(await quiet(() => main(['new']))).toBe(EXIT.usage);
    expect(await quiet(() => main(['new', '--quiet']))).toBe(EXIT.usage);
  });

  test('an unknown subcommand is a usage error', async () => {
    expect(await quiet(() => main(['cancel', 'C-001']))).toBe(EXIT.usage);
  });
});

describe('status lists documents', () => {
  test('an unknown id is blocked, not silently empty', async () => {
    // `status C-404` printing nothing and exiting 0 is indistinguishable from a
    // brief that exists and was filtered out.
    const code = await quiet(() => main(['status', 'C-404']));

    expect(code).toBe(EXIT.failed);
  });

  test('a brief is found by the id its own heading declares', () => {
    const dir = briefDir();
    // The filename says one id and the heading another. The document is what a
    // reader sees, so the heading wins — and `status C-009` must find it.
    writeFileSync(join(dir, 'C-100-old-name.md'), '# C-009 — Renamed\n\n**Status:** done\n');

    expect(readContracts(dir).map((row) => ({ ...row }))).toEqual([
      { id: 'C-009', file: 'C-100-old-name.md', status: 'done' },
    ]);
  });

  test('a brief with no status line is reported as unknown, not as fine', () => {
    const dir = briefDir();
    writeFileSync(join(dir, 'C-101-no-status.md'), '# C-101 — No status line\n');

    expect(readContracts(dir)[0]?.status).toBe('unknown');
  });
});
