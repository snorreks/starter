import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { resolveContainerRuntime } from '../local/container_runtime.ts';
import { DATABASE_DIR, REPO_ROOT } from '../shared/paths.ts';
import { publicToolEnvironment } from '../shared/private_environment.ts';
import { createProgress, reportStep, type Stepper } from '../shared/progress.ts';
import { runBounded } from '../shared/run_bounded.ts';
import { runScope } from '../shared/run_scope.ts';
import { resolveWorkspaceBin } from '../shared/tools.ts';

export interface SupabaseLocalAllocation {
  projectId: string;
  runId: string;
  ownerToken: string;
  containerCommand?: string;
  root: string;
  ports: {
    api: number;
    postgres: number;
    studio: number;
    mail: number;
    smtp: number;
    pop3: number;
  };
  urls: { api: string; postgres: string; studio: string; mail: string; smtp: string; pop3: string };
}

/** Keep generated Worker vars inside this run's private scope, away from user .dev.vars. */
export const writeOwnedWorkerVars = async (
  allocation: SupabaseLocalAllocation,
  values: Record<string, string>,
): Promise<{ path: string; contents: string }> => {
  await mkdir(allocation.root, { recursive: true });
  const path = join(allocation.root, 'supabase.dev.vars');
  const contents = `${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n')}\n`;
  await writeFile(path, contents, { mode: 0o600, flag: 'wx' });
  return { path, contents };
};

/** Preserve a run file if another process changed it before teardown. */
export const removeOwnedWorkerVars = async (path: string, contents: string): Promise<void> => {
  try {
    const current = await readFile(path, 'utf8');
    if (current !== contents) {
      throw new Error('The owned run env file changed before teardown; preserving it.');
    }
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
};

const PORT_NAMES = ['api', 'postgres', 'studio', 'mail', 'smtp', 'pop3'] as const;
const FIRST_PORT = 54_321;
const PORT_BLOCKS = 1_200;
const portBlock = (block: number): SupabaseLocalAllocation['ports'] => {
  const first = FIRST_PORT + block * 8;
  return {
    api: first,
    postgres: first + 1,
    studio: first + 2,
    mail: first + 3,
    smtp: first + 4,
    pop3: first + 5,
  };
};
const urlsForPorts = (ports: SupabaseLocalAllocation['ports']): SupabaseLocalAllocation['urls'] => {
  const host = '127.0.0.1';
  return {
    api: `http://${host}:${ports.api}`,
    postgres: `postgresql://postgres:postgres@${host}:${ports.postgres}/postgres`,
    studio: `http://${host}:${ports.studio}`,
    mail: `http://${host}:${ports.mail}`,
    smtp: `${host}:${ports.smtp}`,
    pop3: `${host}:${ports.pop3}`,
  };
};
const projectFor = (root: string, runId: string): string =>
  `st${createHash('sha256').update(`${root}\0${runId}`).digest('hex').slice(0, 18)}`;

export const allocateSupabaseLocal = (
  root: string = REPO_ROOT,
  runId = `supabase_${process.pid}`,
  ownerToken = randomBytes(24).toString('hex'),
): SupabaseLocalAllocation => {
  const scope = runScope(runId, root);
  const digest = createHash('sha256').update(`${root}\0${runId}`).digest();
  const block = digest.readUInt32BE(0) % 1_200;
  const ports = portBlock(block);
  return {
    projectId: projectFor(root, runId),
    runId,
    ownerToken,
    root: scope.dir,
    ports,
    urls: urlsForPorts(ports),
  };
};

/**
 * The one run id the local development database is shared under.
 *
 * **Why this is stable and every other allocation is not.** A per-run id makes the
 * project id and the port block a function of the pid, so every `bun run dev`
 * computes a *different* database and a different set of ports, boots eight
 * containers, and leaves the previous set behind — thirty-odd seconds to get a
 * database that was already running. Deriving it from the checkout instead means
 * the second run can find the first run's stack and adopt it.
 *
 * **Only `bun run dev` gets this.** Every lane that needs a clean database — E2E,
 * `test:worker`, `test:database`, `db:types` — allocates a unique run id and is
 * unaffected, because a shared database would let one run's rows and one run's
 * migrations leak into another's assertions. That isolation is the reason this is a
 * named constant here rather than a default argument on the allocator: making it the
 * default would hand a shared database to every caller that forgets to pass an id.
 */
export const DEV_SHARED_STACK_RUN_ID = 'dev_local';

/**
 * The allocation for the local development database, identical on every run of this
 * checkout.
 *
 * The `ownerToken` is derived rather than random, and that is deliberate. It is
 * checked by {@link assertSupabaseOwnership} before anything is stopped or removed,
 * so a random one would make a reused stack impossible to recognise: the next run
 * would be looking for a stack whose recorded owner is a token nobody can reproduce.
 * It is an ownership *identity*, not a credential — the file it is written to is
 * 0600 inside this checkout, and the value grants nothing beyond "stop this
 * checkout's own containers".
 */
export const devSupabaseAllocation = (root: string = REPO_ROOT): SupabaseLocalAllocation => {
  const ownerToken = createHash('sha256')
    .update(`owner\0${root}\0${DEV_SHARED_STACK_RUN_ID}`)
    .digest('hex');
  return allocateSupabaseLocal(root, DEV_SHARED_STACK_RUN_ID, ownerToken);
};

const canBind = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => {
      server.close((error) => resolve(error === undefined));
    });
  });

