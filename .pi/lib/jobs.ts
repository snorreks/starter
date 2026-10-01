// .pi/lib/jobs.ts
//
// Owned long-running processes: a handle, a bounded log, and an exit status.
//
// 🔴 What Pi lacks and this supplies: `bash` returns when the command returns, so
// a dev server, a preview build or a long e2e run has to be backgrounded with a
// shell `&` and then *inferred* from log output. Inference is where this goes
// wrong in the worst direction — a linking phase that has printed nothing for
// thirty seconds looks exactly like a finished build, and a model that concludes
// "done" from silence reports a pass that never happened.
//
// So completion here is **only** ever the process's own exit status. Output that
// stopped changing is reported as an observation and never as a state transition.
//
// Ownership is proved, not assumed. Before anything signals a pid it checks a
// token planted in that process's own environment at spawn time. The alternative —
// trusting a pid from a file — will eventually signal an unrelated process that
// inherited the number, which on a developer machine means killing somebody's
// editor. A check that cannot run reports `verified: false` rather than
// pretending it passed.
//
// Lives outside `.pi/extensions/`, which is Pi's discovery input.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/** Repo-relative directory. Already gitignored in `.gitignore`. */
export const JOB_DIR = '.pi/background-tasks';

/** Env var carrying the ownership token into the child. */
export const JOB_TOKEN_ENV = 'STARTER_JOB_TOKEN';

/** Exit code reported when a job was killed rather than finishing. */
export const KILLED_EXIT = 124;

export type JobState = 'running' | 'exited' | 'failed' | 'killed';

/** What is on disk, and therefore survives the Pi process that started the job. */
export interface JobSnapshot {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  pid: number | undefined;
  /** Ownership token, checked before this job is ever signalled. */
  token: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  state: JobState;
  /** Epoch ms the log was last written. An observation, never a completion signal. */
  lastOutputAt: number;
}

export interface StartJobOptions {
  cwd: string;
  /** Wall-clock ceiling. The job is SIGTERMed then SIGKILLed at it. */
  timeoutMs: number;
  /** Bytes of the log kept readable in memory for `wait()`. */
  maxBytes: number;
  /** Extra grace between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  signal?: AbortSignal;
}

export interface JobHandle {
  snapshot(): JobSnapshot;
  /** Resolves when the child exits. Never rejects. */
  wait(): Promise<JobSnapshot>;
  /** The last `maxBytes` of combined output. */
  tail(): string;
  /** Asks the job to stop, escalating to SIGKILL after the grace period. */
  stop(): Promise<JobSnapshot>;
}

// ── Paths ──────────────────────────────────────────────────────────

export const jobDir = (root: string): string => join(root, JOB_DIR);
export const jobJsonPath = (root: string, id: string): string => join(jobDir(root), `${id}.json`);
export const jobLogPath = (root: string, id: string): string => join(jobDir(root), `${id}.log`);

/**
 * An id that cannot collide with another session's.
 *
 * Timestamp alone is not enough: two agents starting a job in the same
 * millisecond would fight over one file, and the loser's snapshot would
 * overwrite the winner's. The random suffix makes that unreachable in practice.
 */
export const makeJobId = (): string => `job-${Date.now()}-${randomBytes(3).toString('hex')}`;

// ── Snapshot persistence ───────────────────────────────────────────

/**
 * Written atomically (temp + rename).
 *
 * A partially written JSON is how a `status` call ends up reporting a job as
 * `running` forever after it exited — the reader sees a truncated file, `JSON.parse`
 * throws, and the fallback path says "still running".
 */
const writeSnapshot = (root: string, snapshot: JobSnapshot): void => {
  try {
    mkdirSync(jobDir(root), { recursive: true });
    const path = jobJsonPath(root, snapshot.id);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot, null, 2));
    renameSync(temp, path);
  } catch {
    // A read-only checkout must not make a job unstartable.
  }
};

// ── Ownership ──────────────────────────────────────────────────────

/**
 * Read this process's environment, if the platform exposes it.
 *
 * Linux's `/proc/<pid>/environ` is readable for a process this user owns, which
 * is exactly the case here. Returns `undefined` anywhere else — macOS, Windows,
 * or a container without `/proc` — and the caller treats that as "unverified",
 * never as "verified".
 */
const readProcessEnv = (pid: number): string | undefined => {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return undefined;
  }
};

export interface OwnershipVerdict {
  owned: boolean;
  /** False when the platform could not answer — `owned` is then a guess. */
  verified: boolean;
  reason: string;
}

/**
 * Decide whether a recorded pid is still the job we started.
 *
 * Three outcomes, and the middle one is the point of the whole function:
 *
 *   * the token matches            → `owned: true, verified: true`
 *   * the process exists and the token does **not** match → `owned: false`. The
 *     pid was recycled, so this is somebody else's process.
 *   * the process cannot be inspected → `owned: true, verified: false`. The
 *     caller may proceed, but must not describe the kill as proven.
 */
