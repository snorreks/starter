// scripts/tests/run_scope.test.ts
//
// Two checkouts of this template on one machine is the normal case for anyone
// using a worktree, and the failure it produces is silent: the second run starts
// no server, connects to the first one's, and twenty E2E specs pass against a stale
// D1. These tests pin the two properties that make that impossible — ports differ
// per checkout, and a busy port is a refusal rather than a reuse.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/shared/paths.ts';
import {
  allocatePort,
  CANDIDATE_COUNT,
  candidatePorts,
  isPortBusy,
  newRunId,
  PORT_RANGE_SIZE,
  PORT_RANGE_START,
  PortUnavailable,
  runScope,
  worktreePort,
} from '../src/shared/run_scope.ts';

/** A port actually held open, so `isPortBusy` has something real to find. */
const hold = (port: number): Promise<Server> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });

/** A port the kernel says is free, released again immediately. */
const freePortFromOs = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('expected an inet socket address'));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });

describe('two checkouts do not share a port', () => {
  test('the port derives from the checkout path, so it is stable per worktree', () => {
    const a = worktreePort(PORT_RANGE_START, '/home/one/starter');
    const b = worktreePort(PORT_RANGE_START, '/home/two/starter');

    // Stable: the same checkout gets the same port every run, which is what makes a
    // stale listener recognisable instead of a random collision.
    expect(worktreePort(PORT_RANGE_START, '/home/one/starter')).toBe(a);
    // Distinct: two checkouts do not fight.
    expect(a).not.toBe(b);
  });

  test('every candidate port is inside the reserved range', () => {
    for (const port of candidatePorts('e2e', REPO_ROOT)) {
      expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
      expect(port).toBeLessThan(PORT_RANGE_START + PORT_RANGE_SIZE);
    }
  });

  test('every checkout gets a full, in-range, duplicate-free candidate list', () => {
    // 162 of 4000 checkout paths used to yield fewer than 16 candidates, because the
    // tail was dropped rather than wrapped — so a checkout landing near the top of
    // the range had fewer chances to find a free port, and `allocatePort` reported a
    // collision sooner than it should have, on a port that was not the only option.
    for (let i = 0; i < 500; i++) {
      const ports = candidatePorts(`purpose-${i}`, `/checkouts/${i}`);

      expect(ports).toHaveLength(CANDIDATE_COUNT);
      expect(new Set(ports).size).toBe(CANDIDATE_COUNT);
      for (const port of ports) {
        expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
        expect(port).toBeLessThan(PORT_RANGE_START + PORT_RANGE_SIZE);
      }
    }
  });
});

describe('a busy port is a refusal, never a silent reuse', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('a port held open is reported busy', async () => {
    const port = candidatePorts('probe', REPO_ROOT)[0] as number;
    servers.push(await hold(port));

    expect(await isPortBusy(port)).toBe(true);
  });

  test('a free port is reported free', async () => {
    // A port obtained from the OS, not one picked out of the checkout's range. A
    // candidate could be held by anything on the machine — a previous run of this
    // suite, a developer's dev server — and the assertion would then be measuring
    // that, not `isPortBusy`. `listen(0)` asks the kernel for a free port and
    // releasing it keeps it free only until something else takes it, which is
    // enough for the interval this test occupies.
    const port = await freePortFromOs();
    expect(await isPortBusy(port)).toBe(false);
  });

  test('allocation skips a held port and returns the next free one', async () => {
    const candidates = candidatePorts('skip', REPO_ROOT);
    const held = candidates[0] as number;
    servers.push(await hold(held));

    const allocation = await allocatePort('skip', REPO_ROOT);

    expect(allocation.port).not.toBe(held);
    expect(allocation.rejected).toContain(held);
    expect(await isPortBusy(allocation.port)).toBe(false);
  });

  test('allocation refuses rather than returning a busy port', async () => {
    // Every candidate in this checkout's window is held, which is what a machine
    // full of leftovers looks like. The refusal has to name the port and say why,
    // because the alternative — starting a server that cannot bind — reports a
    // confusing error two steps later.
    const purpose = 'exhausted';
    const candidates = candidatePorts(purpose, REPO_ROOT);
    for (const port of candidates) {
      servers.push(await hold(port));
    }

    await expect(allocatePort(purpose, REPO_ROOT)).rejects.toThrow(PortUnavailable);

    try {
      await allocatePort(purpose, REPO_ROOT);
      throw new Error('allocatePort should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(PortUnavailable);
      expect((error as Error).message).toContain('unrelated process');
      expect((error as PortUnavailable).port).toBe(candidates[0]);
    }
  });
});

describe('each run writes to its own directories', () => {
  test('two run ids in one checkout do not share state, logs or artefacts', () => {
    const a = runScope(newRunId('e2e'));
    const b = runScope(newRunId('e2e'));

    expect(a.runId).not.toBe(b.runId);
    for (const key of ['dir', 'stateDir', 'logDir', 'artifactDir'] as const) {
      expect(a[key]).not.toBe(b[key]);
    }
  });

  test('run state lives under the checkout, never in a shared temp directory', () => {
    const scope = runScope('e2e_fixed', REPO_ROOT);

    // `/tmp` is shared by every checkout on the machine, which is the collision
    // this module exists to stop. The repository already moved its pid file out of
    // `/tmp` for the same reason.
    expect(scope.dir.startsWith(REPO_ROOT)).toBe(true);
    expect(scope.dir).toBe(join(REPO_ROOT, '.wrangler', 'runs', 'e2e_fixed'));
  });

  test('a scope describes paths that do not exist until something creates them', () => {
    const scope = runScope('e2e_absent', '/nonexistent-checkout-root');

    // Creating directories as a side effect of *describing* them would leave litter
    // behind for every command that merely asked where its logs would go.
    expect(existsSync(scope.dir)).toBe(false);
    rmSync(scope.dir, { recursive: true, force: true });
  });

  test('a run id is filesystem safe', () => {
    const id = newRunId('worker');

    expect(id).toMatch(/^worker_[a-z0-9]+$/);
  });
});
