import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMediaImage, MEDIA_IMAGE } from '@starter/scripts/compute';
import { publicToolEnvironment } from '@starter/scripts/environment';
import { runBounded } from '@starter/scripts/process';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const media = join(root, 'apps/backend/media');
// The tag, the Dockerfile and the Rust-test assertion now have one owner, so this
// lane and `bun run dev --stack container` cannot verify different images.
const image = MEDIA_IMAGE;
const fail = (message: string): never => {
  throw new Error(message);
};

const execute = async (args: string[], timeoutMs: number) => {
  const result = await runBounded({
    command: 'docker',
    args,
    cwd: root,
    timeoutMs,
    maxBytes: 16 * 1024 * 1024,
    env: publicToolEnvironment(process.env),
  });
  return { code: result.code, output: `${result.stdout}\n${result.stderr}` };
};

const readBody = async (request: import('node:http').IncomingMessage, limit: number) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > limit) {
      throw new Error('fixture request over limit');
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks);
};

const run = async () => {
  const args = process.argv.slice(2);
  if (args.length !== 0) {
    fail(
      'Run `bun run test:compute` without backend or processor switches; there is one compute lane.',
    );
  }
  const runnerTests = await runBounded({
    command: process.execPath,
    args: ['test', 'runner.test.ts'],
    cwd: join(media, 'runner'),
    timeoutMs: 60_000,
    maxBytes: 2 * 1024 * 1024,
    env: publicToolEnvironment(process.env),
    onOutput: (stream, chunk) => process[stream].write(chunk),
  });
  if (runnerTests.code !== 0) {
    fail('Finite runner boundary tests failed; the image lane cannot proceed.');
  }
  const probe = await execute(['info'], 15_000);
  if (probe.code !== 0) {
    fail(
      `The selected compute lane requires a running Docker-compatible engine.\n${probe.output.slice(-1000)}`,
    );
  }
  const stack = await mkdtemp(join(tmpdir(), 'starter-cloud-run-local-'));
  const artifact: { value: Buffer | null } = { value: null };
  const input = await readFile(join(media, 'fixtures/media/sample-v1.mp4'));
  let port = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/metadata') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('fixture-google-identity');
        return;
      }
      if (url.pathname === '/api/internal/jobs/job_fixture/grants' && request.method === 'POST') {
        if (request.headers.authorization !== 'Bearer fixture-google-identity') {
          response.writeHead(401);
          response.end();
          return;
        }
        const body = JSON.parse((await readBody(request, 1024)).toString());
        if (
          body.attemptId !== 'attempt_fixture' ||
          body.executionName !==
            'projects/local/locations/local/jobs/runner/executions/runner-fixture'
        ) {
          response.writeHead(409);
          response.end();
          return;
        }
        const origin = `http://host.docker.internal:${port}`;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jobId: 'job_fixture',
            attemptId: 'attempt_fixture',
            expiresAt: Date.now() + 60_000,
            preset: 'demo-180p-v1',
            input: { url: `${origin}/input?grant=input_fixture` },
            output: {
              url: `${origin}/output?grant=output_fixture`,
              key: 'media/v1/jobs/job_fixture/attempts/attempt_fixture.mp4',
            },
          }),
        );
        return;
      }
      if (
        url.pathname === '/input' &&
        request.method === 'GET' &&
        url.searchParams.get('grant') === 'input_fixture'
      ) {
        response.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': String(input.length),
        });
        response.end(input);
        return;
      }
      if (
        url.pathname === '/output' &&
        request.method === 'PUT' &&
        url.searchParams.get('grant') === 'output_fixture'
      ) {
        const bytes = await readBody(request, 10 * 1024 * 1024);
        artifact.value = bytes;
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (request.headers['x-output-sha256'] !== hash) {
          response.writeHead(422);
          response.end();
          return;
        }
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
  server.listen(0, '0.0.0.0');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Local grant fixture did not bind a TCP port.');
  }
  port = address.port;
  try {
    // Verification always builds and reruns the Rust tests, even after a dev build.
    const { rustTests } = await buildMediaImage({
      engine: 'docker',
      noCache: true,
      execute: async (args) => execute(args, 20 * 60_000),
    });
    const result = await execute(
      [
        'run',
        '--rm',
        '--add-host',
        'host.docker.internal:host-gateway',
        '-e',
        'STARTER_ALLOW_INSECURE_LOCAL=1',
        '-e',
        `STARTER_GRANT_ORIGIN=http://host.docker.internal:${port}`,
        '-e',
        `STARTER_METADATA_URL=http://host.docker.internal:${port}/metadata`,
        '-e',
        'STARTER_CLOUD_RUN_JOB_RESOURCE=projects/local/locations/local/jobs/runner',
        '-e',
        'CLOUD_RUN_JOB=runner',
        '-e',
        'CLOUD_RUN_EXECUTION=runner-fixture',
        image,
        'job_fixture',
        'attempt_fixture',
      ],
      20 * 60_000,
    );
    if (result.code !== 0) {
      fail(
        `The finite runner did not publish a verified real encode.\n${result.output.slice(-4000)}`,
      );
    }
    const output = artifact.value;
    if (output === null || output.length === 0) {
      fail(
        `The finite runner did not publish a verified real encode.\n${result.output.slice(-4000)}`,
      );
    }
    process.stdout.write(
      `Cloud Run local runner completed ${rustTests} Rust tests and a real FFmpeg encode: ${output?.length} bytes. Google IAM and Supabase hosted behavior were not exercised.\n`,
    );
  } finally {
    server.close();
    await rm(stack, { recursive: true, force: true });
  }
};

await run();