export const verifyOwnership = (snapshot: JobSnapshot): OwnershipVerdict => {
  if (snapshot.pid === undefined) {
    return { owned: false, verified: true, reason: 'the job never recorded a pid' };
  }

  let alive = true;
  try {
    process.kill(snapshot.pid, 0);
  } catch {
    alive = false;
  }

  const environ = readProcessEnv(snapshot.pid);
  if (environ === undefined) {
    return {
      owned: alive,
      verified: false,
      reason: alive
        ? 'this platform does not expose /proc/<pid>/environ, so ownership is unverified'
        : 'the process is gone',
    };
  }

  const token = environ.split('\0').find((entry) => entry.startsWith(`${JOB_TOKEN_ENV}=`));
  if (token === `${JOB_TOKEN_ENV}=${snapshot.token}`) {
    return { owned: true, verified: true, reason: 'the ownership token matches' };
  }

  return {
    owned: false,
    verified: true,
    reason: alive
      ? `pid ${snapshot.pid} is alive but carries a different ${JOB_TOKEN_ENV}; ` +
        'the pid was reused, so it is not this job'
      : 'the process is gone',
  };
};

// ── Starting ───────────────────────────────────────────────────────

export interface StartResult {
  handle: JobHandle;
  snapshot: JobSnapshot;
  logPath: string;
}

/**
 * Start a detached, owned, bounded job.
 *
 * Rejects only when the spawn itself fails. Everything after that — a non-zero
 * exit, a timeout, a kill — is an answer reported through the snapshot, because
 * a tool that cannot tell a failure from a hang reports the hang.
 */
