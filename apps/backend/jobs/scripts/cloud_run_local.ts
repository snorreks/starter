import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const media = join(root, 'apps/backend/media');
const image = 'starter-cloud-run-job:local';
const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const execute = (args: string[], timeoutMs: number) =>
  new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn('docker', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (part: Buffer) => {
      output += part.toString();
    });
    child.stderr.on('data', (part: Buffer) => {
      output += part.toString();
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ code: 127, output });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });

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
  const runnerTests = Bun.spawnSync(['bun', 'test', 'runner.test.ts'], {
    cwd: join(media, 'runner'),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (runnerTests.exitCode !== 0) {
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
          body.executionName !== 'projects/local/locations/local/jobs/runner/executions/run-fixture'
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
    const built = await execute(
      [
        'build',
        '--file',
        'apps/backend/media/Dockerfile.job',
        '--tag',
        image,
        '--build-arg',
        `BUILD_GIT_REVISION=${process.env.GITHUB_SHA ?? 'local'}`,
        'apps/backend/media',
      ],
      20 * 60_000,
    );
    if (built.code !== 0) {
      fail(`The finite Cloud Run job image failed to build.\n${built.output.slice(-4000)}`);
    }
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
        'CLOUD_RUN_EXECUTION=projects/local/locations/local/jobs/runner/executions/run-fixture',
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
      `Cloud Run local runner completed a real FFmpeg encode: ${output?.length} bytes. Google IAM and Supabase hosted behavior were not exercised.\n`,
    );
  } finally {
    server.close();
    await rm(stack, { recursive: true, force: true });
  }
};

await run();
