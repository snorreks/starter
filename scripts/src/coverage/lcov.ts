// scripts/src/coverage/lcov.ts
//
// Merging the lcov reports Bun writes, one per workspace package, into a single
// number that is not a lie.
//
// Two things about Bun's output decide the shape of this module, and both were
// read off a real report rather than assumed from the lcov specification:
//
//  1. `SF:` is relative to the package that produced it, and it points *outside*
//     that package as often as not. A test in `packages/shared/logger` reports
//     `SF:../schemas/src/logging/index.ts`, because the file it exercises lives
//     in another workspace package. So a merged report keyed on the raw `SF:`
//     holds one record per (project, file) pair, and a schemas file exercised by
//     four packages is counted four times over — inflating the denominator and
//     making the total depend on how many packages happen to import a file rather
//     than on how much of the repository is tested. Every path is therefore
//     resolved against the package directory and normalised to a repository-
//     relative one, so the same file merges into one record.
//
//  2. Bun writes `TN:`, `SF:`, `FNF:`, `FNH:`, `DA:`, `LF:`, `LH:` and
//     `end_of_record`. It writes no `FN:`/`FNDA:` and no `BRDA:`. Function
//     coverage comes from the `FNF`/`FNH` pair and there is no branch data to
//     report at all, so nothing here invents a branch percentage.
//
// The per-file summary headers (`LF:`, `LH:`, `FNF:`, `FNH:`) are recomputed
// from the merged line and function records rather than summed from the inputs.
// A merge that trusts them adds a second source of truth to the output, and a
// disagreement between the two would then be invisible in the merged file and
// visible only in whichever tool reads it.

import { posix } from 'node:path';

/** One file's coverage, as read from a report. */
export interface FileCoverage {
  /** Repository-relative, forward-slashed path. */
  readonly path: string;
  /** Line number to execution count. */
  readonly lines: ReadonlyMap<number, number>;
  /** Functions found in this file. */
  readonly functionsFound: number;
  /** Functions in this file that ran. */
  readonly functionsHit: number;
}

/** One report, and the package directory its paths are relative to. */
export interface CoverageReport {
  /** Repository-relative directory of the package that produced the report. */
  readonly projectDir: string;
  /** The raw lcov text. */
  readonly text: string;
}

/**
 * Resolve a report path against the package that produced it.
 *
 * The package directory is the base because Bun's paths are relative to it, and
 * normalisation is what collapses `../schemas/src/x` from `logger` and
 * `src/x` from `schemas` onto the same repository-relative string. Exported
 * because the identity of that string is the whole reason the merge is correct,
 * and a caller that reimplemented it as a plain prefix would silently undo it.
 */
