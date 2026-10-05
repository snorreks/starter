// scripts/src/coverage/coverage.ts
//
// One coverage number for this workspace, and an honest account of what it does
// and does not cover.
//
// `bun run coverage` runs the credential-free unit lane with Bun's lcov reporter,
// merges every report into one file, and prints the totals. It reports; it never
// fails a build, because a percentage with a floor underneath it turns "a new
// untested file" into a broken pipeline.
//
// Three decisions are load-bearing and each one exists to stop this command
// reporting something that is not true.
//
//   1. The tests are run with `--cache off`, deliberately ignoring the cache gate
//      `bun run test` uses. A cached Moon hit skips the task, so a covered lane
//      produces no fresh lcov, and the merge would then read whatever a previous
//      run happened to leave on disk — a percentage describing a tree that is no
//      longer this one. Coverage that can be served from cache is not coverage.
//
//   2. Zero reports is a failure, not a zero. An empty merge totals to nothing,
//      and a percentage of nothing prints as 0% with no error, which reads as
//      "nothing here is tested" rather than "the flags never reached the test
//      runners". The first is a finding; the second is a broken command.
//
//   3. A workspace package that produced no report is named, not omitted. The
//      merged total covers the packages that reported, and the difference between
//      that set and every package in the workspace is exactly the part of the
//      number a reader cannot see. Printing only the total would let the two Rust
//      crates — deliberately outside `:test`, for the reasons their moon.yml
//      records — pass as measured.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readWorkspacePackages } from '../guards/module_graph.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { runBounded } from '../shared/run_bounded.ts';

/** Where each project writes its report, relative to that project. */
export const COVERAGE_DIR = 'coverage';
export const COVERAGE_FILE = 'lcov.info';

/**
 * Appended to every project's test task.
 *
 * `--coverage-reporter=lcov` rather than the default `text`: Bun's text reporter
 * prints a table per package and discards the data, so there would be nothing to
 * merge and the whole command would be a second, prettier `:test`.
 */
export const COVERAGE_TEST_ARGS: readonly string[] = [
  '--coverage',
  '--coverage-reporter=lcov',
  `--coverage-dir=${COVERAGE_DIR}`,
];

export interface ReportDiscovery {
  readonly reports: readonly import('./lcov.ts').CoverageReport[];
  /** Workspace-relative directories that hold no report, root excluded. */
  readonly silent: readonly string[];
  /**
   * First-party Cargo crates, which produce no report and cannot: they are not
   * Node packages, so the workspace discovery above never sees them at all.
   *
   * Listed separately rather than folded into `silent` because they are missing
   * for a different reason. `apps/backend/media` has no `package.json`, so
   * `readWorkspacePackages` skips it as not a Node package — which means a reader
   * given only the `silent` list would believe the total covers the repository
   * when a whole crate is absent from it. `src-tauri` is excluded: the native
   * shell's own JavaScript is measured through its parent project.
   */
  readonly crates: readonly string[];
}

/**
 * First-party crates under `apps/` and `packages/`, two levels deep.
 *
 * Two, because that is where they live: `apps/backend/media` is a child of a
 * child. Checking only one level finds nothing and reports an empty list, which
 * is the failure this function exists to prevent — an empty exclusion list reads
 * as "nothing is being excluded".
 */
