import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { REPO_ROOT } from '../../../../scripts/src/shared/paths.ts';
import { runBounded } from '../../../../scripts/src/shared/run_bounded.ts';
import { runScope } from '../../../../scripts/src/shared/run_scope.ts';
import { startGoogleFixture } from './google_fixture.ts';
import { readRuntimeBindings } from './runtime_bindings.ts';
import { buildWorkerGraph, parseWranglerJsonc } from './worker_graph.ts';

const CLIENT_ROOT = join(REPO_ROOT, 'apps/frontend/client');
const JOBS_ROOT = join(REPO_ROOT, 'apps/backend/jobs');
const runId = process.env.E2E_RUN_ID;
const appPort = Number(process.env.E2E_APP_PORT);
if (runId === undefined || !Number.isInteger(appPort) || appPort < 1 || appPort > 65_535) {
  throw new Error(
    'The full E2E runtime requires the Playwright-owned E2E_RUN_ID and E2E_APP_PORT.',
  );
}

runScope(runId);

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

const start = async (): Promise<void> => {
  const bindings = readRuntimeBindings(process.env);
  await command('bun', ['run', 'build'], CLIENT_ROOT, 5 * 60_000);
  await command('bun', ['run', 'build'], JOBS_ROOT, 5 * 60_000);
  await command(process.env.DOCKER ?? 'docker', ['info'], REPO_ROOT, 15_000);
  await command(
    process.env.DOCKER ?? 'docker',
    [
      'build',
      '--file',
      'apps/backend/media/Dockerfile.job',
      '--tag',
      'starter-cloud-run-job:local',
      '--build-arg',
      `BUILD_GIT_REVISION=${process.env.GITHUB_SHA ?? 'local'}`,
      'apps/backend/media',
    ],
    REPO_ROOT,
    20 * 60_000,
  );
  let worker: Miniflare | undefined;
  let google: Awaited<ReturnType<typeof startGoogleFixture>> | undefined;
  try {
    const appUrl = `http://127.0.0.1:${appPort}`;
    google = await startGoogleFixture({ appOrigin: appUrl, runId });
    const webConfig = parseWranglerJsonc(readFileSync(join(CLIENT_ROOT, 'wrangler.jsonc'), 'utf8'));
    const graph = buildWorkerGraph({
      client: webConfig,
      clientRoot: CLIENT_ROOT,
      testRunId: runId,
      appOrigin: appUrl,
      compute: { jobsRoot: JOBS_ROOT, bindings: google.bindings, outbound: google.outbound },
      supabaseUrl: bindings.SUPABASE_URL,
      supabaseAnonKey: bindings.SUPABASE_ANON_KEY,
      supabaseServiceRoleKey: bindings.SUPABASE_SERVICE_ROLE_KEY,
      ...(process.env.SUPABASE_MAIL_URL === undefined
        ? {}
        : { supabaseMailUrl: process.env.SUPABASE_MAIL_URL }),
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
    const media = await worker.getR2Bucket('MEDIA', graph.workerName);
    await media.put(
      'media/v1/fixtures/sample-v1.mp4',
      readFileSync(join(REPO_ROOT, 'apps/backend/media/fixtures/media/sample-v1.mp4')),
    );
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
      `Owned full E2E runtime ready: ${appUrl} (${runId}); real Supabase, Workflows, R2 and finite FFmpeg; hosted Google only is fixture-owned.\n`,
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
      await google?.dispose();
    } finally {
      await worker?.dispose();
    }
  }
};

await start();
