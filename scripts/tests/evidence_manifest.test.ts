// scripts/tests/evidence_manifest.test.ts
//
// The capability matrix may not claim a number no run produced.
//
// Small, and deliberately so: the round-2 review asked for a manifest, not a
// results database and not a second runner. What is worth asserting here is that
// the invariants hold and that the two committed files agree — because the failure
// being prevented is a stale count surviving in a document nobody re-reads.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EVIDENCE_KINDS,
  EVIDENCE_MANIFEST_PATH,
  type EvidenceManifest,
  type EvidenceRow,
  MATRIX_BEGIN,
  MATRIX_END,
  matrixMatches,
  readManifest,
  renderCurrentMatrix,
} from '../src/ci/evidence.ts';
import { REPO_ROOT } from '../src/shared/paths.ts';

const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'starter-evidence-'));
  return dir;
};

const write = (dir: string, manifest: unknown, matrix?: string): void => {
  mkdirSync(dirname(join(dir, EVIDENCE_MANIFEST_PATH)), { recursive: true });
  writeFileSync(join(dir, EVIDENCE_MANIFEST_PATH), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(
    join(dir, 'docs/capability-matrix.md'),
    matrix ?? `# Capability matrix\n\n${MATRIX_BEGIN}\n${MATRIX_END}\n\n## Retained\n`,
    'utf8',
  );
};

const row = (overrides: Partial<EvidenceRow> = {}): EvidenceRow => ({
  capability: 'Unit tests',
  kind: 'observed',
  revision: 'f2374d1',
  command: 'bun run test',
  platform: 'linux-x64',
  result: '12 pass, 0 fail',
  count: 12,
  recordedAt: '2026-10-03T21:52:00.000Z',
  artifact: null,
  ...overrides,
});

describe('the committed manifest is valid', () => {
  test('docs/evidence/current.json parses and satisfies its own invariants', () => {
    const result = readManifest(REPO_ROOT);
    if (!result.ok) {
      throw new Error(result.problems.join('\n'));
    }
    expect(result.manifest.rows.length).toBeGreaterThan(0);
  });

  test('every kind the module names is one a row may use', () => {
    const result = readManifest(REPO_ROOT);
    if (!result.ok) {
      throw new Error(result.problems.join('\n'));
    }
    for (const row of result.manifest.rows) {
      expect(EVIDENCE_KINDS).toContain(row.kind);
    }
  });

  test('the capability matrix carries the generated block, and it matches', () => {
    // The check CI runs. If these two files ever disagree, this is the failure that
    // says so — rather than a reader discovering a stale count months later.
    const result = readManifest(REPO_ROOT);
    if (!result.ok) {
      throw new Error(result.problems.join('\n'));
    }
    const match = matrixMatches(result.manifest, REPO_ROOT);
    expect(match.detail).toBe('the capability matrix matches the evidence manifest.');
  });

  test('the manifest names its revision as a SHA', () => {
    const result = readManifest(REPO_ROOT);
    if (!result.ok) {
      throw new Error(result.problems.join('\n'));
    }
    expect(result.manifest.revision).toMatch(/^[0-9a-f]{7,40}$/);
  });
});

describe('a not-run row must say why', () => {
  test('a not-run row with no reason is refused', () => {
    // The row that matters most. Without a reason it reads as "not important",
    // which is the opposite of what it means.
    const dir = root();
    try {
      write(dir, { revision: 'f2374d1', rows: [row({ kind: 'not-run', count: null })] });
      const result = readManifest(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems[0]).toContain('must say why');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a not-run row with a reason is accepted', () => {
    const dir = root();
    try {
      write(dir, {
        revision: 'f2374d1',
        rows: [
          row({
            kind: 'not-run',
            count: null,
            reason: 'no Cloudflare account in this environment',
          }),
        ],
      });
      expect(readManifest(dir).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a row must be reproducible and identified', () => {
  test('a row with no command is refused', () => {
    const dir = root();
    try {
      write(dir, { revision: 'f2374d1', rows: [row({ command: '' })] });
      const result = readManifest(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems[0]).toContain('command is required');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a row with no platform is refused, because "linux" is not a host', () => {
    const dir = root();
    try {
      write(dir, { revision: 'f2374d1', rows: [row({ platform: '' })] });
      expect(readManifest(dir).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('two rows for one capability are refused rather than silently ranked', () => {
    const dir = root();
    try {
      write(dir, { revision: 'f2374d1', rows: [row(), row()] });
      const result = readManifest(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems[0]).toContain('duplicate capability');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a manifest whose rows are not objects is refused, not thrown over', () => {
    // A blind `as EvidenceManifest` cast trusted `rows` to be an array of rows, so
    // `"rows": {}` produced a stack trace from a document a person hand-edits.
    const dir = root();
    try {
      write(dir, { revision: 'f2374d1', rows: {} });
      const result = readManifest(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems[0]).toContain('must be an array');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a row that is not an object is named by index', () => {
    const dir = root();
    try {
      write(dir, { revision: 'f2374d1', rows: [row(), 'not a row'] });
      const result = readManifest(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems[0]).toContain('rows[1]');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a manifest that is not an object at all is refused', () => {
    const dir = root();
    try {
      write(dir, [1, 2, 3]);
      const result = readManifest(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems[0]).toContain('must contain a JSON object');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a fractional count is refused on a historical row too', () => {
    // Only `observed` rows were checked, so a historical figure — the number a
    // reader quotes when asking whether something regressed — could be any string.
    const dir = root();
    try {
      write(dir, {
        revision: 'f2374d1',
        rows: [row({ capability: 'Older lane', kind: 'historical', count: 12.5 })],
      });
      const result = readManifest(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems[0]).toContain('count must be an integer');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a count of null is accepted, because not every command reports one', () => {
    const dir = root();
    try {
      write(dir, { revision: 'f2374d1', rows: [row({ count: null })] });
      expect(readManifest(dir).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing manifest is reported as missing, not as "no rows, therefore fine"', () => {
    const dir = root();
    try {
      const result = readManifest(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems[0]).toContain('is missing');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a stale matrix is caught, with the line that differs', () => {
  const manifest: EvidenceManifest = {
    revision: 'f2374d1',
    rows: [row()],
  };

  test('a matrix whose block was hand-edited does not match', () => {
    const dir = root();
    try {
      write(
        dir,
        manifest,
        `# Capability matrix\n\n${MATRIX_BEGIN}\n| Capability | 999 tests |\n${MATRIX_END}\n`,
      );
      const match = matrixMatches(manifest, dir);
      expect(match.ok).toBe(false);
      // The first differing line, not just "out of date".
      expect(match.detail).toContain('first differing line');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a matrix with no generated block says how to add one', () => {
    const dir = root();
    try {
      write(dir, manifest, '# Capability matrix\n\nNo block here.\n');
      const match = matrixMatches(manifest, dir);
      expect(match.ok).toBe(false);
      expect(match.detail).toContain('bun run evidence --write');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a pipe in a result cannot restructure the table', () => {
    // Every value is hand-edited prose. One `|` silently splits a cell, the column
    // count stops matching the header, and the matrix renders as garbage nobody
    // notices until they need to read it.
    const rendered = renderCurrentMatrix({
      revision: 'f2374d1',
      rows: [row({ result: '1740 pass | 0 fail across 12 projects', capability: 'a | b' })],
    });
    const dataLine = rendered.split('\n').find((line) => line.includes('1740 pass')) ?? '';

    expect(dataLine).toContain('1740 pass \\| 0 fail');
    expect(dataLine).toContain('a \\| b');
    // Six columns means five unescaped separators; every `|` that remains is one.
    expect(dataLine.split(/(?<!\\)\|/).length).toBe(8);
  });

  test('a newline in a reason cannot end the table row', () => {
    const rendered = renderCurrentMatrix({
      revision: 'f2374d1',
      rows: [row({ kind: 'not-run', count: null, reason: 'no account\none credential' })],
    });
    const after = rendered.split('| Capability |')[1] ?? '';
    // The reason stays inside its own row rather than leaking onto the next line.
    expect(after).toContain('no account one credential');
  });

  test('an artifact path stays visible without linking checkout-local output', () => {
    const rendered = renderCurrentMatrix({
      revision: 'f2374d1',
      rows: [row({ artifact: 'docs/evidence/run|1.json' })],
    });
    expect(rendered).toContain('run\\|1.json');
    expect(rendered).not.toContain('[docs/evidence/run');
  });

  test('the rendered block excludes historical rows', () => {
    // A historical figure rendered in the current table is a stale claim with a
    // timestamp on it, which is worse than one without.
    const rendered = renderCurrentMatrix({
      revision: 'f2374d1',
      rows: [row(), row({ capability: 'Older lane', kind: 'historical' })],
    });
    expect(rendered).toContain('Unit tests');
    expect(rendered).not.toContain('Older lane');
  });
});