const discoverCrates = (root: string): string[] => {
  const found = new Set<string>();
  const dirsAt = (dir: string): string[] => {
    const absolute = join(root, dir);
    if (!existsSync(absolute)) {
      return [];
    }
    return readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${dir}/${entry.name}`);
  };

  for (const group of ['apps', 'packages']) {
    for (const level1 of [group, ...dirsAt(group)]) {
      for (const level2 of [level1, ...dirsAt(level1)]) {
        if (existsSync(join(root, level2, 'Cargo.toml')) && !level2.endsWith('src-tauri')) {
          found.add(level2);
        }
      }
    }
  }
  return [...found].sort();
};

/**
 * Every lcov report in the workspace, paired with the directory its paths are
 * relative to.
 *
 * The root is included because its own paths would otherwise be relative to
 * nothing, and because a root-level report is how the merged file is written —
 * a report discovered and merged in the same pass would otherwise read itself.
 */
export const discoverReports = (root: string): ReportDiscovery => {
  const reports: import('./lcov.ts').CoverageReport[] = [];
  const silent: string[] = [];

  const read = (projectDir: string): boolean => {
    const file = join(root, projectDir, COVERAGE_DIR, COVERAGE_FILE);
    if (!existsSync(file)) {
      return false;
    }
    reports.push({ projectDir, text: readFileSync(file, 'utf8') });
    return true;
  };

  read('');
  for (const pkg of readWorkspacePackages(root).values()) {
    if (!read(pkg.dir)) {
      silent.push(pkg.dir);
    }
  }

  return { reports, silent, crates: discoverCrates(root) };
};

/** Project label for a report, for the table. */
const labelFor = (projectDir: string): string => (projectDir === '' ? '.' : projectDir);

const formatPercent = (hit: number, found: number): string => {
  if (found === 0) {
    return 'n/a';
  }
  return `${((hit / found) * 100).toFixed(1)}%`;
};

export interface CoverageRunOptions {
  root?: string;
  run?: typeof runBounded;
  write?: (text: string) => void;
  /** Run the unit lane first. Off means merge only what is already on disk. */
  runTests: boolean;
}

export interface CoverageRunResult {
  readonly code: number;
  /** Set when the number was produced; absent when the command refused. */
  readonly summary?: string;
}

/**
 * Produce the merged report and its totals.
 *
 * Returns the exit code rather than calling `process.exit`, so the whole command
 * is reachable from a test without a subprocess.
 */
export const runCoverage = async (options: CoverageRunOptions): Promise<CoverageRunResult> => {
  const root = options.root ?? REPO_ROOT;
  const run = options.run ?? runBounded;
  const write = options.write ?? ((text: string) => process.stdout.write(`${text}\n`));

  if (options.runTests) {
    // `--cache off` for the reason in the header: a cached hit produces no report.
    const moon = join(root, 'node_modules', '.bin', 'moon');
    if (!existsSync(moon)) {
      write(
        'moon is not in this workspace, so the test lane cannot be run.\n' +
          'Re-run with --no-run to merge the reports already on disk.',
      );
      return { code: 3 };
    }
    const result = await run({
      command: moon,
      args: [
        'run',
        '--cache',
        'off',
        ':test',
        '--',
        ...COVERAGE_TEST_ARGS,
      ],
      cwd: root,
    });
    if (result.code !== 0) {
      // The lane failed. A coverage number computed over a half-run lane is a
      // number about a tree that was never tested, so it is not printed at all.
      write(result.stdout);
      write(result.stderr);
      return { code: result.code };
    }
  }

  const { reports, silent, crates } = discoverReports(root);
  if (reports.length === 0) {
    write(
      'No coverage reports were found, so there is no number to report.\n' +
        `Expected ${COVERAGE_DIR}/${COVERAGE_FILE} in a workspace package.\n` +
        'If the test lane ran, the coverage flags did not reach the test runners:\n' +
        `  moon run --cache off :test -- ${COVERAGE_TEST_ARGS.join(' ')}`,
    );
    return { code: 1 };
  }

  const { mergeReports, renderLcov, total } = await import('./lcov.ts');
  const merged = mergeReports(reports);
  const totals = total(merged);

  if (totals.files === 0) {
    write(
      `${reports.length} report(s) were found but none of them carried any line or\n` +
        'function data, so there is still no number. That is a broken reporter, not\n' +
        'an untested repository.',
    );
    return { code: 1 };
  }

  const mergedPath = join(root, COVERAGE_DIR, COVERAGE_FILE);
  mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
  writeFileSync(mergedPath, renderLcov(merged));

  const perProject = reports
    .map((report) => {
      const files = mergeReports([report]);
      return { project: labelFor(report.projectDir), ...total(files) };
    })
    .sort((left, right) => left.project.localeCompare(right.project));

  const rows = perProject.map((entry) => ({
    project: entry.project,
    files: String(entry.files),
    lines: `${entry.linesHit}/${entry.linesFound}`,
    linePct: formatPercent(entry.linesHit, entry.linesFound),
    fns: `${entry.functionsHit}/${entry.functionsFound}`,
    fnPct: formatPercent(entry.functionsHit, entry.functionsFound),
  }));

  const header = ['project', 'files', 'lines', 'lines %', 'functions', 'functions %'];
  const widths = header.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => Object.values(row)[index]?.length ?? 0)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();

  const summary = [
    line(header),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) =>
      line([row.project, row.files, row.lines, row.linePct, row.fns, row.fnPct]),
    ),
    line(widths.map((width) => '-'.repeat(width))),
    line([
      'TOTAL',
      String(totals.files),
      `${totals.linesHit}/${totals.linesFound}`,
      formatPercent(totals.linesHit, totals.linesFound),
      `${totals.functionsHit}/${totals.functionsFound}`,
      formatPercent(totals.functionsHit, totals.functionsFound),
    ]),
  ].join('\n');

  write(summary);
  write(`\nlines ${formatPercent(totals.linesHit, totals.linesFound)} · ` +
    `functions ${formatPercent(totals.functionsHit, totals.functionsFound)} · ` +
    `merged report: ${relative(root, mergedPath)}`);
  write(
    'No branch figure: Bun writes no BRDA records, so there is no branch data to\n' +
      'aggregate. Reporting one would mean inventing it.',
  );
  if (silent.length > 0) {
    write(
      `\nNot in this number — ${silent.length} Node workspace package(s) produced no report:\n` +
        silent.map((dir) => `  ${dir}`).join('\n'),
    );
  }
  if (crates.length > 0) {
    write(
      `\nAlso not in this number — ${crates.length} Cargo crate(s):\n` +
        crates.map((dir) => `  ${dir}`).join('\n') +
        '\nThey are outside `:test` by design: their tasks are named cargo-* so that\n' +
        '`moon run :test` does not require a Rust toolchain, FFmpeg or Docker. They\n' +
        'are also invisible to the Node workspace — a crate has no package.json —\n' +
        'so they never appeared in the list above. `bun run test:compute` is the lane\n' +
        'that exercises them, and it is not in this number either.',
    );
  }
  write('\nThis reports. It does not gate: no threshold is checked, so an untested new\nfile lowers the number without failing anything.');

  return { code: 0, summary };
};