/** Select a complete free port block before asking the container engine to bind it. */
export const ensureSupabasePortsAvailable = async (
  allocation: SupabaseLocalAllocation,
): Promise<SupabaseLocalAllocation> => {
  const originalBlock = Math.floor((allocation.ports.api - FIRST_PORT) / 8);
  for (let offset = 0; offset < PORT_BLOCKS; offset += 1) {
    const block = (originalBlock + offset) % PORT_BLOCKS;
    const ports = portBlock(block);
    const available = await Promise.all([
      ...PORT_NAMES.map((name) => canBind(ports[name])),
      canBind(ports.postgres + 6),
    ]);
    if (available.every(Boolean)) {
      allocation.ports = ports;
      allocation.urls = urlsForPorts(ports);
      if (block !== originalBlock) {
        process.stdout.write(
          `Supabase port block ${originalBlock} is occupied; using free block ${block}.\n`,
        );
      }
      return allocation;
    }
  }
  throw new Error('No free local Supabase port block is available in 54321–63920.');
};

export const requireContainerRuntime = (options: { dockerPath: string | undefined }): string => {
  if (options.dockerPath === undefined || options.dockerPath.length === 0) {
    throw new Error(
      'A Docker-compatible container runtime is required for local Supabase. Install Docker Engine or Podman with a Docker-compatible socket, then rerun `bun run test:database`.',
    );
  }
  return options.dockerPath;
};

export const assertSupabaseOwnership = (
  expected: Pick<SupabaseLocalAllocation, 'projectId' | 'runId' | 'ownerToken'>,
  actual: Pick<SupabaseLocalAllocation, 'projectId' | 'runId' | 'ownerToken'>,
): void => {
  if (
    expected.projectId !== actual.projectId ||
    expected.runId !== actual.runId ||
    expected.ownerToken.length < 32 ||
    expected.ownerToken !== actual.ownerToken
  ) {
    throw new Error('Supabase ownership identity mismatch; refusing to stop or reset this stack.');
  }
};

const projectDir = (allocation: SupabaseLocalAllocation): string =>
  join(allocation.root, 'supabase-project');

/**
 * The generated Supabase project directory for this run.
 *
 * Exported because the seed has to be pointed at *this* stack. `supabase status`
 * reads the project id and ports out of the generated `config.toml` in here, so
 * `--workdir` this directory is the only way to reach the stack this checkout
 * owns rather than the repo-root project in `supabase/config.toml`.
 */
export const supabaseProjectDir = projectDir;
const identityPath = (allocation: SupabaseLocalAllocation): string =>
  join(allocation.root, 'supabase-owner.json');

