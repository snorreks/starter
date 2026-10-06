// scripts/tests/coverage.test.ts
//
// The merged coverage number, proved against disposable trees.
//
// The merge is not arithmetic. Two properties decide whether the number means
// anything, and both are tested here against real lcov text rather than against
// a mock:
//
//   1. The same source file, reported by two different packages, is ONE file.
//      Bun writes `SF:` relative to the package that produced it, so a file in
//      `schemas` is `../schemas/src/x.ts` in `logger`'s report and
//      `src/x.ts` in `schemas`' own. Keyed on the raw string, the merged file
//      holds two records for one file, the denominator doubles, and the total
//      moves when an unrelated package starts importing a module.
//
//   2. A line exercised by either package is a line the repository exercised.
//      Summing counts makes "hit" mean hit rather than mean "hit by everyone".

import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverReports, runCoverage } from '../src/coverage/coverage.ts';
import {
  mergeReports,
  parseReport,
  renderLcov,
  resolveReportPath,
  total,
} from '../src/coverage/lcov.ts';

const roots: string[] = [];

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-coverage-'));
  roots.push(root);
  mkdirSync(join(root, 'packages/shared/schemas/src'), { recursive: true });
  mkdirSync(join(root, 'packages/shared/logger/src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'root', private: true, workspaces: ['packages/shared/*'] }, null, 2)}\n`,
  );
  for (const [dir, name] of [
    ['packages/shared/schemas', '@starter/schemas'],
    ['packages/shared/logger', '@starter/logger'],
  ]) {
    writeFileSync(
      join(root, dir, 'package.json'),
      `${JSON.stringify({ name, private: true }, null, 2)}\n`,
    );
  }
  return root;
};

/** Write a report the way Bun writes one: `SF:` relative to the package. */
const writeReport = (root: string, dir: string, records: readonly string[]): void => {
  mkdirSync(join(root, dir, 'coverage'), { recursive: true });
  const body = records
    .map((record) => `SF:${record}\nDA:1,1\nDA:2,0\nFNF:1\nFNH:1\nLF:2\nLH:1\nend_of_record`)
    .join('');
  writeFileSync(join(root, dir, 'coverage', 'lcov.info'), body);
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file reported by two packages through different paths is one file', () => {
  const root = fixture();
  // `logger` reaches into `schemas`, so its report points outside itself.
  writeReport(root, 'packages/shared/logger', ['../schemas/src/logging.ts']);
  writeReport(root, 'packages/shared/schemas', ['src/logging.ts']);

  const { reports } = discoverReports(root);
  const merged = mergeReports(reports);

  expect(merged.map((file) => file.path)).toEqual(['packages/shared/schemas/src/logging.ts']);
  // Four DA lines before merging, two after: the same two lines, counted once.
  expect(merged[0]?.lines.size).toBe(2);
  expect(total(merged).files).toBe(1);
});

test('a line exercised by either package counts as exercised once', () => {
  const root = fixture();
  // The real shape: `logger` reaches into `schemas`, and the two packages
  // exercise different lines of the same file.
  writeReport(root, 'packages/shared/logger', ['../schemas/src/shared.ts']);
  writeReport(root, 'packages/shared/schemas', ['src/shared.ts']);
  const merged = mergeReports([
    {
      projectDir: 'packages/shared/logger',
      text: 'SF:../schemas/src/shared.ts\nDA:1,0\nDA:2,3\nend_of_record\n',
    },
    {
      projectDir: 'packages/shared/schemas',
      text: 'SF:src/shared.ts\nDA:1,7\nDA:2,0\nend_of_record\n',
    },
  ]);

  expect(merged).toHaveLength(1);
  expect([...(merged.at(0)?.lines ?? new Map<number, number>()).entries()].sort()).toEqual([
    [1, 7],
    [2, 3],
  ]);
  // Two lines, both hit: once by one package, once by the other.
  expect(total(merged).linesHit).toBe(2);
  expect(total(merged).linesFound).toBe(2);
});

test('a path outside the package resolves to the repository, not to a traversal', () => {
  expect(resolveReportPath('packages/shared/logger', '../schemas/src/x.ts')).toBe(
    'packages/shared/schemas/src/x.ts',
  );
  expect(resolveReportPath('packages/shared/logger', 'src/x.ts')).toBe(
    'packages/shared/logger/src/x.ts',
  );
});

test('the merged file recomputes its own summary headers instead of summing them', () => {
  const merged = mergeReports([
    {
      projectDir: 'a',
      text: 'SF:x.ts\nDA:1,1\nDA:2,0\nFNF:2\nFNH:1\nLF:99\nLH:88\nend_of_record\n',
    },
  ]);
  const rendered = renderLcov(merged);
  // The input claimed one function hit out of two found; the merge keeps that,
  // but the line headers are derived from the DA lines that were actually read.
  expect(rendered).toContain('LF:2');
  expect(rendered).toContain('LH:1');
  expect(rendered.trimEnd().endsWith('end_of_record')).toBe(true);
});

test('a malformed execution count reads as never run rather than as covered', () => {
  const [file] = parseReport({
    projectDir: '',
    text: 'SF:x.ts\nDA:1,nonsense\nDA:2,4\nend_of_record\n',
  });
  expect(file?.lines.get(1)).toBe(0);
  expect(total(file ? [file] : []).linesHit).toBe(1);
});

test('a workspace with no reports refuses instead of reporting nothing tested', async () => {
  const root = fixture();
  const said: string[] = [];
  const result = await runCoverage({
    root,
    runTests: false,
    write: (text) => said.push(text),
  });
  expect(result.code).toBe(1);
  const output = said.join('\n');
  expect(output).toContain('No coverage reports were found');
  // It has to name where it looked, or the reader cannot tell a broken reporter
  // from an untested repository.
  expect(output).toContain('coverage/lcov.info');
  expect(result.summary).toBeUndefined();
});

test('a report with no line data refuses rather than reporting a clean zero', async () => {
  const root = fixture();
  mkdirSync(join(root, 'packages/shared/logger/coverage'), { recursive: true });
  writeFileSync(join(root, 'packages/shared/logger/coverage/lcov.info'), 'TN:\nend_of_record\n');
  const said: string[] = [];
  const result = await runCoverage({ root, runTests: false, write: (text) => said.push(text) });
  expect(result.code).toBe(1);
  expect(said.join('\n')).toContain('broken reporter');
});

test('a project that produced no report is named rather than omitted', async () => {
  const root = fixture();
  writeReport(root, 'packages/shared/logger', ['src/x.ts']);
  const said: string[] = [];
  const result = await runCoverage({ root, runTests: false, write: (text) => said.push(text) });
  expect(result.code).toBe(0);
  const output = said.join('\n');
  expect(output).toContain('packages/shared/schemas');
  expect(output).toContain('produced no report');
});

test('the number is reported without a threshold, and says so', async () => {
  const root = fixture();
  writeReport(root, 'packages/shared/logger', ['src/x.ts']);
  const said: string[] = [];
  await runCoverage({ root, runTests: false, write: (text) => said.push(text) });
  expect(said.join('\n')).toContain('It does not gate');
});

test('a merged report is written where a tool can read it back', async () => {
  const root = fixture();
  writeReport(root, 'packages/shared/logger', ['src/x.ts']);
  await runCoverage({ root, runTests: false, write: () => {} });
  const written = join(root, 'coverage', 'lcov.info');
  expect(Bun.file(written).size).toBeGreaterThan(0);
  expect(await Bun.file(written).text()).toContain('SF:packages/shared/logger/src/x.ts');
});

test('a failing test lane produces no number at all', async () => {
  const root = fixture();
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules', '.bin', 'moon'), '#!/bin/sh\nexit 0\n');
  const said: string[] = [];
  const result = await runCoverage({
    root,
    runTests: true,
    write: (text) => said.push(text),
    run: async () => ({ code: 7, stdout: 'lina ran', stderr: 'one test failed' }),
  });
  expect(result.code).toBe(7);
  expect(result.summary).toBeUndefined();
});

test('the lane runs uncached, because a cached hit writes no report', async () => {
  const root = fixture();
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules', '.bin', 'moon'), '#!/bin/sh\nexit 0\n');
  writeReport(root, 'packages/shared/logger', ['src/x.ts']);
  const calls: string[][] = [];
  await runCoverage({
    root,
    runTests: true,
    write: () => {},
    run: async (options) => {
      calls.push([options.command, ...(options.args ?? [])]);
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  expect(calls).toHaveLength(1);
  const [command, ...args] = calls.at(0) ?? [];
  expect(command.endsWith('moon')).toBe(true);
  expect(args).toContain('--cache');
  expect(args[args.indexOf('--cache') + 1]).toBe('off');
  expect(args).toContain('--coverage-reporter=lcov');
});

test('a missing moon is a named prerequisite, not a crash', async () => {
  const root = fixture();
  const said: string[] = [];
  const result = await runCoverage({ root, runTests: true, write: (text) => said.push(text) });
  expect(result.code).toBe(3);
  expect(said.join('\n')).toContain('moon is not in this workspace');
});
test('a crate with no package.json is named rather than silently absent', async () => {
  const root = fixture();
  // A Cargo project is not a Node package: the workspace discovery cannot see it,
  // so it never reaches the "produced no report" list.
  mkdirSync(join(root, 'apps/backend/media'), { recursive: true });
  writeFileSync(join(root, 'apps/backend/media/Cargo.toml'), '[package]\nname = "media"\n');
  writeReport(root, 'packages/shared/logger', ['src/x.ts']);

  const { crates } = discoverReports(root);
  expect(crates).toEqual(['apps/backend/media']);

  const said: string[] = [];
  await runCoverage({ root, runTests: false, write: (text) => said.push(text) });
  const output = said.join('\n');
  expect(output).toContain('apps/backend/media');
  expect(output).toContain('Cargo crate');
});

test('a Tauri shell crate is not reported as a first-party crate', () => {
  const root = fixture();
  mkdirSync(join(root, 'apps/frontend/native/src-tauri'), { recursive: true });
  writeFileSync(join(root, 'apps/frontend/native/src-tauri/Cargo.toml'), '[package]\n');
  expect(discoverReports(root).crates).toEqual([]);
});
