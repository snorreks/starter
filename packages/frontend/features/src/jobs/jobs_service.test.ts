// packages/frontend/features/src/jobs/jobs_service.test.ts
//
// The contract boundary for jobs, and the byte path that JSON cannot serve.
//
// Two claims are proved here, and the second is the one that is easy to get wrong:
//
//   * every JSON answer is validated against the schema the server validated
//     against, so a proxy's HTML or a two-deploys-old field is a `server` error
//     rather than a screen showing nothing;
//   * the artifact read is a *different* call, because `ApiTransport.request` reads
//     its body as text and would hand back a truncated string for an MP4 — a
//     successful-looking answer carrying half a video.
//
// No SvelteKit, no network, no app runtime. The transport is a fake object, which
// is the property this package was extracted for.
//
// "A host that cannot fetch bytes cannot construct this feature" is enforced by
// the compiler rather than by a test here: `JobsService` takes an
// `ArtifactTransport`, so passing an `ApiTransport` is a type error. A test
// asserting that a type is a type would be noise.

import { describe, expect, test } from 'bun:test';
import type {
  ArtifactBytes,
  ArtifactRequestOptions,
  ArtifactTransport,
  TransportRequestOptions,
} from '@starter/platform';
import { AppError } from '@starter/utils';
import { JobsService, jobOutputPath } from './jobs_service.svelte.ts';

interface Recorded {
  readonly path: string;
  readonly options: TransportRequestOptions | undefined;
}

const job = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'job_1',
  kind: 'encode',
  status: 'pending',
  createdAt: 1,
  updatedAt: 1,
  outputAvailable: false,
  errorCode: null,
  ...overrides,
});

const maintenance = (): Record<string, unknown> => ({
  schedule: '17 * * * *',
  latest: null,
  latestScheduled: null,
  serverTime: 1,
});

interface FakeTransport {
  readonly transport: ArtifactTransport;
  readonly calls: Recorded[];
  readonly artifactCalls: Array<{ path: string; options: ArtifactRequestOptions | undefined }>;
}

const fakeTransport = (bodies: Record<string, unknown>): FakeTransport => {
  const calls: Recorded[] = [];
  const artifactCalls: Array<{ path: string; options: ArtifactRequestOptions | undefined }> = [];

  const request = async <T>(path: string, options?: TransportRequestOptions): Promise<T> => {
    calls.push({ path, options });
    const body = bodies[path];
    if (body instanceof Error) {
      throw body;
    }
    return body as T;
  };

  return {
    calls,
    artifactCalls,
    transport: {
      request,
      async fetchBytes(path: string, options?: ArtifactRequestOptions): Promise<ArtifactBytes> {
        artifactCalls.push({ path, options });
        return { bytes: new Uint8Array(4), contentType: 'video/mp4', contentLength: 4 };
      },
    },
  };
};

const serviceOver = (
  bodies: Record<string, unknown>,
): { service: JobsService; fake: FakeTransport } => {
  const fake = fakeTransport(bodies);
  return { service: new JobsService({ transport: fake.transport }), fake };
};

describe('the list and the scheduler evidence', () => {
  test('both are read, and both are validated', async () => {
    const { service, fake } = serviceOver({
      '/api/jobs': { jobs: [job()], nextCursor: null, serverTime: 1 },
      '/api/jobs/maintenance': maintenance(),
    });

    const result = await service.load();

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.status).toBe('pending');
    expect(result.maintenance.schedule).toBe('17 * * * *');
    expect(fake.calls.map((call) => call.path)).toEqual(['/api/jobs', '/api/jobs/maintenance']);
  });

  test('a list that is not the frozen shape is refused by name', async () => {
    // What an intermediary, or a server from two deploys ago, returns. `as
    // JobDto[]` would have made this an empty list reported to the user as "you
    // have no jobs yet".
    const { service } = serviceOver({
      '/api/jobs': { jobs: [{ id: 'job_1' }], nextCursor: null, serverTime: 1 },
      '/api/jobs/maintenance': maintenance(),
    });

    await expect(service.load()).rejects.toThrow(/a job list this build does not understand/);
  });

  test('a maintenance answer claiming a progress percentage is refused', async () => {
    const { service } = serviceOver({
      '/api/jobs': { jobs: [], nextCursor: null, serverTime: 1 },
      '/api/jobs/maintenance': { ...maintenance(), progress: 42 },
    });

    await expect(service.load()).rejects.toThrow(
      /the latest maintenance run this build does not understand/,
    );
  });

  test("another user's field cannot arrive through the DTO", async () => {
    // The closed schema is what makes this an outright refusal rather than a
    // field the client ignores.
    const { service } = serviceOver({
      '/api/jobs': {
        jobs: [job({ ownerId: 'user_somebody_else' })],
        nextCursor: null,
        serverTime: 1,
      },
      '/api/jobs/maintenance': maintenance(),
    });

    await expect(service.load()).rejects.toThrow();
  });
});

describe('starting the sample encode', () => {
  test('the request is the frozen one, and the key travels in a header', async () => {
    const { service, fake } = serviceOver({ '/api/jobs': job() });

    const created = await service.createEncode('key-abc123');

    expect(created.id).toBe('job_1');
    const call = fake.calls[0];
    expect(call?.options?.method).toBe('POST');
    expect(call?.options?.body).toEqual({ fixture: 'sample-v1', preset: 'demo-180p-v1' });
    // A header, never a query parameter: a key in a URL lands in history, referrers
    // and proxy logs.
    expect(call?.options?.headers).toEqual({ 'idempotency-key': 'key-abc123' });
  });

  test('an error envelope is left for the ViewModel to classify', async () => {
    const { service } = serviceOver({
      '/api/jobs': new AppError('rate_limited', 'You have used your job allowance.', {
        status: 429,
        cause: { error: 'budget_exceeded', message: 'You have used your job allowance.' },
      }),
    });

    await expect(service.createEncode('key-abc123')).rejects.toThrow(/job allowance/);
  });
});

describe('reading the result', () => {
  test('the bytes come from the byte path, never from the JSON one', async () => {
    const { service, fake } = serviceOver({});

    const artifact = await service.readOutput('job_1', { signal: new AbortController().signal });

    expect(artifact.bytes.byteLength).toBe(4);
    expect(fake.artifactCalls).toHaveLength(1);
    // The JSON transport was never asked. Pointing it at an MP4 would parse the
    // first bytes of the file and either throw or return a plausible-looking
    // string.
    expect(fake.calls).toEqual([]);
    expect(fake.artifactCalls[0]?.path).toBe('/api/jobs/job_1/output');
  });

  test('a job id is escaped into the path', async () => {
    const { service, fake } = serviceOver({});

    await service.readOutput('job/../admin');

    expect(fake.artifactCalls[0]?.path).toBe(jobOutputPath('job/../admin'));
    expect(fake.artifactCalls[0]?.path).toBe('/api/jobs/job%2F..%2Fadmin/output');
  });

  test('a range is forwarded, and the caller owns the bound', async () => {
    const { service, fake } = serviceOver({});

    await service.readOutput('job_1', { range: { startInclusive: 0, endInclusive: 1023 } });

    expect(fake.artifactCalls[0]?.options?.range).toEqual({
      startInclusive: 0,
      endInclusive: 1023,
    });
  });
});
