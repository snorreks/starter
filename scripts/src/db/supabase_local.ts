import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { resolveContainerRuntime } from '../local/container_runtime.ts';
import { DATABASE_DIR, REPO_ROOT } from '../shared/paths.ts';
import { publicToolEnvironment } from '../shared/private_environment.ts';
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

export const runDatabaseIntegration = async (): Promise<number> => {
  const allocation = allocateSupabaseLocal(REPO_ROOT, `database_${crypto.randomUUID()}`);
  let exitCode = 1;
  try {
    const environment = await startSupabaseLocal(allocation);
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
    await startSupabaseLocal(allocation);
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

export const startSupabaseLocal = async (
  allocation: SupabaseLocalAllocation,
  options: { emailConfirmations?: boolean; jwtExpirySeconds?: number } = {},
): Promise<Record<string, string>> => {
  // Resolved through the shared probe so a host with Podman and no Docker is not
  // told to install Docker Engine. `DOCKER_BIN` still wins outright.
  const engine = resolveContainerRuntime();
  const containerCommand = requireContainerRuntime({ dockerPath: engine?.command });
  await ensureSupabasePortsAvailable(allocation);
  await persistSupabaseOwnership({ ...allocation, containerCommand }, options);
  const code = await runCli(allocation, ['start']);
  if (code !== 0) {
    throw new Error(`Supabase local start failed with exit ${code}.`);
  }
  const reset = await runCli(allocation, [
    'migration',
    'up',
    '--db-url',
    `${allocation.urls.postgres}?sslmode=disable`,
  ]);
  if (reset !== 0) {
    throw new Error(`Supabase local migration replay failed with exit ${reset}.`);
  }
  const status = JSON.parse(await captureCli(allocation, ['status', '--output', 'json'])) as Record<
    string,
    unknown
  >;
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
  const health = await fetch(`${allocation.urls.api}/auth/v1/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!health.ok) {
    throw new Error(
      `Supabase Auth readiness failed for ${allocation.projectId}: HTTP ${health.status}.`,
    );
  }
  return {
    ...supabaseAllocationEnvironment(allocation),
    SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: serviceRole,
  };
};

export const stopSupabaseLocal = async (
  allocation: SupabaseLocalAllocation,
  owned: SupabaseLocalAllocation,
): Promise<void> => {
  assertSupabaseOwnership(allocation, owned);
  const code = await runCli(allocation, [
    'stop',
    '--project-id',
    allocation.projectId,
    '--no-backup',
  ]);
  // The engine resolved to *start* the stack, not a fresh `DOCKER_BIN ?? 'docker'`
  // lookup: on a Podman-only host the start probe found podman and this teardown
  // would have asked docker for the containers, reporting "cannot verify owned
  // containers" for a stack that stopped perfectly well.
  const engine = requireContainerRuntime({ dockerPath: owned.containerCommand });
  const runRuntime = (args: string[]) =>
    spawnSync(engine, args, {
      encoding: 'utf8',
      timeout: 30_000,
      env: publicToolEnvironment(process.env),
    });
  const containers = runRuntime([
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
    const removed = runRuntime(['rm', '-f', ...containerIds]);
    if (removed.status !== 0) {
      throw new Error(`Could not remove owned Supabase containers: ${removed.stderr}`);
    }
  }
  const volumes = runRuntime([
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=com.supabase.cli.project=${allocation.projectId}`,
  ]);
  if (volumes.status !== 0) {
    throw new Error(`Cannot verify owned Supabase volumes after stop: ${volumes.stderr}`);
  }
  const volumeNames = volumes.stdout.trim().split('\n').filter(Boolean);
  if (volumeNames.length > 0) {
    const removed = runRuntime(['volume', 'rm', ...volumeNames]);
    if (removed.status !== 0) {
      throw new Error(`Could not remove owned Supabase volumes: ${removed.stderr}`);
    }
  }
  const remaining = runRuntime([
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