export const startJob = (
  command: string,
  args: readonly string[],
  options: StartJobOptions,
): StartResult => {
  const root = options.cwd;
  const id = makeJobId();
  const token = randomBytes(16).toString('hex');
  const killGraceMs = options.killGraceMs ?? 3_000;

  mkdirSync(jobDir(root), { recursive: true });

  const snapshot: JobSnapshot = {
    id,
    command,
    args: [...args],
    cwd: root,
    pid: undefined,
    token,
    startedAt: Date.now(),
    state: 'running',
    lastOutputAt: Date.now(),
  };

  const child: ChildProcess = spawn(command, [...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so a stop reaches the whole tree. Signalling only the
    // direct child leaves grandchildren holding the pipes open, and a stop that
    // leaves them running is not a stop.
    detached: true,
    env: { ...process.env, [JOB_TOKEN_ENV]: token, GIT_TERMINAL_PROMPT: '0' },
  });

  let logFd: number | undefined;
  try {
    logFd = openSync(jobLogPath(root, id), 'w');
  } catch {
    // Unwritable log directory: the job still runs and still reports a status.
    logFd = undefined;
  }

  let kept = '';
  const append = (chunk: string): void => {
    snapshot.lastOutputAt = Date.now();
    if (Buffer.byteLength(kept) + Buffer.byteLength(chunk) > options.maxBytes) {
      // Keep the tail: for a running job the last lines are the ones that say
      // what it is doing now. The file is the complete record.
      kept = `${kept}${chunk}`.slice(-options.maxBytes);
    } else {
      kept += chunk;
    }
    if (logFd !== undefined) {
      try {
        writeSync(logFd, chunk);
      } catch {
        /* a debug log is not worth stopping a job over */
      }
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => append(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => append(chunk.toString('utf8')));

  let settled = false;
  let resolveWait: (value: JobSnapshot) => void = () => {};
  const exited = new Promise<JobSnapshot>((resolve) => {
    resolveWait = resolve;
  });

  const closeLog = (): void => {
    if (logFd !== undefined) {
      try {
        closeSync(logFd);
      } catch {
        /* already closed */
      }
      logFd = undefined;
    }
  };

  const settle = (state: JobState, code: number): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    snapshot.state = state;
    snapshot.exitCode = code;
    snapshot.finishedAt = Date.now();
    closeLog();
    writeSnapshot(root, snapshot);
    resolveWait(snapshot);
  };

  /** Signal the whole group, with a documented fallback to the direct child. */
  const signalTree = (which: NodeJS.Signals): void => {
    if (child.pid === undefined) {
      return;
    }
    try {
      process.kill(-child.pid, which);
    } catch {
      try {
        child.kill(which);
      } catch {
        /* already gone */
      }
    }
  };

  const stop = (): void => {
    if (settled) {
      return;
    }
    signalTree('SIGTERM');
    setTimeout(() => {
      if (!settled) {
        // SIGKILL specifically: a process that ignored SIGTERM does not get a
        // second SIGTERM, it gets the one signal it cannot catch.
        signalTree('SIGKILL');
      }
    }, killGraceMs).unref?.();
  };

  const timer = setTimeout(() => {
    snapshot.state = 'killed';
    stop();
  }, options.timeoutMs);
  timer.unref?.();

  const onAbort = (): void => {
    snapshot.state = 'killed';
    stop();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  child.on('error', (error) => {
    // A spawn failure has no exit code. Reported as `failed` with -1 so it is
    // never mistaken for a clean exit.
    append(`\n[spawn failed: ${error.message}]\n`);
    snapshot.pid = undefined;
    settle('failed', -1);
  });

  child.on('close', (code, signal) => {
    if (settled) {
      return;
    }
    const finalCode = code ?? (signal === null ? 0 : KILLED_EXIT);
    settle(finalCode === 0 ? 'exited' : 'failed', finalCode);
  });

  snapshot.pid = child.pid;
  writeSnapshot(root, snapshot);

  const handle: JobHandle = {
    snapshot: () => ({ ...snapshot }),
    wait: () => exited,
    tail: () => kept,
    stop: async () => {
      stop();
      // Bounded: SIGKILL follows after the grace period regardless, so this
      // cannot wait forever even if the group ignores SIGTERM.
      const deadline = Date.now() + killGraceMs + 2_000;
      while (!settled && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { ...snapshot };
    },
  };

  return { handle, snapshot, logPath: jobLogPath(root, id) };
};

// ── Reading ────────────────────────────────────────────────────────

/**
 * Every job this checkout knows about, newest first.
 *
 * A job whose JSON is unreadable is reported rather than skipped: silently
 * dropping it would make a job the agent started look like it never existed.
 */
export const listJobs = (root: string): JobSnapshot[] => {
  if (!existsSync(jobDir(root))) {
    return [];
  }
  const out: JobSnapshot[] = [];
  for (const name of readdirSync(jobDir(root))) {
    if (!name.endsWith('.json')) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(join(jobDir(root), name), 'utf8')) as JobSnapshot;
      if (typeof parsed.id === 'string') {
        out.push(parsed);
      }
    } catch {
      out.push({
        id: name.replace(/\.json$/, ''),
        command: '(unreadable)',
        args: [],
        cwd: root,
        pid: undefined,
        token: '',
        startedAt: 0,
        state: 'failed',
        lastOutputAt: 0,
        exitCode: -1,
      });
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
};

/** One job's snapshot, or `undefined` when the id is unknown. */
export const readJob = (root: string, id: string): JobSnapshot | undefined =>
  listJobs(root).find((job) => job.id === id);

/**
 * The last `maxBytes` of a job's log.
 *
 * Reads from the end with a bounded buffer. A job that has printed 40 MB is the
 * normal case for a dev server, and reading it whole would put the transcript
 * back in the state the byte bound exists to prevent.
 */
export const tailJobLog = (root: string, id: string, maxBytes = 32 * 1024): string | undefined => {
  const path = jobLogPath(root, id);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const size = statSync(path).size;
    if (size <= maxBytes) {
      return readFileSync(path, 'utf8');
    }
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      readSync(fd, buffer, 0, maxBytes, size - maxBytes);
      return buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
};

// ── Stopping ───────────────────────────────────────────────────────

/**
 * Stop a recorded job, but only if it is still the process we started.
 *
 * Refusing on a token mismatch is the whole reason this is not just
 * `process.kill(pid)`. A recycled pid belongs to someone else, and killing it
 * because a stale file said so is a data-loss bug with no local cause.
 */
export const stopJob = async (
  root: string,
  id: string,
  graceMs = 3_000,
): Promise<{ stopped: boolean; reason: string; snapshot: JobSnapshot | undefined }> => {
  const snapshot = readJob(root, id);
  if (snapshot === undefined) {
    return { stopped: false, reason: `no job with id ${id}`, snapshot: undefined };
  }
  if (snapshot.state !== 'running') {
    return {
      stopped: false,
      reason: `job ${id} already finished with exit code ${snapshot.exitCode ?? 'unknown'}`,
      snapshot,
    };
  }

  const verdict = verifyOwnership(snapshot);
  if (!verdict.owned) {
    return {
      stopped: false,
      reason: `refusing to signal pid ${snapshot.pid}: ${verdict.reason}`,
      snapshot,
    };
  }

  // Update the on-disk state before signalling: if this process dies mid-kill,
  // the next reader must see an intent to stop, not a job that looks live.
  const stopping: JobSnapshot = { ...snapshot, state: 'killed', finishedAt: Date.now() };
  writeSnapshot(root, stopping);

  signalGroup(snapshot.pid as number, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  signalGroup(snapshot.pid as number, 'SIGKILL');

  return {
    stopped: true,
    reason: verdict.verified
      ? `sent SIGTERM then SIGKILL to the process group of pid ${snapshot.pid}`
      : `sent SIGTERM then SIGKILL to pid ${snapshot.pid} (ownership unverified on this platform)`,
    snapshot: stopping,
  };
};

const signalGroup = (pid: number, which: NodeJS.Signals): void => {
  try {
    process.kill(-pid, which);
  } catch {
    try {
      process.kill(pid, which);
    } catch {
      /* already gone */
    }
  }
};
