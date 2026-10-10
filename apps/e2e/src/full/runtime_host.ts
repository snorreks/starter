import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertV4MiniflareOptions, Miniflare, type V4FetchHandler } from 'miniflare';
import { buildMediaImage } from '../../../../scripts/src/local/media_image.ts';
import { REPO_ROOT } from '../../../../scripts/src/shared/paths.ts';
import { runBounded } from '../../../../scripts/src/shared/run_bounded.ts';
import { runScope } from '../../../../scripts/src/shared/run_scope.ts';
import { startGoogleFixture } from './google_fixture.ts';
import { readRuntimeBindings } from './runtime_bindings.ts';
import { startStripeFixture } from './stripe_fixture.ts';
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

  // One definition of the image, shared with `bun run test:compute` and
  // `bun run dev --stack container`, and reused when this checkout already built it
  // from these exact sources.
  //
  // Reuse is right here and would be wrong in the compute lane. This lane needs the
  // image to *exist* so it can dispatch an encode at it; `test:compute` needs to know
  // the image is *correct*, which is what its `--no-cache` build is for. Reuse here
  // is reported rather than silent, because a lane that skipped a build without
  // saying so would be indistinguishable from one that ran it.
  const image = await buildMediaImage({
    engine: process.env.DOCKER ?? 'docker',
    reuse: true,
  });
  process.stdout.write(
    image.reused
      ? `Finite runner image ${image.image} is current for these sources (${image.checksum.slice(0, 12)}); build skipped.\n`
      : `Finite runner image ${image.image} built with ${image.rustTests} Rust tests passing.\n`,
  );
  let worker: Miniflare | undefined;
  let google: Awaited<ReturnType<typeof startGoogleFixture>> | undefined;
  let stripe: ReturnType<typeof startStripeFixture> | undefined;
  try {
    const appUrl = `http://127.0.0.1:${appPort}`;
    google = await startGoogleFixture({ appOrigin: appUrl, runId });
    stripe = startStripeFixture({ appOrigin: appUrl, runId });

    // One outbound handler for both Workers, because Miniflare resolves `fetch`
    // against a single service per worker and the two fixtures answer different
    // hosts. Dispatching on the hostname — rather than trying one fixture first —
    // is what keeps a Stripe request from being answered by the Google fixture's
    // catch-all, which would return a 200 for an endpoint that does not exist.
    const googleFixture = google;
    const stripeFixture = stripe;
    const outbound: V4FetchHandler = async (request, ...rest) => {
      const { hostname } = new URL(request.url);
      return hostname === 'api.stripe.com'
        ? stripeFixture.outbound(request, ...rest)
        : googleFixture.outbound(request, ...rest);
    };
    const webConfig = parseWranglerJsonc(readFileSync(join(CLIENT_ROOT, 'wrangler.jsonc'), 'utf8'));
    const graph = buildWorkerGraph({
      client: webConfig,
      clientRoot: CLIENT_ROOT,
      testRunId: runId,
      appOrigin: appUrl,
      compute: { jobsRoot: JOBS_ROOT, bindings: google.bindings, outbound },
      stripe: {
        apiBase: 'https://api.stripe.com',
        secretKey: 'sk_test_fixture_key',
        webhookSecret: stripe.webhookSecret,
      },
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
      `Owned full E2E runtime ready: ${appUrl} (${runId}); real Supabase, Workflows, R2 and finite FFmpeg.\n` +
        '  Hosted Google and Stripe are fixture-owned; the Stripe fixture is seeded from @starter/billing.\n',
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
      await stripe?.dispose();
    } finally {
      await worker?.dispose();
    }
  }
};

await start();
