// apps/backend/jobs/scripts/compute_lane.ts
//
// The compute lane's harness: a real local Workers runtime, real local D1 and R2,
// and a real FFmpeg container.
//
// Why this exists and what it is not
// ---------------------------------
// There is exactly one way to know that a Workflow completes, that its steps are
// fenced and that its bytes land in a bucket: run one. A unit test with a fake
// binding proves the *code paths*; it cannot prove that the platform delivers a
// cron-shaped event, that a Durable Object addresses itself by name, or that a
// stream survives the round trip.
//
// So the lane starts the real runtime. Not `bun test` against mocks, and not a
// hand-written mock of a Workflow: the local Workers runtime that `wrangler dev`
// runs, configured from the same `wrangler.jsonc` a deploy would use.
//
// Which runtime, and why it is wrangler's own
// --------------------------------------------
// The runtime is `miniflare` — the local runtime **that wrangler 4.142.0 itself
// runs**, at the exact version wrangler resolves (`5.20260926.0-alpha`). It is a
// declared devDependency rather than an undeclared import of wrangler's internals,
// because a package that is not in `package.json` is a package `bun install
// --frozen-lockfile` in CI may not install.
//
// The alternative was `@cloudflare/vitest-pool-workers`, which is the documented
// way to test Workflows and which would have been the better-shaped tool. It is not
// adoptable here: its newest release (0.22.0) peers `vitest ^4.1.0`, and this
// workspace runs vitest 5.0.2. `docs/capability-matrix.md` already records that
// finding; this file is the consequence of it.
//
// What the lane cannot prove
// --------------------------
// Two things, and both are reported rather than papered over:
//
//   1. **Cloudflare's managed container runtime.** The local runtime has no
//      `ctx.container`. The lane therefore starts the *real* image as a container on
//      a port and points the Durable Object at it with `PROCESSOR_ORIGIN`, so the
//      bytes, the protocol, the deadline and the validation are all real — but the
//      container is started by Docker, not by the provider.
//   2. **A deployed run.** Nothing here deploys, and no result from this lane may
//      be reported as live-provider evidence.
//
// The lane fails, loudly, when Docker is absent. A compute lane that skips when its
// prerequisite is missing reports nothing and passes, which is the failure mode this
// repository's first rule names.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const DIST_ENTRY = join(APP_DIR, 'dist/index.js');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/backend/database/drizzle-d1');
const MEDIA_DIR = join(REPO_ROOT, 'apps/backend/media');

/** The image tag this lane builds and runs. Named here so the README can quote it. */
export const MEDIA_IMAGE = 'starter-media:local';

/** The port the processor container publishes on loopback. */
export const PROCESSOR_PORT = 8099;

/** The one message both ways of not having an engine produce. */
const MISSING_DOCKER =
  'The compute lane needs a running Docker-compatible engine.\n' +
  '  This is a named prerequisite failure, not a skip: nothing about this lane ran.\n' +
  '  Start Docker (or podman) and run it again. The unit lane (`bun run test`) needs none of this.';

/**
 * Refuse, loudly, and exit non-zero.
 *
 * Every prerequisite failure in this file goes through here, and none of them is a
 * skip: a lane that reports success having proved nothing is worse than a lane that
 * cannot run.
 */
const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

/**
 * A Docker-compatible engine, or a failure that says exactly what is missing.
 *
 * `docker info` rather than `docker --version`: a client with no daemon answers
 * the version and then fails every command, which is the shape of a lane that
 * spends ten minutes failing confusingly instead of one second failing clearly.
 */
export const requireDocker = (): string => {
  // No `--format`: `docker info --format '{{.ServerVersion}}'` is Docker's field name
  // and podman (a supported Docker-compatible engine here) does not have it, so a
  // formatted probe fails on an engine that works perfectly well. The plain report is
  // read for its version line instead.
  //
  // The spawn is guarded: a *missing* binary throws rather than exiting non-zero, and
  // the raw `Executable not found in $PATH` that would print is not the message a
  // reader can act on. Both the missing binary and the non-zero probe end here.
  let probe: ReturnType<typeof Bun.spawnSync> | null = null;
  try {
    probe = Bun.spawnSync(['docker', 'info'], { stdout: 'pipe', stderr: 'pipe' });
  } catch {
    probe = null;
  }
  if (probe === null) {
    return fail(MISSING_DOCKER);
  }
  if (probe.exitCode !== 0) {
    return fail(`${MISSING_DOCKER}\n${probe.stderr?.toString().trim() ?? ''}`);
  }
  const report = probe.stdout?.toString() ?? '';
  return /Version:\s*([^\s\n]+)/.exec(report)?.[1] ?? 'unknown';
};

