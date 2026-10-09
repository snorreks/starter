import { generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import {
  fetch as miniflareFetch,
  Response as MiniflareResponse,
  type V4FetchHandler,
} from 'miniflare';
import { REPO_ROOT } from '../../../../scripts/src/shared/paths.ts';
import { removeOwnedFullContainers } from '../../full-global-teardown.ts';
import { publicToolEnvironment } from '../../../../scripts/src/shared/private_environment.ts';
import { runBounded } from '../../../../scripts/src/shared/run_bounded.ts';

const ACCOUNT = 'runner@e2e-fixture.iam.gserviceaccount.com';
const DISPATCHER_ACCOUNT = 'dispatcher@e2e-fixture.iam.gserviceaccount.com';
const SUBJECT = '100000000000000000001';
const RESOURCE = 'projects/e2e-fixture/locations/local/jobs/runner';
const IMAGE = 'starter-cloud-run-job:local';
const MAX_BYTES = 10 * 1024 * 1024;

const body = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) {
      throw new Error('Google fixture proxy body exceeds its bound.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/** Hosted Google boundary only: core authorization, storage and commits remain in the real Workers. */
const completedCondition = (state: string): { type: string; state: string } => {
  if (state === 'SUCCEEDED') {
    return { type: 'Completed', state: 'CONDITION_SUCCEEDED' };
  }
  if (state === 'FAILED') {
    return { type: 'Completed', state: 'CONDITION_FAILED' };
  }
  return { type: 'Completed', state: 'CONDITION_RECONCILING' };
};

export const startGoogleFixture = async (options: { appOrigin: string; runId: string }) => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...key.publicKey.export({ format: 'jwk' }),
    kid: options.runId,
    alg: 'RS256',
    use: 'sig',
  };
  const accessToken = randomBytes(32).toString('hex');
  const executions = new Map<string, { jobId: string; attemptId: string; state: string }>();
  const running = new Set<Promise<void>>();
  const containers = new Set<string>();
  let proxyOrigin = '';
  const identity = () => {
    const now = Math.floor(Date.now() / 1000);
    const parts = [
      { alg: 'RS256', kid: options.runId, typ: 'JWT' },
      {
        iss: 'https://accounts.google.com',
        aud: options.appOrigin,
        sub: SUBJECT,
        email: ACCOUNT,
        email_verified: true,
        iat: now,
        exp: now + 300,
      },
    ].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'));
    const input = parts.join('.');
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), key.privateKey).toString('base64url')}`;
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', proxyOrigin);
      if (url.pathname === '/metadata') {
        if (
          request.headers['metadata-flavor'] !== 'Google' ||
          url.searchParams.get('audience') !== options.appOrigin
        ) {
          response.writeHead(401).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'text/plain' }).end(identity());
        return;
      }
      // Do not forward arbitrary browser routes, credentials or destinations.
      if (
        !/^\/api\/internal\/jobs\/[A-Za-z0-9_-]{1,64}\/grants$/.test(url.pathname) ||
        !['GET', 'PUT', 'POST'].includes(request.method ?? '')
      ) {
        response.writeHead(404).end();
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && !['host', 'connection', 'content-length'].includes(name)) {
          headers.set(name, Array.isArray(value) ? value.join(',') : value);
        }
      }
      const bytes = request.method === 'GET' ? undefined : await body(request);
      const upstream = await fetch(`${options.appOrigin}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: bytes === undefined ? undefined : new Uint8Array(bytes),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      const output = Buffer.from(await upstream.arrayBuffer());
      if (output.length > MAX_BYTES) {
        throw new Error('Worker response exceeds fixture proxy byte ceiling.');
      }
      // Translate transport addresses only. Signed grant tokens, scope and audience are untouched.
      if (request.method === 'POST' && upstream.status === 200) {
        const grant = JSON.parse(output.toString()) as {
          input: { url: string };
          output: { url: string };
        };
        for (const object of [grant.input, grant.output]) {
          const target = new URL(object.url);
          if (target.origin !== options.appOrigin || target.pathname !== url.pathname) {
            throw new Error('Worker issued an unexpected grant destination.');
          }
          object.url = `${proxyOrigin}${target.pathname}${target.search}`;
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(grant));
        return;
      }
      response
        .writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        })
        .end(output);
    } catch {
      response.writeHead(502).end('Bounded Google fixture proxy failed.');
    }
  });
  server.listen(0, '0.0.0.0');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Google fixture proxy did not bind a port.');
  }
  proxyOrigin = `http://host.docker.internal:${address.port}`;

  const run = async (execution: string) => {
    const row = executions.get(execution);
    if (!row) {
      throw new Error('Unknown fixture execution.');
    }
    const container = `starter-e2e-${options.runId}-${randomBytes(6).toString('hex')}`;
    containers.add(container);
    let removed = false;
    try {
      const result = await runBounded({
        command: process.env.DOCKER ?? 'docker',
        args: [
          'run',
          '--rm',
          '--name',
          container,
          '--label',
          `starter.e2e.run=${options.runId}`,
          '--add-host',
          'host.docker.internal:host-gateway',
          '-e',
          'STARTER_ALLOW_INSECURE_LOCAL=1',
          '-e',
          `STARTER_GRANT_ORIGIN=${proxyOrigin}`,
          '-e',
          `STARTER_GRANT_AUDIENCE=${options.appOrigin}`,
          '-e',
          `STARTER_METADATA_URL=${proxyOrigin}/metadata`,
          '-e',
          `STARTER_CLOUD_RUN_JOB_RESOURCE=${RESOURCE}`,
          '-e',
          'CLOUD_RUN_JOB=runner',
          '-e',
          `CLOUD_RUN_EXECUTION=${execution.split('/').at(-1)}`,
          IMAGE,
          row.jobId,
          row.attemptId,
        ],
        cwd: REPO_ROOT,
        timeoutMs: 18 * 60_000,
        maxBytes: 128_000,
        env: publicToolEnvironment(process.env),
      });
      // A successful task means the finite runner verified its processor metadata and uploaded bytes.
      // The Workflow independently validates R2 metadata and fences the Postgres commit.
      removed = result.code === 0;
      row.state = removed ? 'SUCCEEDED' : 'FAILED';
      if (result.code !== 0) {
        process.stderr.write(
          `Finite E2E runner failed (${result.code}): ${result.stderr.slice(-2000)}\n`,
        );
      }
    } catch {
      row.state = 'FAILED';
    } finally {
      if (removed) {
        containers.delete(container);
      }
    }
  };
  const json = (value: unknown, status = 200) =>
    new MiniflareResponse(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const outbound: V4FetchHandler = async (request) => {
    const url = new URL(request.url);
    if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') {
      return json({ keys: [jwk] });
    }
    if (url.href === 'https://oauth2.googleapis.com/token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      const assertion = form.get('assertion') ?? '';
      const [header, payload, signature] = assertion.split('.');
      try {
        const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString());
        if (
          form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' ||
          JSON.parse(Buffer.from(header ?? '', 'base64url').toString()).alg !== 'RS256' ||
          !verify(
            'RSA-SHA256',
            Buffer.from(`${header}.${payload}`),
            key.publicKey,
            Buffer.from(signature ?? '', 'base64url'),
          ) ||
          claims.iss !== DISPATCHER_ACCOUNT ||
          claims.sub !== DISPATCHER_ACCOUNT ||
          claims.aud !== url.href ||
          claims.scope !== 'https://www.googleapis.com/auth/cloud-platform' ||
          typeof claims.exp !== 'number' ||
          !Number.isFinite(claims.exp) ||
          claims.exp <= Date.now() / 1000
        ) {
          return json({ error: 'invalid_grant' }, 401);
        }
        return json({ access_token: accessToken });
      } catch {
        return json({ error: 'invalid_grant' }, 401);
      }
    }
    if (url.hostname === 'run.googleapis.com') {
      if (request.headers.get('authorization') !== `Bearer ${accessToken}`) {
        return json({ error: 'unauthorized' }, 401);
      }
      const base = `/v2/${RESOURCE}`;
      if (url.pathname === `${base}/executions` && request.method === 'GET') {
        return json({
          executions: [...executions].map(([name, row]) => ({
            name,
            conditions: [completedCondition(row.state)],
            template: { containers: [{ args: [row.jobId, row.attemptId] }] },
          })),
        });
      }
      if (url.pathname === `${base}:run` && request.method === 'POST') {
        const document = (await request.json()) as {
          overrides?: { containerOverrides?: Array<{ args?: string[] }> };
        };
        const args = document.overrides?.containerOverrides?.[0]?.args;
        if (args?.length !== 2 || args.some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
          return json({ error: 'invalid_args' }, 400);
        }
        const executionId = randomBytes(12).toString('hex');
        const execution = `${RESOURCE}/executions/runner-${executionId}`;
        executions.set(execution, {
          jobId: args[0] ?? '',
          attemptId: args[1] ?? '',
          state: 'RUNNING',
        });
        const task = run(execution);
        running.add(task);
        void task.finally(() => running.delete(task));
        return json({ name: `projects/e2e-fixture/locations/local/operations/${executionId}` });
      }
      const operation = url.pathname.match(
        /^\/v2\/projects\/e2e-fixture\/locations\/local\/operations\/([a-f0-9]+)$/,
      );
      const execution = `${RESOURCE}/executions/runner-${operation?.[1]}`;
      const row = executions.get(execution);
      if (operation && row) {
        return json(
          row.state === 'RUNNING' ? { done: false } : { done: true, response: { name: execution } },
        );
      }
      return json({ error: 'unknown_google_resource' }, 404);
    }
    if (['oauth2.googleapis.com', 'www.googleapis.com'].includes(url.hostname)) {
      return json({ error: 'unexpected_google_request' }, 404);
    }
    return miniflareFetch(request);
  };
  return {
    outbound,
    bindings: {
      GOOGLE_CLOUD_PROJECT: 'e2e-fixture',
      GOOGLE_CLOUD_REGION: 'local',
      GOOGLE_CLOUD_RUN_JOB: 'runner',
      GOOGLE_RUNNER_SERVICE_ACCOUNT: ACCOUNT,
      GOOGLE_RUNNER_SUBJECT: SUBJECT,
      GOOGLE_RUNNER_AUDIENCE: options.appOrigin,
      GOOGLE_DISPATCHER_CREDENTIAL: JSON.stringify({
        client_email: DISPATCHER_ACCOUNT,
        private_key: key.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      }),
      RUNNER_GRANT_SECRET: randomBytes(32).toString('hex'),
      COMPUTE_PROTOCOL: 'sample-v1',
    },
    async dispose() {
      try {
        if (containers.size > 0) {
          await removeOwnedFullContainers(options.runId);
        }
        await Promise.all(running);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  };
};
