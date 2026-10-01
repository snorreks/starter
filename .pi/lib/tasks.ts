// .pi/lib/tasks.ts
//
// Discover and run this repository's real tasks, through its own task runner.
//
// 🔴 Why not `bun run <script>` guessed from `package.json`: the repository's
// scripts are *entry points*, and several of them are Moon aggregates
// (`bun run test` is `moon run :test`). Guessing which task id to run means
// guessing which project graph edge carries the caching, the inputs and the
// `preset: server` marker. `moon query tasks` is the authority, and it is a real
// documented query — so this reads it rather than hardcoding a task list that
// goes stale the first time a project is added.
//
// Two facts about the CLI that this file encodes, both learned the hard way:
//
//   1. **The `$ …` banner goes to stderr, not stdout.** `bun run moon query
//      tasks` writes `$ bunx moon query tasks` on stderr and pure JSON on stdout.
//      Merging the streams — the obvious thing to do — makes `JSON.parse` fail on
//      a valid response.
//   2. **The tool is reached through the root script.** AGENTS.md is explicit
//      that a tool is run through the package that declares it. Here that is the
//      root `package.json`'s `moon` script, so this never runs `bunx` itself.
//
// Lives outside `.pi/extensions/` because that directory is Pi's discovery input
// and every module in it is loaded as an extension on start.

import type { BoundedRunResult } from './process.ts';

/** Bounds for a task query. A graph dump is tens of KB; anything larger is a runaway. */
export const QUERY_BOUNDS = {
  timeoutMs: 60_000,
  maxBytes: 4 * 1024 * 1024,
} as const;

/** Bounds for one task run. Generous, because `e2e` legitimately takes minutes. */
export const TASK_BOUNDS = {
  timeoutMs: 900_000,
  maxBytes: 512 * 1024,
} as const;

/**
 * The runner seam.
 *
 * Injected rather than imported so the tests can drive a real `bun`/`node`
 * process against a real fixture instead of stubbing a function. `runBounded` is
 * the default in production; the tests pass their own.
 */
export type TaskRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; maxBytes: number },
) => Promise<BoundedRunResult>;

/** One task as `moon query tasks` reports it. */
export interface MoonTask {
  /** Stable, human-usable selector: `<project>:<task>`, e.g. `pi:test`. */
  id: string;
  project: string;
  task: string;
  command: string;
  args: string[];
}

/** Raised when the runner is missing or the query failed — never swallowed. */
export class TaskQueryError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'TaskQueryError';
  }
}

/**
 * Ask Moon for the task graph.
 *
 * Parses **stdout only**, for the reason in the header. A non-zero exit is a
 * failure to report, not an empty graph: returning `{}` for a broken workspace
 * would leave the model concluding the repository has no tasks, which is a
 * confident wrong answer rather than a visible error.
 */
