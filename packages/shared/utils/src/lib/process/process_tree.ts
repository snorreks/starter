// packages/shared/utils/src/lib/process/process_tree.ts
//
// Kill a subprocess *tree*, not a pid.
//
// Why this exists: `wrangler` is a Node shim that spawns `workerd` as its own
// child. Signalling wrangler alone leaves workerd running, and workerd holds the
// port. The observable symptom was a dev command that made the command after it
// fail:
//
//   Error: http://127.0.0.1:8788/api/health is already used, make sure that
//   nothing is running on the port/url or set reuseExistingServer:true
//
// — after a green E2E run. Every leaked process also pins memory and a D1
// handle, so repeated runs accumulate rather than recover.
//
// Why walk from a recorded root rather than use a pattern: `pkill -f wrangler`
// also matches the shell that launched it, which kills the caller. That is not a
// theoretical hazard; it is the reason the repository's dev scripts use PID files.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** `pid -> [child pid, ...]`, from one `ps` call. */
const parentMap = (): Map<number, number[]> => {
  let output = '';
  try {
    output = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return new Map();
  }

  const children = new Map<number, number[]>();
  for (const line of output.split('\n')) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number.parseInt(pidText ?? '', 10);
    const ppid = Number.parseInt(ppidText ?? '', 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
      continue;
    }
    const existing = children.get(ppid);
    if (existing === undefined) {
      children.set(ppid, [pid]);
    } else {
      existing.push(pid);
    }
  }
  return children;
};

/**
 * Every pid owned by `root`, transitively, root first.
 *
 * Walks *down* only. A pid that has been reparented to init is no longer reachable
 * from its launcher, which is precisely why `wrangler`'s workerd needs the tree
 * taken down in one pass rather than signalled after the fact.
 */
export const childPidsOf = (root: number): number[] => {
  const children = parentMap();
  const owned = [root];
  const queue: number[] = [root];

  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of children.get(current) ?? []) {
      if (owned.includes(child)) {
        continue;
      }
      owned.push(child);
      queue.push(child);
    }
  }
  return owned;
};

/**
 * Is a pid still running?
 *
 * A zombie answers `kill(pid, 0)` successfully, so the signal probe alone reports a
 * killed-but-unreaped child as alive. `killTree` would then report survivors it had
 * in fact terminated, and a caller could not tell a real leak from a corpse.
 *
 * On Linux the state is read from /proc. Elsewhere there is no portable equivalent,
 * and the signal probe is the honest answer available.
 */
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    // The state field follows the comm field, which is parenthesised and may itself
    // contain spaces or parentheses — so slice from the last ')'.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    return afterComm.trimStart().charAt(0) !== 'Z';
  } catch {
    return true;
  }
};

/** Block without a timer, so it survives the event loop draining during exit. */
export const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export interface KillTreeOptions {
  /** Signal for the first attempt. */
  signal?: NodeJS.Signals;
  /** Signal if it has not exited by then. */
  forceSignal?: NodeJS.Signals;
  /** Time to wait for the first signal. */
  graceMs?: number;
  /** 0 to disable the escalation wait entirely. */
  attempts?: number;
}

/**
 * Signal a whole tree, deepest first.
 *
 * Deepest-first matters: signalling a parent first can let it reap or reparent
 * children, and a reparented child is no longer findable.
 *
 * `root` is refused rather than coerced when it is not a real process id. To
 * `process.kill`, 0 means "every process in my own group" and 1 means init, and
 * `childPidsOf` would walk init's whole descendant list — so a caller that lost a
 * pid would get every process it owns signalled. A throw is the honest answer: the
 * caller has lost track of what it spawned, and that is not something to guess at.
 *
 * Returns the pids that were still alive when the call returned, so a caller can
 * report "these survived" rather than assuming success.
 */
export const killTree = (root: number, options: KillTreeOptions = {}): number[] => {
  if (!Number.isInteger(root) || root <= 1) {
    throw new Error(
      `killTree: ${String(root)} is not a usable root pid. ` +
        'Pass the pid of a process this process started; 0 and 1 would signal ' +
        'everything and init respectively.',
    );
  }

  const { signal = 'SIGTERM', forceSignal = 'SIGKILL', graceMs = 200, attempts = 25 } = options;

  const tree = childPidsOf(root).reverse();

  for (const pid of tree) {
    if (!isAlive(pid)) {
      continue;
    }
    try {
      process.kill(pid, signal);
    } catch {
      /* raced with exit */
    }
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const alive = tree.filter((pid) => isAlive(pid));
    if (alive.length === 0) {
      return [];
    }
    if (attempt === 0 && graceMs > 0) {
      sleepSync(graceMs);
    } else {
      sleepSync(graceMs);
    }

    for (const pid of alive) {
      try {
        process.kill(pid, forceSignal);
      } catch {
        /* raced with exit */
      }
    }
  }

  return tree.filter((pid) => isAlive(pid));
};
