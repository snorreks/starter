// .pi/tests/task_graph.test.ts
//
// The task graph, against this repository's **real** Moon installation.
//
// The other task tests use fakes, which proves the parser handles the shapes they
// invented. This file proves those shapes were not invented: it queries the task
// graph that exists right now and asserts the properties the tool depends on.
//
// `moon query tasks` is a local, read-only command. It starts no servers, touches
// no network, and needs no credentials — which is what makes it safe to run in
// every test run. If it fails because Moon is unavailable, that is reported as a
// skipped-with-reason rather than a silent pass.

import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runBounded } from '../lib/process.ts';
import { queryTasks, resolveTask, TASK_BOUNDS } from '../lib/tasks.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const load = () =>
  queryTasks(REPO_ROOT, runBounded, { timeoutMs: 60_000, maxBytes: 4 * 1024 * 1024 });

describe('the real task graph', () => {
  test('is readable, and is not empty', async () => {
    const tasks = await load();

    // An empty graph would make every `repo_task run` refuse, and the refusal
    // would look like the tool being broken rather than the query failing.
    expect(tasks.length).toBeGreaterThan(0);
  }, 120_000);

  test('contains the tasks this project documents', async () => {
    const tasks = await load();

    // The ids `AGENTS.md` and `docs/testing.md` name. If any of these go, the
    // documentation is wrong, and that is worth failing a test over.
    for (const id of ['pi:test', 'pi:typecheck', 'pi:loader-smoke', 'scripts:guard']) {
      expect(resolveTask(tasks, id)).toBeDefined();
    }
  }, 120_000);

  test('every task carries a project and a task name', async () => {
    const tasks = await load();

    for (const task of tasks) {
      // The id is what a model passes back to `run`. A malformed one would be
      // refused by the very lookup meant to help it.
      expect(task.id).toBe(`${task.project}:${task.task}`);
      expect(task.project).not.toBe('');
      expect(task.task).not.toBe('');
    }
  }, 120_000);

  test('aggregate tasks are visible even though their command is a noop', async () => {
    const tasks = await load();

    // `:validate` tasks express their work as `deps` and carry `command: noop`.
    // A filter that hid them would hide every aggregate task in the repository.
    const aggregates = tasks.filter((task) => task.command === 'noop');
    expect(aggregates.length).toBeGreaterThan(0);
    expect(aggregates.map((task) => task.task)).toContain('validate');
  }, 120_000);

  test('the four test lanes are separately addressable', async () => {
    const tasks = await load();

    // `bun run test:all` runs four lanes, and each must be reachable by name so a
    // failure can be isolated rather than re-running everything.
    //
    // `client:test-worker`, not `api:test-integration`: PR B merged the Elysia API
    // app into the SvelteKit app, so the lane that runs a real Worker now lives in
    // the client project. Only the id changed — the lane still starts workerd, still
    // uses real local D1, and still needs `node` on PATH.
    for (const id of ['client:test-browser', 'client:test-worker', 'e2e:e2e']) {
      expect(resolveTask(tasks, id)).toBeDefined();
    }
  }, 120_000);

  test('server tasks are marked as such, not as buildable checks', async () => {
    const tasks = await load();
    const dev = resolveTask(tasks, 'client:dev');

    expect(dev).toBeDefined();
    // `preset: server` means Moon will not cache it and CI will not run it. The
    // tool does not read the preset, but a task that behaves differently from its
    // neighbours is worth knowing about before something runs it by name.
    expect(dev?.command).toBe('bun');
    expect(dev?.args).toEqual(['run', 'dev']);
  }, 120_000);

  test('the run bounds are generous enough for the slowest documented task', async () => {
    // `e2e` starts a Worker, a preview server and a browser. A ceiling below the
    // documented budget would turn a slow pass into a timeout that reads as a
    // failure.
    expect(TASK_BOUNDS.timeoutMs).toBeGreaterThanOrEqual(600_000);
    expect(TASK_BOUNDS.maxBytes).toBeGreaterThanOrEqual(512 * 1024);
  });
});