export const queryTasks = async (
  cwd: string,
  run: TaskRunner,
  bounds: { timeoutMs: number; maxBytes: number } = QUERY_BOUNDS,
): Promise<MoonTask[]> => {
  const result = await run('bun', ['run', 'moon', 'query', 'tasks'], { cwd, ...bounds });

  if (result.code !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || 'no output';
    throw new TaskQueryError(
      `moon query tasks exited ${result.code}: ${reason.slice(0, 600)}`,
      result.code,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new TaskQueryError(
      `moon query tasks printed something that is not JSON (${
        error instanceof Error ? error.message : String(error)
      }). First 200 characters: ${result.stdout.slice(0, 200)}`,
      result.code,
    );
  }

  return flattenTasks(parsed);
};

/**
 * Turn the query's nested shape into a flat, sorted list.
 *
 * Exported because it is pure and the interesting one to test: the shape is
 * Moon's, the tolerance is ours, and a field rename upstream should fail a test
 * rather than silently yield zero tasks.
 */
export const flattenTasks = (parsed: unknown): MoonTask[] => {
  const graph = (parsed as { tasks?: unknown } | null)?.tasks;
  if (graph === undefined || graph === null || typeof graph !== 'object') {
    throw new TaskQueryError('moon query tasks returned no "tasks" object', 0);
  }

  const out: MoonTask[] = [];
  for (const [project, tasks] of Object.entries(graph as Record<string, unknown>)) {
    if (tasks === null || typeof tasks !== 'object') {
      continue;
    }
    for (const [task, node] of Object.entries(tasks as Record<string, unknown>)) {
      const entry = node as { command?: unknown; args?: unknown } | null;
      const command = typeof entry?.command === 'string' ? entry.command : '';
      const args = Array.isArray(entry?.args)
        ? entry.args.filter((value): value is string => typeof value === 'string')
        : [];
      out.push({ id: `${project}:${task}`, project, task, command, args });
    }
  }

  // Sorted so two runs in the same repository state list tasks in the same
  // order; an unstable listing makes a diff of the output look like a change.
  return out.sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * Filter tasks by substring against `project:task`, `project`, `task` or `command`.
 *
 * `moon` has its own query syntax, but it is a different syntax per filter
 * (`--id`, `--command`, positional query) and guessing which one a model meant
 * produces a confusing empty result. Substring matching over the whole graph is
 * predictable and, at 89 tasks, fast enough to always just search.
 */
export const filterTasks = (tasks: MoonTask[], query: string | undefined): MoonTask[] => {
  const needle = query?.trim().toLowerCase() ?? '';
  if (needle === '') {
    return tasks;
  }
  return tasks.filter((task) =>
    `${task.id} ${task.command} ${task.args.join(' ')}`.toLowerCase().includes(needle),
  );
};

/**
 * Whether a selector names a task that exists.
 *
 * Used to turn a typo into a suggestion rather than a Moon error the model has
 * to interpret. `moon` answers an unknown task with a generic failure, and the
 * useful part — "did you mean `pi:test`?" — has to come from here.
 */
export const resolveTask = (tasks: MoonTask[], id: string): MoonTask | undefined =>
  tasks.find((task) => task.id === id.trim());

/** Nearest ids to a selector that named nothing, by shared prefix length. */
export const suggestTasks = (tasks: MoonTask[], id: string, limit = 5): string[] => {
  const needle = id.trim().toLowerCase();
  const scored = tasks
    .map((task) => {
      const candidate = task.id.toLowerCase();
      let score = 0;
      while (
        score < needle.length &&
        score < candidate.length &&
        needle[score] === candidate[score]
      ) {
        score += 1;
      }
      return { id: task.id, score };
    })
    .filter((entry) => entry.score > 0)
    // Ties broken by id so the suggestion list is stable between runs.
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit).map((entry) => entry.id);
};

/**
 * Argv for running one task.
 *
 * `--` separates Moon's own options from the task's arguments. Emitting the
 * separator unconditionally is what keeps an extra argument from being read as a
 * Moon flag — `moon run pi:test --reporter=x` is a Moon error, and `--reporter=x`
 * was meant for the task.
 */
export const buildRunArgs = (id: string, taskArgs: readonly string[] = []): string[] => {
  const args = ['run', 'moon', 'run', id.trim()];
  if (taskArgs.length > 0) {
    args.push('--', ...taskArgs);
  }
  return args;
};

/**
 * A compact, model-facing rendering of the task list.
 *
 * Columns rather than JSON: the model reads a table, and a 89-entry JSON dump is
 * the transcript equivalent of the output bound this whole directory exists to
 * avoid.
 */
export const renderTaskTable = (tasks: MoonTask[]): string => {
  if (tasks.length === 0) {
    return 'No tasks matched.';
  }
  const width = Math.max(...tasks.map((task) => task.id.length));
  const lines = tasks.map((task) =>
    `  ${task.id.padEnd(width)}  ${task.command} ${task.args.join(' ')}`.trimEnd(),
  );
  return [`${tasks.length} task(s):`, ...lines].join('\n');
};