/** Build the processor image from PR G's Dockerfile, if it is not already built. */
export const ensureMediaImage = async (dockerVersion: string): Promise<void> => {
  const existing = Bun.spawnSync(['docker', 'image', 'inspect', MEDIA_IMAGE], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if (existing.exitCode === 0) {
    return;
  }
  process.stdout.write(`building ${MEDIA_IMAGE} from ${MEDIA_DIR} with Docker ${dockerVersion}\n`);
  const build = Bun.spawnSync(['docker', 'build', '-t', MEDIA_IMAGE, '.'], {
    cwd: MEDIA_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (build.exitCode !== 0) {
    fail(
      `Building ${MEDIA_IMAGE} failed. The compute lane cannot prove anything without the\n` +
        '  processor image, and it will not substitute a stub: a mocked encode is exactly\n' +
        '  the evidence this lane exists to replace.',
    );
  }
};

/** Start the processor container and wait until its own `/health` answers. */
export const startProcessor = async (): Promise<{ stop: () => Promise<void> }> => {
  // A container this harness started, by name, so teardown is exact: no pattern
  // match, no `docker kill` of somebody else's container.
  const name = `starter-media-compute-${Date.now()}`;
  const run = Bun.spawnSync(
    [
      'docker',
      'run',
      '-d',
      '--rm',
      '-p',
      `127.0.0.1:${PROCESSOR_PORT}:8080`,
      '--name',
      name,
      MEDIA_IMAGE,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  if (run.exitCode !== 0) {
    fail(
      `Could not start ${MEDIA_IMAGE}.\n${run.stderr.toString()}\n` +
        `  Another process may already hold 127.0.0.1:${PROCESSOR_PORT}.`,
    );
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PROCESSOR_PORT}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const health = (await response.json()) as { protocol?: string };
        if (health.protocol === 'sample-v1') {
          return {
            stop: async () => {
              Bun.spawnSync(['docker', 'stop', '--time', '5', name], { stdout: 'ignore' });
            },
          };
        }
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(200);
  }
  await Bun.spawn(['docker', 'stop', '--time', '5', name]).exited;
  return fail(
    `${MEDIA_IMAGE} did not answer /health within 60 s. It started, so the failure is in the image.`,
  );
};

/** The committed migrations, in order, as one statement list. */
export const migrationStatements = async (): Promise<string[]> => {
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const statements: string[] = [];
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim().length > 0) {
        statements.push(statement);
      }
    }
  }
  return statements;
};

/** The real fixture bytes, read from the committed file. */
export const fixtureBytes = async (): Promise<Uint8Array> =>
  new Uint8Array(await readFile(join(MEDIA_DIR, 'fixtures/media/sample-v1.mp4')));

export const build = async (): Promise<void> => {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(
      'apps/backend/jobs/dist/index.js does not exist. Run `bun run build` first: this lane\n' +
        '  drives the *built* Worker, so a lane that bundled its own copy would not be\n' +
        '  testing the artifact a deploy ships.',
    );
  }
};

const runTests = async (env: Record<string, string>): Promise<number> => {
  await build();
  // `--timeout` is raised for a stated reason: one test here starts a Workers
  // runtime, encodes a three-second clip through a real FFmpeg and reads the result
  // back, and the default five seconds is shorter than a cold container start on a
  // loaded machine. It is not a disabled timeout — a hung runtime still fails, and
  // `awaitInstance` has its own deadline and reports which status it was stuck on.
  const child = spawn('bun', ['test', 'tests/', '--timeout', '180000'], {
    cwd: APP_DIR,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  return new Promise((resolve) => {
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    const finish = (code: number) => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      resolve(code);
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    child.once('error', () => finish(1));
    child.once('exit', (code) => finish(code ?? 1));
  });
};

const command = process.argv[2] ?? 'test';

if (command === 'serve') {
  // `bun run dev` for a human: the built Worker in the local runtime against the
  // local D1 and R2, with the processor container alongside it. The same wiring the
  // lane asserts, left running.
  const dockerVersion = requireDocker();
  await ensureMediaImage(dockerVersion);
  const processor = await startProcessor();
  await build();
  process.stdout.write(
    `processor on http://127.0.0.1:${PROCESSOR_PORT}; this Worker has no HTTP route.\n` +
      'Drive it through the Workflow bindings — `bun run test:compute` does exactly that.\n',
  );
  await rm(join(APP_DIR, '.wrangler/state'), { recursive: true, force: true });
  const child = spawn(
    join(APP_DIR, 'node_modules/.bin/wrangler'),
    [
      'dev',
      '--config',
      join(APP_DIR, 'wrangler.jsonc'),
      '--var',
      `PROCESSOR_ORIGIN:http://127.0.0.1:${PROCESSOR_PORT}`,
    ],
    { cwd: APP_DIR, stdio: 'inherit' },
  );
  await new Promise((resolve) => child.on('exit', resolve));
  await processor.stop();
} else if (command === 'test') {
  const dockerVersion = requireDocker();
  await ensureMediaImage(dockerVersion);
  const processor = await startProcessor();
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= processor.stop());
  const interrupt = () => {
    void stop().finally(() => process.exit(130));
  };
  const terminate = () => {
    void stop().finally(() => process.exit(143));
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  let code: number;
  try {
    code = await runTests({
      COMPUTE_LANE: '1',
      PROCESSOR_ORIGIN: `http://127.0.0.1:${PROCESSOR_PORT}`,
      MEDIA_IMAGE,
    });
  } finally {
    await stop();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
  process.exit(code);
} else {
  fail(`Unknown compute-lane command "${command}". Use "test" or "serve".`);
}