export const persistSupabaseOwnership = async (
  allocation: SupabaseLocalAllocation,
  options: { emailConfirmations?: boolean; jwtExpirySeconds?: number } = {},
): Promise<void> => {
  await mkdir(projectDir(allocation), { recursive: true });
  await writeFile(identityPath(allocation), `${JSON.stringify(allocation, null, 2)}\n`, {
    mode: 0o600,
  });
  const source = await readFile(join(REPO_ROOT, 'supabase', 'config.toml'), 'utf8');
  const emailConfirmations =
    /^(\[auth\.email\]\r?\n(?:(?!^\[)[\s\S])*?^enable_confirmations\s*=\s*)(?:true|false)$/m;
  if (!emailConfirmations.test(source)) {
    throw new Error('Owned Supabase configuration requires auth.email.enable_confirmations.');
  }
  const rendered = source
    .replace('project_id = "starter-local"', `project_id = "${allocation.projectId}"`)
    .replace(/^port = 54321$/m, `port = ${allocation.ports.api}`)
    .replace(/^port = 54322$/m, `port = ${allocation.ports.postgres}`)
    .replace(/^port = 54323$/m, `port = ${allocation.ports.studio}`)
    .replace(/^port = 54324$/m, `port = ${allocation.ports.mail}`)
    .replace(/^smtp_port = 54325$/m, `smtp_port = ${allocation.ports.smtp}`)
    .replace(/^pop3_port = 54326$/m, `pop3_port = ${allocation.ports.pop3}`)
    .replace('api_url = "http://127.0.0.1:54321"', `api_url = "${allocation.urls.api}"`)
    .replace(emailConfirmations, `$1${options.emailConfirmations === true}`)
    .replace('jwt_expiry = 3600', `jwt_expiry = ${options.jwtExpirySeconds ?? 3600}`);
  const supabaseDir = join(projectDir(allocation), 'supabase');
  await mkdir(join(supabaseDir, 'snippets'), { recursive: true });
  await mkdir(join(supabaseDir, 'functions'), { recursive: true });
  await writeFile(
    join(supabaseDir, 'config.toml'),
    rendered.replace(/^shadow_port = 54320$/m, `shadow_port = ${allocation.ports.postgres + 6}`),
    { mode: 0o600 },
  );
  for (const name of ['migrations', 'tests', 'seed.sql']) {
    const link = join(supabaseDir, name);
    await rm(link, { force: true });
    await symlink(join(REPO_ROOT, 'supabase', name), link);
  }
};

// Leave time for integration checks and teardown within the 25-minute CI job.
const CLI_TIMEOUT_MS = 3 * 60 * 1000;

const supabaseCli = (): string => {
  const binary = resolveWorkspaceBin('supabase', ['packages/backend/database']);
  if (binary === null) {
    throw new Error(
      'The pinned Supabase CLI is unavailable. Run `bun install` to install the database workspace tools.',
    );
  }
  return binary;
};

const runCli = async (allocation: SupabaseLocalAllocation, args: string[]): Promise<number> => {
  const result = await runBounded({
    command: supabaseCli(),
    args: ['--workdir', projectDir(allocation), ...args],
    cwd: REPO_ROOT,
    env: publicToolEnvironment({ ...process.env, SUPABASE_WORKDIR: projectDir(allocation) }),
    timeoutMs: CLI_TIMEOUT_MS,
    maxBytes: 2 * 1024 * 1024,
  });
  const output = result.stdout
    .split('\n')
    .filter((line) => !line.includes('"SERVICE_ROLE_KEY"') && !line.includes('"ANON_KEY"'))
    .join('\n');
  if (output.length > 0) {
    process.stdout.write(output);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.code;
};

const captureCli = async (allocation: SupabaseLocalAllocation, args: string[]): Promise<string> => {
  const result = await runBounded({
    command: supabaseCli(),
    args: ['--workdir', projectDir(allocation), ...args],
    cwd: REPO_ROOT,
    env: publicToolEnvironment({ ...process.env, SUPABASE_WORKDIR: projectDir(allocation) }),
    timeoutMs: CLI_TIMEOUT_MS,
    maxBytes: 2 * 1024 * 1024,
  });
  if (result.code !== 0) {
    throw new Error(
      `Supabase CLI ${args.join(' ')} failed with exit ${result.code}; see the bounded CLI output above.`,
    );
  }
  return result.stdout;
};

/**
 * Read an already-running stack's bindings, or `null` if there isn't one.
 *
 * **This is the whole of reuse.** A stack is only adopted when the ownership file
 * this checkout wrote is present *and* the CLI reports that same project id and the
 * API answers — a leftover file beside stopped containers must not be mistaken for
 * a running database, because the alternative is a dev server pointed at a port
 * with nothing behind it, which 503s on every request with no explanation.
 *
 * Returns bindings only. Nothing here migrates or seeds: an adopted stack has
 * already had that done by whichever run started it, and re-running migrations
 * against a database another process may be using is not this function's decision
 * to make.
 */
export const probeRunningSupabase = async (
  allocation: SupabaseLocalAllocation,
): Promise<Record<string, string> | null> => {
  // The ownership file first, because it records the ports this stack was actually
  // started on. The allocation's own ports are the *first* candidate block: a
  // previous run may have moved to another because the block was occupied, and
  // probing the wrong port would report a healthy stack as absent.
  if (!(await hasSupabaseOwnership(allocation))) {
    return null;
  }
  let owned: SupabaseLocalAllocation;
  try {
    owned = await readSupabaseOwnership(allocation);
  } catch {
    // A file that does not parse, or an identity that does not match, is not a
    // stack to adopt. Starting a fresh one is always available.
    return null;
  }

  let status: Record<string, unknown>;
  try {
    status = JSON.parse(await captureCli(owned, ['status', '--output', 'json'])) as Record<
      string,
      unknown
    >;
  } catch {
    // `supabase status` exits nonzero when nothing is running under that project
    // id. That is the ordinary answer here, not an error worth reporting.
    return null;
  }

  const api = status.API_URL ?? status.SUPABASE_URL ?? status.api_url;
  const anon = status.ANON_KEY ?? status.anon_key;
  const serviceRole = status.SERVICE_ROLE_KEY ?? status.service_role_key;
  if (typeof api !== 'string' || typeof anon !== 'string' || typeof serviceRole !== 'string') {
    return null;
  }
  if (api !== owned.urls.api) {
    // The CLI is reporting a different project's stack. Refusing to adopt it is the
    // same identity rule `startSupabaseLocal` applies before running anything
    // against a stack.
    return null;
  }

  // The CLI's idea and an actual request agreeing is what makes this adoption safe.
  // A status that lists containers which have not finished booting reports URLs
  // happily, and a dev server pointed at one answers connection-refused rather than
  // anything diagnosable.
  try {
    const health = await fetch(`${owned.urls.api}/auth/v1/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!health.ok) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    ...supabaseAllocationEnvironment(owned),
    SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: serviceRole,
  };
};

/**
 * Stop this checkout's shared development database.
 *
 * The counterpart to reuse. A stack adopted by `bun run dev` is deliberately not
 * torn down when that run ends, which is right while the next run is about to adopt
 * it and wrong if the last run has already gone — so the leaving is explicit rather
 * than automatic, and this is the command that does it.
 *
 * **The containers go; the data stays.** They are different resources, and a
 * developer stopping a database wants the ports and the memory back, not their rows
 * deleted. The Postgres volume is left in place and the next `bun run dev` starts
 * the stack against it, which is why the next boot is seconds rather than the
 * half-minute an empty stack takes. Discarding it is a separate, explicit request —
 * `bun run dev --fresh` — because the alternative is a `db:stop` that silently
 * throws away whatever was not backed up anywhere else.
 *
 * Refuses when there is nothing of this checkout's to stop, and says so, rather than
 * reporting success having done nothing. The ownership record goes with the
 * containers, which is what keeps that refusal honest: the volumes survive it.
 */
export const stopDevSupabaseLocal = async (
  root: string = REPO_ROOT,
): Promise<{ stopped: boolean; message: string }> => {
  const allocation = devSupabaseAllocation(root);
  if (!(await hasSupabaseOwnership(allocation))) {
    return {
      stopped: false,
      message:
        `No local development database is recorded for this checkout.\n` +
        `  It is created by \`bun run dev\` and lives under ${runScope(DEV_SHARED_STACK_RUN_ID, root).dir}.`,
    };
  }
  const owned = await readSupabaseOwnership(allocation);
  // The one caller that keeps the data. Stopping the containers frees the ports and
  // the memory, which is what somebody stopping a database wants; deleting the rows
  // is not, and the only way to get a pristine database is to ask for one.
  await stopSupabaseLocal(allocation, owned, { preserveData: true });
  return {
    stopped: true,
    message:
      `Stopped the local development database (${allocation.projectId}) on ${owned.urls.api}.\n` +
      '  Its data was kept: `bun run dev` brings it back with your rows, and ' +
      '`bun run dev --fresh` starts over with the mock seed.',
  };
};

export const runDatabaseIntegration = async (): Promise<number> => {
  const allocation = allocateSupabaseLocal(REPO_ROOT, `database_${crypto.randomUUID()}`);
  let exitCode = 1;
  try {
    const environment = await startSupabaseLocal(allocation, { progress: createProgress() });
    const result = await runBounded({
      command: 'bun',
      args: ['run', '--cwd', DATABASE_DIR, 'test:integration'],
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...publicToolEnvironment(process.env),
        ...environment,
        SUPABASE_WORKDIR: projectDir(allocation),
      },
      timeoutMs: 20 * 60 * 1000,
      maxBytes: 16 * 1024 * 1024,
    });
    exitCode = result.code;
    if (exitCode === 0) {
      exitCode = await runCli(allocation, ['test', 'db']);
    }
  } finally {
    try {
      if (await hasSupabaseOwnership(allocation)) {
        const owned = await readSupabaseOwnership(allocation);
        await stopSupabaseLocal(allocation, owned);
      }
    } catch (error) {
      process.stderr.write(
        `Owned local Supabase teardown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      exitCode = 1;
    }
  }
  return exitCode;
};

export const runDatabaseTypeCommand = async (
  command: 'db:types' | 'db:types:check',
): Promise<number> => {
  const allocation = allocateSupabaseLocal(REPO_ROOT, `types_${crypto.randomUUID()}`);
  let exitCode = 1;
  try {
    await startSupabaseLocal(allocation, { progress: createProgress() });
    const result = await runBounded({
      command: 'bun',
      args: ['run', '--cwd', DATABASE_DIR, command],
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...publicToolEnvironment(process.env),
        ...supabaseAllocationEnvironment(allocation),
        SUPABASE_WORKDIR: projectDir(allocation),
      },
      timeoutMs: 10 * 60 * 1000,
      maxBytes: 16 * 1024 * 1024,
    });
    exitCode = result.code;
  } finally {
    try {
      if (await hasSupabaseOwnership(allocation)) {
        const owned = await readSupabaseOwnership(allocation);
        await stopSupabaseLocal(allocation, owned);
      }
    } catch (error) {
      process.stderr.write(
        `Owned local Supabase teardown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      exitCode = 1;
    }
  }
  return exitCode;
};

/**
 * Start an owned local stack.
 *
 * Four steps, announced, because this is the longest silent stretch in the
 * repository: pulling images, booting eight containers, replaying migrations and
 * waiting for Auth to answer takes from seconds to minutes depending on the
 * machine's cache. Every caller passes a `progress`, so no caller can inherit the
 * silence — including the lanes (`test:database`, `db:types`, `e2e`) that start
 * the same stack and are exactly where a hang is hardest to diagnose.
 */
export const startSupabaseLocal = async (
  allocation: SupabaseLocalAllocation,
  options: {
    emailConfirmations?: boolean;
    jwtExpirySeconds?: number;
    /**
     * A reporter scoped to this stack's start.
     *
     * A `Stepper`, not the whole `Progress`: this is called from lanes that report
     * nothing else, and from a dev stack where several services start at once and a
     * shared reporter would nest this one's steps under whichever service was
     * drawn last.
     */
    progress: Stepper;
  },
): Promise<Record<string, string>> => {
  // Resolved through the shared probe so a host with Podman and no Docker is not
  // told to install Docker Engine. `DOCKER_BIN` still wins outright.
  const engine = resolveContainerRuntime();
  const containerCommand = requireContainerRuntime({ dockerPath: engine?.command });
  await ensureSupabasePortsAvailable(allocation);
  await persistSupabaseOwnership({ ...allocation, containerCommand }, options);
  const code = await reportStep(options.progress, 'starting the local containers', () =>
    runCli(allocation, ['start']),
  );
  if (code !== 0) {
    throw new Error(`Supabase local start failed with exit ${code}.`);
  }
  const reset = await reportStep(options.progress, 'replaying migrations', () =>
    runCli(allocation, [
      'migration',
      'up',
      '--db-url',
      `${allocation.urls.postgres}?sslmode=disable`,
    ]),
  );
  if (reset !== 0) {
    throw new Error(`Supabase local migration replay failed with exit ${reset}.`);
  }
  const status = JSON.parse(
    await reportStep(options.progress, 'reading the stack status', () =>
      captureCli(allocation, ['status', '--output', 'json']),
    ),
  ) as Record<string, unknown>;
  const api = status.API_URL ?? status.SUPABASE_URL ?? status.api_url;
  const database = status.DB_URL ?? status.db_url;
  const studio = status.STUDIO_URL ?? status.studio_url;
  const mail = status.MAILPIT_URL ?? status.INBUCKET_URL ?? status.mail_url;
  const anon = status.ANON_KEY ?? status.anon_key;
  const serviceRole = status.SERVICE_ROLE_KEY ?? status.service_role_key;
  if (
    api !== allocation.urls.api ||
    database !== allocation.urls.postgres ||
    studio !== allocation.urls.studio ||
    mail !== allocation.urls.mail ||
    typeof anon !== 'string' ||
    typeof serviceRole !== 'string'
  ) {
    throw new Error(
      `Supabase readiness identity mismatch for ${allocation.projectId}; refusing to run tests against another stack.`,
    );
  }
  await reportStep(options.progress, 'waiting for Auth to answer', async () => {
    const health = await fetch(`${allocation.urls.api}/auth/v1/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!health.ok) {
      throw new Error(
        `Supabase Auth readiness failed for ${allocation.projectId}: HTTP ${health.status}.`,
      );
    }
  });
  return {
    ...supabaseAllocationEnvironment(allocation),
    SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: serviceRole,
  };
};

/** What one container-engine invocation returned. */
export interface ContainerRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The engine this stack is torn down with, and how to call it.
 *
 * A parameter rather than a `spawnSync` at each call site, because "which volumes
 * survived" is the whole of the persistence decision and it cannot be tested
 * against a real daemon without a database and a boot. Injecting it is what lets
 * a test assert that a stop *kept* a volume by reading the recorded argv, rather
 * than by trusting the implementation.
 */
export interface SupabaseRuntime {
  readonly command: string;
  run(args: readonly string[]): ContainerRun;
}

const RUNTIME_TIMEOUT_MS = 30_000;

const spawnRuntime = (command: string): SupabaseRuntime => ({
  command,
  run: (args) => {
    const result = spawnSync(command, [...args], {
      encoding: 'utf8',
      timeout: RUNTIME_TIMEOUT_MS,
      env: publicToolEnvironment(process.env),
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  },
});

/**
 * The engine to use when there is no recorded one.
 *
 * A probe rather than `DOCKER_BIN ?? 'docker'`, for the reason `container_runtime.ts`
 * gives: a Podman-only host must not be asked for `docker` and then told its
 * volumes cannot be verified.
 */
const hostRuntime = (): SupabaseRuntime => {
  const engine = resolveContainerRuntime();
  return spawnRuntime(requireContainerRuntime({ dockerPath: engine?.command }));
};

/**
 * This project's volumes, by label.
 *
 * The label is the identity: the project id is a hash of the checkout root and the
 * run id, so the filter names this checkout's volumes and cannot name another's.
 */
const projectVolumes = (
  runtime: SupabaseRuntime,
  allocation: Pick<SupabaseLocalAllocation, 'projectId'>,
): string[] => {
  const listed = runtime.run([
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=com.supabase.cli.project=${allocation.projectId}`,
  ]);
  if (listed.status !== 0) {
    throw new Error(`Cannot verify owned Supabase volumes: ${listed.stderr}`);
  }
  return listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name.length > 0);
};

/** Names in, names out: the caller reports exactly what was destroyed. */
const removeVolumes = (runtime: SupabaseRuntime, names: readonly string[]): string[] => {
  if (names.length === 0) {
    return [];
  }
  const removed = runtime.run(['volume', 'rm', ...names]);
  if (removed.status !== 0) {
    throw new Error(`Could not remove owned Supabase volumes: ${removed.stderr}`);
  }
  return [...names];
};

/**
 * Volumes this checkout's database still holds, whether or not it is running.
 *
 * **This is how "the data came back" is decided, and it is decided by asking the
 * engine rather than by a file this repository writes.** A marker file would record
 * what a previous run intended; the volume list is what is actually there, which is
 * the only version of the answer that survives a reboot, a `docker system prune` or
 * somebody deleting `.wrangler`.
 *
 * There is no owner-token assertion here, because the identity file a stopped
 * stack's owner would be checked against no longer exists — `stopSupabaseLocal`
 * removes it, which is what makes a second `db:stop` refuse rather than claim to
 * have stopped something. The volume *label* carries the project id instead, and the
 * project id is a hash of the checkout root, so this cannot remove another
 * checkout's data.
 */
export const preservedSupabaseVolumes = (
  allocation: Pick<SupabaseLocalAllocation, 'projectId'>,
  options: { runtime?: SupabaseRuntime } = {},
): string[] => projectVolumes(options.runtime ?? hostRuntime(), allocation);

/**
 * Remove this checkout's database volumes, so the next start is a genuinely empty
 * database rather than a restored one.
 *
 * The counterpart to {@link preservedSupabaseVolumes}, and the only way to throw
 * development data away on purpose. Containers must already be stopped: a volume in
 * use is refused by the engine, which would surface as "the fresh start failed" on
 * a host that is working perfectly well.
 *
 * Returns the volume names it destroyed, so the banner can say what is gone.
 */
export const discardSupabaseData = (
  allocation: Pick<SupabaseLocalAllocation, 'projectId'>,
  options: { runtime?: SupabaseRuntime } = {},
): string[] => {
  const runtime = options.runtime ?? hostRuntime();
  return removeVolumes(runtime, projectVolumes(runtime, allocation));
};

export interface StopSupabaseOptions {
  /**
   * Keep the database's volumes after the containers are gone.
   *
   * **Default false, and the default matters.** Every lane that starts a stack of
   * its own — E2E, `test:worker`, `test:database`, `db:types` — tears it down
   * through this function under a unique project id per run, so a `true` default
   * would leave one set of volumes behind per lane run, forever, with nothing to
   * report them. Persistence is therefore something a caller asks for by name, and
   * `bun run db:stop` is the one that asks.
   *
   * A stack that failed to start asks for the opposite: keeping a half-started
   * stack's volume would let the next run restore a database nobody ever reached.
   */
  readonly preserveData?: boolean;
  /**
   * The engine to tear down with.
   *
   * Defaults to the one this stack recorded when it started, because the same
   * engine has to be asked about the same stack's containers: on a Podman-only host
   * a fresh `docker` lookup would report "cannot verify owned containers" for a
   * stack that stopped perfectly well.
   */
  readonly runtime?: SupabaseRuntime;
}

export const stopSupabaseLocal = async (
  allocation: SupabaseLocalAllocation,
  owned: SupabaseLocalAllocation,
  options: StopSupabaseOptions = {},
): Promise<void> => {
  assertSupabaseOwnership(allocation, owned);
  const code = await runCli(allocation, [
    'stop',
    '--project-id',
    allocation.projectId,
    '--no-backup',
  ]);
  const recorded = options.runtime === undefined ? owned.containerCommand : options.runtime.command;
  const runtime =
    options.runtime ?? spawnRuntime(requireContainerRuntime({ dockerPath: recorded }));
  const containers = runtime.run([
    'ps',
    '-aq',
    '--filter',
    `label=com.supabase.cli.project=${allocation.projectId}`,
  ]);
  if (containers.status !== 0) {
    throw new Error(`Cannot verify owned Supabase containers after stop: ${containers.stderr}`);
  }
  const containerIds = containers.stdout.trim().split('\n').filter(Boolean);
  if (containerIds.length > 0) {
    const removed = runtime.run(['rm', '-f', ...containerIds]);
    if (removed.status !== 0) {
      throw new Error(`Could not remove owned Supabase containers: ${removed.stderr}`);
    }
  }
  const volumes = projectVolumes(runtime, allocation);
  if (options.preserveData === true) {
    // Said out loud, because the difference between this and the behaviour it
    // replaced is invisible from the terminal otherwise: the developer stopped
    // eight containers and their rows are still in a volume they did not know about.
    process.stdout.write(
      volumes.length === 0
        ? 'No database volumes to keep.\n'
        : `Kept ${volumes.length === 1 ? 'volume' : 'volumes'}: ${volumes.join(', ')}\n` +
            '  The next `bun run dev` restores this database from them.\n',
    );
  } else {
    removeVolumes(runtime, volumes);
  }
  const remaining = runtime.run([
    'ps',
    '-aq',
    '--filter',
    `label=com.supabase.cli.project=${allocation.projectId}`,
  ]);
  if (remaining.status !== 0 || remaining.stdout.trim() !== '') {
    throw new Error('Supabase teardown left an owned container behind.');
  }
  if (code !== 0) {
    process.stderr.write(
      'Supabase CLI volume prune failed; exact project-labeled resources were removed and verified through the container runtime.\n',
    );
  }
  await rm(allocation.root, { recursive: true, force: true });
};

export const supabaseAllocationEnvironment = (
  allocation: SupabaseLocalAllocation,
): Record<string, string> => ({
  SUPABASE_PROJECT_ID: allocation.projectId,
  SUPABASE_RUN_ID: allocation.runId,
  SUPABASE_OWNER_TOKEN: allocation.ownerToken,
  SUPABASE_API_PORT: String(allocation.ports.api),
  SUPABASE_POSTGRES_PORT: String(allocation.ports.postgres),
  SUPABASE_STUDIO_PORT: String(allocation.ports.studio),
  SUPABASE_MAIL_PORT: String(allocation.ports.mail),
  SUPABASE_SMTP_PORT: String(allocation.ports.smtp),
  SUPABASE_POP3_PORT: String(allocation.ports.pop3),
  SUPABASE_URL: allocation.urls.api,
  SUPABASE_DB_URL: allocation.urls.postgres,
  SUPABASE_STUDIO_URL: allocation.urls.studio,
  SUPABASE_MAIL_URL: allocation.urls.mail,
  SUPABASE_SMTP_URL: allocation.urls.smtp,
});

export const readSupabaseOwnership = async (
  allocation: SupabaseLocalAllocation,
): Promise<SupabaseLocalAllocation> => {
  const stored = JSON.parse(
    await readFile(identityPath(allocation), 'utf8'),
  ) as SupabaseLocalAllocation;
  assertSupabaseOwnership(allocation, stored);
  return stored;
};

export const hasSupabaseOwnership = async (
  allocation: SupabaseLocalAllocation,
): Promise<boolean> => {
  try {
    await access(identityPath(allocation));
    return true;
  } catch {
    return false;
  }
};

export const resetSupabaseLocal = async (
  allocation: SupabaseLocalAllocation,
  owned: SupabaseLocalAllocation,
): Promise<void> => {
  assertSupabaseOwnership(allocation, owned);
  const code = await runCli(allocation, ['db', 'reset', '--db-url', allocation.urls.postgres]);
  if (code !== 0) {
    throw new Error(`Owned Supabase local reset failed with exit ${code}.`);
  }
};
