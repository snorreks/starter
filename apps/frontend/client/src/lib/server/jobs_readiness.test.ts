import { afterAll, expect, mock, test } from 'bun:test';
import { GET as listJobs } from '../../routes/api/jobs/+server.ts';
import { GET as getJob } from '../../routes/api/jobs/[id]/+server.ts';
import {
  DELETE,
  GET as output,
  PATCH,
  POST,
  PUT,
} from '../../routes/api/jobs/[id]/output/+server.ts';
import { load } from '../../routes/jobs/+page.server.ts';
import type { Container } from './container.ts';
import { readiness } from './release.ts';

const user = { id: 'owner', emailVerified: true };
const job = { id: 'job', outputAvailable: true, errorCode: null, dispatchState: 'dispatched' };
const fixture = () => {
  const jobs = {
    listForOwner: mock(async () => [job]),
    getForOwner: mock(async (): Promise<typeof job | null> => job),
    outputForOwner: mock(
      async (): Promise<{ key: string; expiresAt: number } | null> => ({
        key: 'private/output',
        expiresAt: Date.now() + 60_000,
      }),
    ),
    latestMaintenance: mock(async (): Promise<unknown> => null),
  };
  const bucket = {
    head: mock(async () => ({ size: 4 })),
    get: mock(async () => ({ body: 'data', httpMetadata: { contentType: 'text/html' } })),
  };
  const event = {
    locals: {
      user,
      container: { jobsProfile: 'encode' },
      applicationServices: { identity: { user }, jobs },
    },
    params: { id: 'job' },
    platform: { MEDIA: bucket },
    request: new Request('http://localhost/api/jobs/job/output'),
  };
  return { jobs, bucket, event };
};

test('disabled jobs reads refuse before accessing repositories or artifacts', async () => {
  for (const handler of [listJobs, getJob, output]) {
    const { jobs, bucket, event } = fixture();
    event.locals.container.jobsProfile = 'disabled';
    const response = await handler(
      event as unknown as Parameters<typeof listJobs>[0] &
        Parameters<typeof getJob>[0] &
        Parameters<typeof output>[0],
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'jobs_profile_disabled' });
    expect(jobs.listForOwner).not.toHaveBeenCalled();
    expect(jobs.getForOwner).not.toHaveBeenCalled();
    expect(jobs.outputForOwner).not.toHaveBeenCalled();
    expect(bucket.head).not.toHaveBeenCalled();
  }
});

test('missing jobs remain 404, unfinished outputs 409, and expired outputs 410', async () => {
  for (const state of ['missing', 'unfinished', 'expired'] as const) {
    const { jobs, bucket, event } = fixture();
    jobs.getForOwner.mockImplementation(async () =>
      state === 'missing' ? null : { ...job, outputAvailable: state !== 'unfinished' },
    );
    jobs.outputForOwner.mockImplementation(async () => null);
    const response = await output(event as unknown as Parameters<typeof output>[0]);
    const [status, error] = {
      missing: [404, 'not_found'],
      unfinished: [409, 'output_not_ready'],
      expired: [410, 'output_expired'],
    }[state];
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect(bucket.head).not.toHaveBeenCalled();
  }
});

test('full and partial private artifacts preserve their type and use sandbox and nosniff', async () => {
  for (const partial of [false, true]) {
    const { event } = fixture();
    if (partial) {
      event.request.headers.set('range', 'bytes=0-3');
    }
    const response = await output(event as unknown as Parameters<typeof output>[0]);
    expect(response.status).toBe(partial ? 206 : 200);
    expect(response.headers.get('content-security-policy')).toBe('sandbox');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('content-range')).toBe(partial ? 'bytes 0-3/4' : null);
    expect(await response.text()).toBe('data');
  }
});

test('output mutations return the explicit method refusal', async () => {
  for (const handler of [POST, PUT, PATCH, DELETE]) {
    const response = handler();
    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({ error: 'method_not_allowed' });
  }
});

test('invalid maintenance data does not hide jobs and valid data is preserved', async () => {
  const valid = { schedule: '17 * * * *', latest: null, latestScheduled: null, serverTime: 1 };
  for (const maintenance of [null, { invalid: true }, valid]) {
    const { jobs, event } = fixture();
    jobs.latestMaintenance.mockImplementation(async () => maintenance);
    const result = await load(event as unknown as Parameters<typeof load>[0]);
    expect(result).toMatchObject({
      jobs: [{ id: 'job' }],
      maintenance: maintenance === valid ? valid : null,
    });
  }
});

let probeResponse = '1';
let probeStatus = 200;
let hang = false;
const requests: { url: string; method: string; apikey: string | null }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    requests.push({
      url: request.url,
      method: request.method,
      apikey: request.headers.get('apikey'),
    });
    if (hang) {
      return new Promise<Response>(() => {});
    }
    return new Response(probeResponse, { status: probeStatus });
  },
});
afterAll(() => server.stop(true));
const container = {
  env: { RELEASE: 'test' },
  environment: 'local',
  isLocal: true,
  supabase: { url: server.url.origin, anonKey: 'synthetic-anon' },
} as Container;

test('readiness requires the SQL probe result, not merely a successful HTTP response', async () => {
  for (const [body, status, ok] of [
    ['1', 200, true],
    ['{}', 200, false],
    ['0', 200, false],
    ['1', 503, false],
    ['invalid', 200, false],
  ] as const) {
    probeResponse = body;
    probeStatus = status;
    const report = await readiness(container);
    expect(report.ok).toBe(ok);
    expect(report.checks[0]?.ok).toBe(ok);
    expect(report.release.release).toBe('test');
    const request = requests.at(-1);
    expect(new URL(request?.url ?? '').pathname).toBe('/rest/v1/rpc/readiness_probe');
    expect(request?.method).toBe('POST');
    expect(request?.apikey).toBe('synthetic-anon');
  }
});

test('a stalled database probe is bounded and reports not ready without leaking errors', async () => {
  hang = true;
  try {
    const report = await readiness(container, 10);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.detail).toBe('Database probe failed');
  } finally {
    hang = false;
  }
});