export const resolveReportPath = (projectDir: string, reportPath: string): string => {
  const base = projectDir === '' ? '' : `${projectDir}/`;
  return posix.normalize(`${base}${reportPath}`).replace(/^\.\//, '');
};

const toCount = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Read every file record out of one report.
 *
 * A line whose count is absent, unparseable or negative counts as never run: the
 * only safe reading of a malformed count is the pessimistic one, because the
 * optimistic reading turns a broken report into an inflated percentage.
 */
export const parseReport = (report: CoverageReport): FileCoverage[] => {
  const files = new Map<string, { lines: Map<number, number>; found: number; hit: number }>();

  let path: string | undefined;
  let lines: Map<number, number> | undefined;
  let found = 0;
  let hit = 0;

  const flush = (): void => {
    if (path !== undefined && lines !== undefined) {
      files.set(path, { lines, found, hit });
    }
    path = undefined;
    lines = undefined;
    found = 0;
    hit = 0;
  };

  for (const raw of report.text.split('\n')) {
    const line = raw.trim();
    if (line === 'end_of_record') {
      flush();
      continue;
    }
    if (line.startsWith('SF:')) {
      // A record without a preceding `end_of_record` is a truncated report, not
      // two files in one.
      flush();
      path = resolveReportPath(report.projectDir, line.slice(3));
      lines = new Map();
      continue;
    }
    if (lines === undefined) {
      continue;
    }
    if (line.startsWith('DA:')) {
      const [number, count] = line.slice(3).split(',');
      const lineNumber = Number.parseInt(number ?? '', 10);
      if (Number.isNaN(lineNumber)) {
        continue;
      }
      lines.set(lineNumber, Math.max(0, toCount(count)));
      continue;
    }
    if (line.startsWith('FNF:')) {
      found = Math.max(0, toCount(line.slice(4)));
      continue;
    }
    if (line.startsWith('FNH:')) {
      hit = Math.max(0, toCount(line.slice(4)));
    }
  }
  flush();

  return [...files.entries()].map(([filePath, entry]) => ({
    path: filePath,
    lines: entry.lines,
    functionsFound: entry.found,
    functionsHit: Math.min(entry.hit, entry.found),
  }));
};

/**
 * Merge reports into one, summing a line's execution count when two packages
 * both exercise it.
 *
 * Summing is what makes "hit" mean hit: a line reached by any project is a line
 * the repository exercised, and a count of zero in one project and five in
 * another is five, not zero.
 */
export const mergeReports = (reports: readonly CoverageReport[]): FileCoverage[] => {
  const merged = new Map<string, { lines: Map<number, number>; found: number; hit: number }>();

  for (const report of reports) {
    for (const file of parseReport(report)) {
      const existing = merged.get(file.path) ?? {
        lines: new Map<number, number>(),
        found: 0,
        hit: 0,
      };
      for (const [line, count] of file.lines) {
        existing.lines.set(line, (existing.lines.get(line) ?? 0) + count);
      }
      existing.found += file.functionsFound;
      existing.hit += file.functionsHit;
      merged.set(file.path, existing);
    }
  }

  return [...merged.entries()]
    .map(([filePath, entry]) => ({
      path: filePath,
      lines: entry.lines,
      functionsFound: entry.found,
      functionsHit: Math.min(entry.hit, entry.found),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
};

/** The totals a summary is computed from. */
export interface CoverageTotals {
  readonly files: number;
  readonly linesFound: number;
  readonly linesHit: number;
  readonly functionsFound: number;
  readonly functionsHit: number;
}

/**
 * Total a set of files.
 *
 * `files` counts files that carried any line data at all. A file with zero lines
 * found would otherwise divide by a clean zero and report a percentage that
 * looks like a measurement.
 */
export const total = (files: readonly FileCoverage[]): CoverageTotals => {
  let linesFound = 0;
  let linesHit = 0;
  let functionsFound = 0;
  let functionsHit = 0;
  let counted = 0;

  for (const file of files) {
    if (file.lines.size === 0 && file.functionsFound === 0) {
      continue;
    }
    counted += 1;
    linesFound += file.lines.size;
    for (const count of file.lines.values()) {
      if (count > 0) {
        linesHit += 1;
      }
    }
    functionsFound += file.functionsFound;
    functionsHit += file.functionsHit;
  }

  return { files: counted, linesFound, linesHit, functionsFound, functionsHit };
};

/** A percentage, or null when there was nothing to divide by. */
export const percent = (hit: number, found: number): number | null =>
  found === 0 ? null : (hit / found) * 100;

/** Render one lcov record per file, with the summary headers recomputed. */
export const renderLcov = (files: readonly FileCoverage[]): string => {
  const out: string[] = [];
  for (const file of files) {
    out.push('TN:');
    out.push(`SF:${file.path}`);
    out.push(`FNF:${file.functionsFound}`);
    out.push(`FNH:${file.functionsHit}`);
    for (const [line, count] of [...file.lines.entries()].sort(([a], [b]) => a - b)) {
      out.push(`DA:${line},${count}`);
    }
    out.push(`LF:${file.lines.size}`);
    out.push(`LH:${[...file.lines.values()].filter((count) => count > 0).length}`);
    out.push('end_of_record');
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
};
