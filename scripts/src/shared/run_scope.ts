// scripts/src/shared/run_scope.ts
// Where one run's ports, state, logs and artefacts go, and who owns them.
//
// The failure this prevents: two checkouts of this template on one machine. A
// Herdr worktree, a second clone, a CI matrix leg — each starts a server on
// 4183, and the second one either fails confusingly or, worse, succeeds against
// the *first* one's process. The E2E suite caught exactly that: a leftover
// listener answers `/api/health` as readily as the right one, so twenty specs
// pass against a stale D1 and nobody learns anything.
//
// Three rules, applied here rather than re-derived in each harness:
//
//   1. **Ports are per worktree.** Derived from the checkout path, so two
//      checkouts of the same repository get different ports without
//      configuration, and the same checkout gets the same port on every run —
//      which is what makes a stale listener recognisable rather than random.
//   2. **A port is only used if it is free.** `allocatePort` binds and releases to
//      find a candidate, then reports whether the final port is owned by this
//      run. A port already in use is a refusal, never a silent reuse: see
//      `PortUnavailable`.
//   3. **Directories are per worktree and per run.** D1 state, logs and artefacts
//      live under the checkout's own `.wrangler/`, keyed by run id, so a failed
//      run leaves evidence beside it and a second run cannot read the first's.

import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.ts';

/**
 * The port range this repository's harnesses draw from.
 *
 * Wide enough that several checkouts fit, narrow enough that a collision is this
 * repository's fault rather than an unrelated service's.
 */
export const PORT_RANGE_START = 4183;
export const PORT_RANGE_SIZE = 400;

/** A stable number in the range, derived from the checkout path. */
export const worktreePort = (base: number, root: string = REPO_ROOT): number => {
  const digest = createHash('sha256').update(root).digest();
  const offset = ((digest[0] as number) << 8) | (digest[1] as number);
  return base + (offset % PORT_RANGE_SIZE);
};

/** Every port this checkout could plausibly use for `purpose`. */
export const candidatePorts = (purpose: string, root: string = REPO_ROOT): number[] => {
  const base = worktreePort(PORT_RANGE_START, join(root, purpose));
  return Array.from({ length: 16 }, (_, index) => base + index).filter(
    (port) => port < PORT_RANGE_START + PORT_RANGE_SIZE,
  );
};

export class PortUnavailable extends Error {
  constructor(
    readonly port: number,
    readonly purpose: string,
  ) {
    super(
      `port ${port} is already in use, so nothing will be started on it.\n` +
        '  Connecting to whatever answers there would test an unrelated process.\n' +
        `  Find it:  ss -lptn "sport = :${port}"\n` +
        '  Stop it:  kill <pid>      # not pkill -f: it matches this shell too',
    );
    this.name = 'PortUnavailable';
  }
}

/** Is anything listening on `port` right now? */
export const isPortBusy = (port: number, host = '127.0.0.1'): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createServer();
    // `error` is the answer, not a failure: EADDRINUSE means busy, anything else
    // means this process cannot tell, which is reported as busy so the caller
    // refuses rather than assuming a free port.
    socket.once('error', () => {
      resolve(true);
    });
    socket.once('listening', () => {
      socket.close(() => {
        resolve(false);
      });
    });
    socket.listen(port, host);
  });

export interface PortAllocation {
  port: number;
  /** The ports that were tried and were busy. */
  rejected: number[];
}

/**
 * Find a free port in this checkout's range.
 *
 * Throws `PortUnavailable` rather than returning a busy port. Every caller in this
 * repository wants a port nobody else has: a collision means a stale process, and
 * proceeding would make the run assert against the wrong thing.
 */
export const allocatePort = async (
  purpose: string,
  root: string = REPO_ROOT,
): Promise<PortAllocation> => {
  const rejected: number[] = [];

  for (const port of candidatePorts(purpose, root)) {
    if (!(await isPortBusy(port))) {
      return { port, rejected };
    }
    rejected.push(port);
  }

  throw new PortUnavailable(candidatePorts(purpose, root)[0] ?? PORT_RANGE_START, purpose);
};

/**
 * Per-worktree state, keyed by run id.
 *
 * Under the checkout's own `.wrangler/`, never `/tmp`: `/tmp` is shared between
 * every checkout on the machine, which is the situation this module exists to
 * resolve. The repository already moved its pid file there for the same reason.
 */
export interface RunScope {
  runId: string;
  /** Root for everything this run writes. */
  dir: string;
  /** Local D1 state and `wrangler dev` scratch. */
  stateDir: string;
  /** Captured stdout/stderr. */
  logDir: string;
  /** Traces, screenshots, reports. */
  artifactDir: string;
}

/** A short, filesystem-safe id. */
export const newRunId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const runScope = (runId: string, root: string = REPO_ROOT): RunScope => {
  const dir = join(root, '.wrangler', 'runs', runId);
  return {
    runId,
    dir,
    stateDir: join(dir, 'state'),
    logDir: join(dir, 'logs'),
    artifactDir: join(dir, 'artifacts'),
  };
};
