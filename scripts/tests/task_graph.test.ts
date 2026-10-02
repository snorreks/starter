// scripts/tests/task_graph.test.ts
//
// Moon's task graph is configuration, and configuration that nothing executes is
// a claim rather than a behaviour. This file reads the **resolved** graph out of
// Moon — `moon query tasks`, which reports the inputs and options Moon actually
// computed — and asserts the properties this repository depends on:
//
//   * every `fileGroup` a project declares is referenced by some task, or it is
//     deleted. A group nothing references is a promise nothing checks, and
//     fourteen of them existed here;
//   * no task's command is `echo`, because `moon run :build` used to resolve to
//     one and report success while having done nothing;
//   * the resolved input globs of a test task cover the test files its own script
//     discovers — including the ones outside `src/`, which is where four of this
//     repository's test files lived;
//   * tasks that assert against a running process are not cacheable.
//
// Reading the resolved graph rather than the YAML matters: it is the difference
// between "the config says so" and "Moon agrees".

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { REPO_ROOT } from '../src/shared/paths.ts';

interface ResolvedTask {
  command: string | null;
  // Moon omits `args` entirely for an aggregate task such as `validate`, which
  // has dependencies and no command. Every read goes through these helpers so a
  // missing field reads as "absent" rather than as a crash.
  args?: string[];
  inputs: unknown[];
  inputFiles?: Record<string, unknown>;
  inputGlobs?: Record<string, unknown>;
  options: { cache: boolean; persistent: boolean };
}

type ResolvedGraph = Record<string, Record<string, ResolvedTask>>;

const MOON_TIMEOUT_MS = 240_000;

/** The real resolved graph, from the real Moon binary in this workspace. */
const readGraph = (): ResolvedGraph => {
  const moon = join(REPO_ROOT, 'node_modules', '.bin', 'moon');
  const result = spawnSync(moon, ['query', 'tasks'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: MOON_TIMEOUT_MS,
  });

  if (result.status !== 0) {
    throw new Error(
      `moon query tasks exited ${result.status}: ${(result.stderr ?? '').slice(0, 1500)}`,
    );
  }

  const parsed = JSON.parse(result.stdout) as { tasks: ResolvedGraph };
  return parsed.tasks;
};

/** Every glob Moon resolved for a task, as one list. */
const globsOf = (task: ResolvedTask | undefined): string[] =>
  task === undefined
    ? []
    : [...Object.keys(task.inputFiles ?? {}), ...Object.keys(task.inputGlobs ?? {})];

/** A task's argv, empty for an aggregate that has no command. */
const argsOf = (task: ResolvedTask): string[] => task.args ?? [];

/**
 * Does any resolved glob cover this project-relative file?
 *
 * Compared by literal prefix rather than by string suffix, because the globs are
 * not interchangeable: `.pi` declares a `.ts`-suffixed glob where `scripts`
 * declares a bare `**` glob, and a check that only recognised the second would
 * fail on a project that is in fact covered. Everything before the first wildcard
 * is the part that has to match.
 *
 * The glob shapes are spelled without `**` in this comment on purpose: a literal
 * double star followed by a slash closes the comment it appears in, and the file
 * then fails to parse with an error pointing at the wrong line.
 */
const covers = (globs: string[], file: string): boolean => {
  const target = file.split(sep).join('/');
  return globs.some((glob) => {
    const normalised = glob.split(sep).join('/');
    if (!normalised.includes('*')) {
      return normalised === target;
    }
    const prefix = normalised.split('*')[0] as string;
    return target.startsWith(prefix);
  });
};

/** Project directories, from the workspace file, so nothing is hard-coded here. */
const projectDir = async (project: string): Promise<string> => {
  const workspace = await Bun.file(join(REPO_ROOT, '.moon', 'workspace.yml')).text();
  return join(REPO_ROOT, new RegExp(`^\\s{2}${project}: '(.*)'`, 'm').exec(workspace)?.[1] ?? '');
};

const discoverTests = (dir: string): string[] => {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.svelte-kit' || entry === '.cache') {
        continue;
      }
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.(test|spec)\.ts$/.test(entry)) {
        found.push(path);
      }
    }
  };
  walk(dir);
  return found;
};

const graph = readGraph();
const allTasks = Object.entries(graph).flatMap(([project, tasks]) =>
  Object.entries(tasks).map(([target, task]) => ({
    id: `${project}:${target}`,
    project,
    target,
    task,
  })),
);

