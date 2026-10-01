// packages/shared/utils/src/lib/process/process_tree.test.ts
//
// Process-tree teardown, against real processes.
//
// The defect this covers was observed, not hypothesised: a green Playwright E2E run
// left a `workerd` holding port 8788, and the next `bun run e2e` refused with
// "already used". Signalling `wrangler` alone does nothing, because `wrangler` is a
// Node shim whose `workerd` grandchild is what holds the port.
//
// These tests spawn real process trees — `sh` that itself spawns a `sleep` — so
// they observe actual parenting rather than a mock's idea of it.

import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { childPidsOf, isAlive, killTree, sleepSync } from './process_tree.ts';

/** A `sh` that spawns a long-lived grandchild, so the tree is at least 3 deep. */
const spawnTree = () => {
  const child = spawn('sh', ['-c', 'sleep 120 & echo $!; wait'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return { child, pid: child.pid as number };
};

const started: number[] = [];

afterEach(() => {
  for (const pid of started.splice(0)) {
    killTree(pid, { attempts: 3 });
  }
});

describe('childPidsOf', () => {
  test('walks a real tree transitively', async () => {
    const { pid } = spawnTree();
    started.push(pid);

    // Give the shell time to fork.
    for (let attempt = 0; attempt < 40 && childPidsOf(pid).length < 2; attempt += 1) {
      sleepSync(50);
    }

    const tree = childPidsOf(pid);
    expect(tree[0]).toBe(pid);
    expect(tree.length).toBeGreaterThanOrEqual(2);
    for (const member of tree) {
      expect(isAlive(member)).toBe(true);
    }
  });

  test('a pid with no children yields just itself', () => {
    // init reaps orphans, so a dead pid has no reachable tree.
    const tree = childPidsOf(999_999);
    expect(tree).toEqual([999_999]);
  });
});

describe('killTree', () => {
  test('takes down a whole tree, not just the root', async () => {
    const { pid } = spawnTree();
    started.push(pid);

    for (let attempt = 0; attempt < 40 && childPidsOf(pid).length < 2; attempt += 1) {
      sleepSync(50);
    }
    const tree = childPidsOf(pid);
    expect(tree.length).toBeGreaterThanOrEqual(2);

    const survivors = killTree(pid, { graceMs: 50, attempts: 12 });

    expect(survivors).toEqual([]);
    for (const member of tree) {
      expect(isAlive(member)).toBe(false);
    }
  }, 20_000);

  test('reports what survived instead of claiming success', () => {
    // A root that is not ours and not a group leader: signalling must not throw,
    // and the return value is the honest answer.
    const survivors = killTree(999_999, { attempts: 1 });
    expect(Array.isArray(survivors)).toBe(true);
  });

  test('an already-dead tree is a no-op', () => {
    expect(() => killTree(999_998, { attempts: 1 })).not.toThrow();
  });

  // pid 0 to `process.kill` is "my own process group" and pid 1 is init, so a
  // caller that lost a pid and passed 0 back would signal the launcher, the test
  // runner and everything else it owns. This is the shape `stopWorker` used to
  // produce when a spawn failed.
  test('refuses a root that is not a real pid', () => {
    for (const bad of [0, 1, -1, Number.NaN, 1.5]) {
      expect(() => killTree(bad, { attempts: 1 })).toThrow(/not a usable root pid/);
    }
  });

  test('the refusal names the pid it refused', () => {
    expect(() => killTree(0)).toThrow('0');
  });
});
