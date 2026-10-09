import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_INPUT = 5 * 1024 * 1024;
const MAX_OUTPUT = 10 * 1024 * 1024;
const DEADLINE_MS = 15 * 60_000;
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

class ProcessorExitError extends Error {
  constructor(exitCode) {
    super('Finite media processor returned a nonzero status.');
    this.exitCode = exitCode;
  }
}

const fetchBounded = async (url, init, maximum, deadline) => {
  const parsed = new URL(url);
  const localFixture =
    process.env.STARTER_ALLOW_INSECURE_LOCAL === '1' && parsed.hostname === 'host.docker.internal';
  if (
    parsed.protocol !== 'https:' &&
    !['localhost', '127.0.0.1'].includes(parsed.hostname) &&
    !localFixture
  ) {
    throw new Error('Grant URL must use TLS.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      throw new Error(`Grant request failed (${response.status}).`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximum) {
      throw new Error('Grant response exceeded its byte ceiling.');
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
};

const metadataIdentity = async (audience, env) => {
  const endpoint = new URL(
    env.STARTER_METADATA_URL ??
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity',
  );
  if (
    endpoint.hostname !== 'metadata.google.internal' &&
    !(env.STARTER_ALLOW_INSECURE_LOCAL === '1' && endpoint.hostname === 'host.docker.internal')
  ) {
    throw new Error('Metadata identity endpoint is not the Cloud Run metadata host.');
  }
  endpoint.searchParams.set('audience', audience);
  endpoint.searchParams.set('format', 'full');
  const response = await fetch(endpoint, {
    headers: { 'Metadata-Flavor': 'Google' },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error('Google metadata identity request failed.');
  }
  return response.text();
};

const runProcessor = (input, output, attemptId, deadline) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/local/bin/starter-media',
      [
        'encode',
        '--input',
        input,
        '--output',
        output,
        '--preset',
        'demo-180p-v1',
        '--attempt-id',
        attemptId,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    );
    let stdout = '';
    let stderrBytes = 0;
    const timer = setTimeout(() => child.kill('SIGTERM'), deadline);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 16_384) {
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64_000) {
        child.kill('SIGTERM');
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Finite media processor could not start.'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new ProcessorExitError(code ?? 9));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('Finite media processor returned invalid output metadata.'));
      }
    });
  });

/** Compose the configured job resource with Cloud Run's reserved short execution name. */
export const executionIdentity = (env) => {
  const resource = env.STARTER_CLOUD_RUN_JOB_RESOURCE ?? '';
  const execution = env.CLOUD_RUN_EXECUTION ?? '';
  if (
    !/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+$/.test(resource) ||
    resource.split('/').at(-1) !== env.CLOUD_RUN_JOB ||
    !/^[A-Za-z0-9-]{1,128}$/.test(execution)
  ) {
    throw new Error('Cloud Run execution identity is missing or inconsistent.');
  }
  return `${resource}/executions/${execution}`;
};

export const run = async ([jobId, attemptId], env = process.env) => {
  if (!idPattern.test(jobId ?? '') || !idPattern.test(attemptId ?? '')) {
    throw new Error('Job and attempt ids are required opaque identifiers.');
  }
  const callback = new URL(env.STARTER_GRANT_ORIGIN ?? '');
  const localFixture =
    env.STARTER_ALLOW_INSECURE_LOCAL === '1' && callback.hostname === 'host.docker.internal';
  if (
    callback.protocol !== 'https:' &&
    !['localhost', '127.0.0.1'].includes(callback.hostname) &&
    !localFixture
  ) {
    throw new Error('Grant callback must use TLS.');
  }
  if (callback.username || callback.password || callback.search || callback.hash) {
    throw new Error('Grant callback must be an origin URL.');
  }
  const executionName = executionIdentity(env);
  const directory = await mkdtemp(join(tmpdir(), `starter-runner-${randomUUID()}-`));
  try {
    const identity = await metadataIdentity(env.STARTER_GRANT_AUDIENCE ?? callback.origin, env);
    let response;
    for (let retry = 0; retry < 20; retry += 1) {
      response = await fetch(
        `${callback.origin}/api/internal/jobs/${encodeURIComponent(jobId)}/grants`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          headers: { authorization: `Bearer ${identity}`, 'content-type': 'application/json' },
          body: JSON.stringify({ attemptId, executionName }),
        },
      );
      if (response.status !== 409) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!response.ok) {
      throw new Error(`Runner grant request failed (${response.status}).`);
    }
    const grant = await response.json();
    if (
      grant.jobId !== jobId ||
      grant.attemptId !== attemptId ||
      !Number.isFinite(grant.expiresAt) ||
      grant.expiresAt <= Date.now() ||
      grant.expiresAt > Date.now() + 20 * 60_000
    ) {
      throw new Error('Runner grant scope or expiry is invalid.');
    }
    const inputPath = join(directory, 'input.mp4');
    const outputPath = join(directory, 'output.mp4');
    const inputBytes = await fetchBounded(grant.input.url, { method: 'GET' }, MAX_INPUT, 30_000);
    if (inputBytes.length === 0) {
      throw new Error('Runner input is empty.');
    }
    await writeFile(inputPath, inputBytes, { mode: 0o600 });
    let result;
    try {
      result = await runProcessor(inputPath, outputPath, attemptId, DEADLINE_MS);
    } catch (error) {
      if (error instanceof ProcessorExitError) {
        try {
          await fetch(`${callback.origin}/api/internal/jobs/${encodeURIComponent(jobId)}/grants`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(8000),
            headers: { authorization: `Bearer ${identity}`, 'content-type': 'application/json' },
            body: JSON.stringify({ attemptId, executionName, processorExitCode: error.exitCode }),
          });
        } catch {
          // The Workflow will classify an unreported failed task as retryable.
        }
      }
      throw new Error('Finite media processor failed.');
    }
    const output = await readFile(outputPath);
    if (output.length === 0 || output.length > MAX_OUTPUT) {
      throw new Error('Processor output is empty or exceeds the output ceiling.');
    }
    const sha256 = createHash('sha256').update(output).digest('hex');
    if (result.output_sha256 !== sha256 || result.output_bytes !== output.length) {
      throw new Error('Processor output integrity check failed.');
    }
    await fetchBounded(
      grant.output.url,
      {
        method: 'PUT',
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(output.length),
          'x-output-sha256': sha256,
          'x-output-codec': result.probe.video_codec,
          'x-output-width': String(result.probe.width),
          'x-output-height': String(result.probe.height),
          'x-output-duration-ms': String(result.probe.duration_ms),
        },
        body: output,
        duplex: 'half',
      },
      1024,
      30_000,
    );
    return { jobId, attemptId, outputKey: grant.output.key, bytes: output.length, sha256 };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'runner failed'}\n`);
      process.exitCode = 1;
    });
}