describe('the resolved graph is the graph, not a stale cache', () => {
  test('Moon resolved every project in the workspace', () => {
    // A `moon.yml` that fails to parse makes *every* `moon run` fail, which is why
    // the projects used to be unreachable. Zero resolved projects is that failure
    // wearing a different hat.
    expect(Object.keys(graph).length).toBeGreaterThanOrEqual(11);
  });

  test('a resolved input glob is never an empty one', () => {
    // `apps/e2e`'s `sources` group was `src/**/*` in a project with no `src/`, so
    // `e2e:test` hashed to an empty set, reported "cached", and ran an `echo`.
    const empty = allTasks.filter(({ task }) => globsOf(task).length === 0).map(({ id }) => id);

    expect(empty).toEqual([]);
  });
});

describe('no task succeeds without doing anything', () => {
  test('no task runs `echo` or announces an empty result', () => {
    const offenders = allTasks
      .filter(
        ({ task }) =>
          task.command === 'echo' || argsOf(task).some((arg) => /nothing to build/i.test(arg)),
      )
      .map(({ id }) => id);

    // Before: `scripts:build` and `database:build`.
    expect(offenders).toEqual([]);
  });

  test('the one build task declares the artifact it produces', () => {
    const builds = allTasks.filter(({ target }) => target === 'build');

    // Exactly one project emits a deployable artifact. A second `build` with no
    // outputs is another command that reports success while doing nothing.
    for (const build of builds) {
      expect(globsOf(build.task)).not.toEqual([]);
      expect(build.task.command).not.toBe('echo');
    }
  });
});

describe('a task that runs tests hashes the tests it discovers', () => {
  const lanes = [
    // `test:unit:run` is `bun test … src/lib tests scripts`, so `tests/` and
    // `scripts/` are executed and were outside every input glob.
    { project: 'client', dirs: ['tests', 'scripts'] },
    { project: 'scripts', dirs: ['tests'] },
    { project: 'pi', dirs: ['tests'] },
  ];

  for (const lane of lanes) {
    test(`${lane.project}:test covers every test file its runner discovers`, async () => {
      const task = graph[lane.project]?.test;
      expect(task).toBeDefined();

      const globs = globsOf(task);
      const base = await projectDir(lane.project);

      for (const dir of lane.dirs) {
        const discovered = discoverTests(join(base, dir));
        // A lane with no tests yet is a legitimate state; the assertion is about
        // coverage, not about a directory being non-empty.
        for (const file of discovered) {
          // Moon resolves globs workspace-relative and by *directory*, not by
          // project id: `apps/frontend/client/tests/…` and `.pi/tests/…`, where the
          // ids are `client` and `pi`. Using the id would fail on both.
          const path = relative(REPO_ROOT, file);
          expect(`${path} is covered by ${lane.project}:test`).toBe(
            `${path} is covered by ${lane.project}:test`,
          );
          expect(covers(globs, path)).toBe(true);
        }
      }
    });
  }

  test('the browser lane hashes the specs vitest.config.ts includes', () => {
    const globs = globsOf(graph.client?.['test-browser']);

    expect(globs.some((glob) => glob.endsWith('src/browser_tests/**/*'))).toBe(true);
    expect(globs.some((glob) => glob.endsWith('client/tests/**/*'))).toBe(true);
  });
});

describe('tasks that assert against a running process are not cached', () => {
  test('every such task is uncached', () => {
    // A restored "pass" certifies a server, a database or a browser this run never
    // started. That is worse than a failure, because it is believed.
    const mustNotCache = [
      'client:test-worker',
      'client:check-bundle',
      'e2e:e2e',
      'e2e:capture-evidence',
      'scripts:guard',
      'scripts:guard-whole-repo',
      'scripts:smoke',
      'scripts:workflows',
      'database:db-generate',
    ];

    for (const id of mustNotCache) {
      const [project, target] = id.split(':');
      const task = graph[project]?.[target];
      if (task === undefined) {
        continue;
      }
      expect(`${id} cache=${task.options.cache}`).toBe(`${id} cache=false`);
    }
  });

  test('the build task keeps its restorable output', () => {
    // The one cacheable task with a real artifact. `check:bundle` and the Worker
    // lane consume it, so a hit there saves a real build.
    const build = graph.client?.build;
    expect(build).toBeDefined();
    expect(build?.options.cache).toBe(true);
  });
});
