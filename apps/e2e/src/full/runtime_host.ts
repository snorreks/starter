import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { REPO_ROOT } from '../../../../scripts/src/shared/paths.ts';
import { runBounded } from '../../../../scripts/src/shared/run_bounded.ts';
import { allocatePort } from '../../../../scripts/src/shared/run_scope.ts';
import { buildWorkerGraph, parseWranglerJsonc } from './worker_graph.ts';

const CLIENT_ROOT = join(REPO_ROOT, 'apps/frontend/client');
const JOBS_ROOT = join(REPO_ROOT, 'apps/backend/jobs');
const MEDIA_ROOT = join(REPO_ROOT, 'apps/backend/media');
interface LocalDatabase {
  prepare(sql: string): { run(): Promise<unknown> };
}
interface LocalMediaBucket {
  put(
    key: string,
    value: Uint8Array,
    options: { httpMetadata: { contentType: string } },
  ): Promise<unknown>;
}
const runId = process.env.E2E_RUN_ID;
const appPort = Number(process.env.E2E_APP_PORT);
if (runId === undefined || !Number.isInteger(appPort) || appPort < 1 || appPort > 65_535) {
  throw new Error(
    'The full E2E runtime requires the Playwright-owned E2E_RUN_ID and E2E_APP_PORT.',
  );
}

const command = async (
  name: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<void> => {
  const result = await runBounded({
    command: name,
    args,
    cwd,
    timeoutMs,
    maxBytes: 2 * 1024 * 1024,
  });
  if (result.code !== 0) {
    throw new Error(
      `${name} ${args.join(' ')} failed (${result.code}).\n${result.stderr.slice(-4000)}`,
    );
  }
};

const hashTree = (root: string): string => {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === 'target' || entry.name === '.git') {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  visit(root);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(root, file)).update('\0').update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
};

const applyMigrations = async (database: LocalDatabase, directory: string): Promise<void> => {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No committed SQL migrations were found in ${directory}.`);
  }
  for (const file of files) {
    for (const sql of readFileSync(join(directory, file), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      if (sql.trim()) {
        await database.prepare(sql).run();
      }
    }
  }
};

const start = async (): Promise<void> => {
  const docker = process.env.DOCKER ?? 'docker';
  const info = await runBounded({
    command: docker,
    args: ['info'],
    cwd: REPO_ROOT,
    timeoutMs: 15_000,
    maxBytes: 512_000,
  });
  if (info.code !== 0) {
    throw new Error(
      `A working Docker-compatible engine is required for e2e:full. ${info.stderr.slice(-1500)}\nStart Docker or Podman, then rerun bun run e2e:full.`,
    );
  }

  await command('bun', ['run', 'build'], CLIENT_ROOT, 5 * 60_000);
  await command('bun', ['run', 'build'], JOBS_ROOT, 5 * 60_000);
  const imageRevision = hashTree(MEDIA_ROOT);
  const image = `starter-media:e2e-${imageRevision.slice(0, 16)}`;
  const existing = await runBounded({
    command: docker,
    args: [
      'image',
      'inspect',
      '--format',
      '{{ index .Config.Labels "starter.media.source" }}',
      image,
    ],
    cwd: REPO_ROOT,
    timeoutMs: 15_000,
    maxBytes: 64_000,
  });
  if (existing.code !== 0 || existing.stdout.trim() !== imageRevision) {
    await command(
      docker,
      [
        'build',
        '--label',
        `starter.media.source=${imageRevision}`,
        '--tag',
        image,
        '--file',
        'Dockerfile',
        '.',
      ],
      MEDIA_ROOT,
      20 * 60_000,
    );
  }
  const processorPort = (await allocatePort(`${runId}_processor`, REPO_ROOT)).port;
  const containerName = `starter-e2e-${runId}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
  await command(
    docker,
    [
      'run',
      '--detach',
      '--rm',
      '--publish',
      `127.0.0.1:${processorPort}:8080`,
      '--name',
      containerName,
      image,
    ],
    REPO_ROOT,
    60_000,
  );
  let worker: Miniflare | undefined;
  try {
    let processorReady = false;
    const processorDeadline = Date.now() + 60_000;
    while (Date.now() < processorDeadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${processorPort}/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        const body = response.ok ? ((await response.json()) as { protocol?: string }) : null;
        if (body?.protocol === 'sample-v1') {
          processorReady = true;
          break;
        }
      } catch {
        /* The owned container is still starting. */
      }
      await Bun.sleep(200);
    }
    if (!processorReady) {
      throw new Error(
        `The owned media container did not report sample-v1 health on port ${processorPort} within 60 seconds.`,
      );
    }

    const appUrl = `http://127.0.0.1:${appPort}`;
    const webConfig = parseWranglerJsonc(readFileSync(join(CLIENT_ROOT, 'wrangler.jsonc'), 'utf8'));
    const jobsConfig = parseWranglerJsonc(readFileSync(join(JOBS_ROOT, 'wrangler.jsonc'), 'utf8'));
    const graph = buildWorkerGraph({
      client: webConfig,
      jobs: jobsConfig,
      clientRoot: CLIENT_ROOT,
      jobsRoot: JOBS_ROOT,
      testRunId: runId,
      processorOrigin: `http://127.0.0.1:${processorPort}`,
      authSecret: randomBytes(48).toString('base64url'),
      trustedOrigins: appUrl,
    });
    worker = new Miniflare(
      convertV4MiniflareOptions({
        workers: graph.workers,
        rootPath: REPO_ROOT,
        host: '127.0.0.1',
        port: appPort,
      }),
    );
    await worker.ready;
    const webBindings = await worker.getBindings<Record<string, unknown>>(String(webConfig.name));
    const database = webBindings.DB as LocalDatabase | undefined;
    const media = webBindings.MEDIA as LocalMediaBucket | undefined;
    if (database === undefined || media === undefined) {
      throw new Error('The built web Worker is missing the shared D1 or MEDIA binding.');
    }
    await applyMigrations(database, graph.migrationDirectory);
    const fixture = new Uint8Array(readFileSync(join(MEDIA_ROOT, 'fixtures/media/sample-v1.mp4')));
    if (fixture.byteLength < 10_000) {
      throw new Error('Committed sample-v1.mp4 fixture is unexpectedly small.');
    }
    await media.put('media/v1/fixtures/sample-v1.mp4', fixture, {
      httpMetadata: { contentType: 'video/mp4' },
    });
    const identityResponse = await fetch(`${appUrl}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const identityText = await identityResponse.text();
    if (!identityResponse.ok) {
      throw new Error(
        `Built web Worker health returned HTTP ${identityResponse.status}: ${identityText.slice(0, 500)}`,
      );
    }
    const identity = JSON.parse(identityText) as { testRunId?: unknown };
    if (identity.testRunId !== runId) {
      throw new Error(
        `Built web Worker identity mismatch: expected ${runId}, received ${String(identity.testRunId)}.`,
      );
    }
    process.stdout.write(
      `Owned full E2E runtime ready: ${appUrl} (${runId}); processor image ${image}.\n`,
    );

    await new Promise<void>((resolveDone) => {
      const stop = (): void => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolveDone();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    try {
      await worker?.dispose();
    } finally {
      const removed = await runBounded({
        command: docker,
        args: ['rm', '--force', containerName],
        cwd: REPO_ROOT,
        timeoutMs: 20_000,
        maxBytes: 128_000,
      });
      if (removed.code !== 0) {
        process.stderr.write(
          `Owned container cleanup failed for ${containerName}: ${removed.stderr.slice(-1000)}\n`,
        );
      }
    }
  }
};

await start();
