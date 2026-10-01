// Runs independently of Pi so output, deadlines and terminal status survive it.
// Plain JavaScript lets both Node (Pi) and Bun (tests) launch this without a loader.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';

const { snapshot, jsonPath, logPath, timeoutMs, killGraceMs, killedExit } = JSON.parse(
  process.argv[2],
);
let settled = false;
let stopping = false;
let escalation;
let logFd;

const persist = () => {
  try {
    const temp = `${jsonPath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot, null, 2));
    renameSync(temp, jsonPath);
  } catch {
    // An unwritable journal must not stop the child.
  }
  if (process.connected) {
    process.send(snapshot, () => {});
  }
};

try {
  logFd = openSync(logPath, 'w');
} catch {
  // The terminal status is still useful when a log cannot be opened.
}

const append = (chunk) => {
  snapshot.lastOutputAt = Date.now();
  if (logFd !== undefined) {
    try {
      writeSync(logFd, chunk);
    } catch {
      // Logging failure must not stop the child.
    }
  }
};

// Separate group: stopJob can kill the entire job without killing its supervisor.
const child = spawn(snapshot.command, snapshot.args, {
  cwd: snapshot.cwd,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
snapshot.pid = child.pid;
persist();
child.stdout.on('data', append);
child.stderr.on('data', append);

const signalTree = (signal) => {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
};

const stop = () => {
  if (settled || stopping) {
    return;
  }
  stopping = true;
  snapshot.state = 'killed';
  persist();
  signalTree('SIGTERM');
  escalation = setTimeout(() => {
    if (!settled) {
      signalTree('SIGKILL');
    }
  }, killGraceMs);
};

const timer = setTimeout(stop, Math.max(0, snapshot.startedAt + timeoutMs - Date.now()));
process.on('message', (message) => {
  if (message === 'stop') {
    stop();
  }
});
// Losing the IPC peer is expected: this process owns the job until completion.
process.on('disconnect', () => {});

const settle = (state, code) => {
  if (settled) {
    return;
  }
  settled = true;
  clearTimeout(timer);
  clearTimeout(escalation);
  snapshot.state = state;
  snapshot.exitCode = code;
  snapshot.finishedAt = Date.now();
  if (logFd !== undefined) {
    closeSync(logFd);
  }
  persist();
  if (process.connected) {
    process.disconnect();
  }
};

child.on('error', (error) => {
  append(`\n[spawn failed: ${error.message}]\n`);
  snapshot.pid = undefined;
  settle('failed', -1);
});

child.on('close', (code, signal) => {
  if (settled) {
    return;
  }
  // A stop from a later Pi session records intent before signalling this child.
  try {
    if (JSON.parse(readFileSync(jsonPath, 'utf8')).state === 'killed') {
      snapshot.state = 'killed';
    }
  } catch {
    // Keep the state known by this supervisor if the journal is unavailable.
  }
  if (snapshot.state === 'killed') {
    settle('killed', killedExit);
    return;
  }
  const finalCode = code ?? (signal === null ? 0 : killedExit);
  settle(finalCode === 0 ? 'exited' : 'failed', finalCode);
});
