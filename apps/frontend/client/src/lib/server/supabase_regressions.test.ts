import { afterAll, expect, mock, test } from 'bun:test';
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
import { decodeChatStream, type Message } from '@starter/schemas/chat';
import { POST as postChat } from '../../routes/api/chat/conversations/[id]/messages/+server.ts';
import { GET as getJobs, POST as postJob } from '../../routes/api/jobs/+server.ts';
import { GET as getJob } from '../../routes/api/jobs/[id]/+server.ts';
import { createRequestNotesService } from './notes_service.ts';

const user = { id: 'f45b2c4a-7919-4f55-ae89-e73f6753e322', emailVerified: true };
const conversationId = 'conv_12345678-1234-4123-8123-123456789012';
const storedUser: Message = {
  id: 'msg_12345678-1234-4123-8123-123456789012',
  conversationId,
  authorId: user.id,
  role: 'user',
  content: 'hello',
  status: 'complete',
  createdAt: 1,
};
const storedAssistant: Message = {
  ...storedUser,
  id: 'msg_87654321-1234-4123-8123-123456789012',
  role: 'assistant',
  content: 'saved reply',
};
const chatFixture = (
  outcome: 'admitted' | 'completed' | 'in_flight' | 'running' | 'conflict',
  missing = false,
) => {
  const chat = {
    findConversation: mock(async () => (missing ? null : { id: conversationId })),
    listConversations: mock(async () => []),
    listMessages: mock(async () => ({
      items: [],
      nextCursor: null,
      hasMore: false,
      serverTime: 1,
    })),
    findMessageByClientId: mock(async (_owner: string, _conversation: string, id: string) =>
      id.startsWith('assistant:') ? storedAssistant : storedUser,
    ),
    admitGeneration: mock(async () => ({
      outcome,
      assistantMessageId: storedAssistant.id,
      attempt: 3,
    })),
    completeGeneration: mock(async () => storedAssistant.id),
    failGeneration: mock(async () => {}),
  };
  const generate = mock(async function* () {
    yield { text: 'new reply' };
  });
  const event = {
    locals: {
      user,
      context: { backendProfile: 'supabase', user, services: { identity: { user }, chat } },
      container: { chatModel: { generate } },
    },
    params: { id: conversationId },
    request: new Request('http://localhost/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify({ content: 'hello', clientId: 'turn' }),
    }),
  } as unknown as Parameters<typeof postChat>[0];
  return { chat, generate, event };
};

test('a conversation outside page zero streams with the admitted assistant ID', async () => {
  const { chat, generate, event } = chatFixture('admitted');
  const response = await postChat(event);
  expect(response.status).toBe(200);
  const frames = decodeChatStream(await response.text());
  expect(chat.findConversation).toHaveBeenCalledWith(user.id, conversationId);
  expect(chat.listConversations).not.toHaveBeenCalled();
  expect(frames[0]).toMatchObject({ type: 'user-message', message: { id: storedUser.id } });
  expect(frames[1]).toEqual({ type: 'start', messageId: storedAssistant.id });
  expect(frames.at(-1)).toMatchObject({
    type: 'complete',
    message: { id: storedAssistant.id, content: 'new reply' },
  });
  expect(chat.completeGeneration).toHaveBeenCalledWith({
    conversationId,
    clientId: 'turn',
    attempt: 3,
    content: 'new reply',
  });
  expect(generate).toHaveBeenCalledTimes(1);
});

test('a completed retry replays stored messages without regenerating or completing again', async () => {
  const { chat, generate, event } = chatFixture('completed');
  const response = await postChat(event);
  expect(decodeChatStream(await response.text())).toEqual([
    { type: 'user-message', clientId: 'turn', message: storedUser },
    { type: 'start', messageId: storedAssistant.id },
    { type: 'complete', message: storedAssistant },
  ]);
  expect(generate).not.toHaveBeenCalled();
  expect(chat.completeGeneration).not.toHaveBeenCalled();
});

test('provider completion followed by a persistence failure records a failed attempt and emits a terminal error', async () => {
  const { chat, event } = chatFixture('admitted');
  chat.completeGeneration = mock(async () => {
    throw new Error('database unavailable');
  });
  const response = await postChat(event);
  const frames = decodeChatStream(await response.text());
  expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'persistence_failed' });
  expect(chat.failGeneration).toHaveBeenCalledWith({
    conversationId,
    clientId: 'turn',
    attempt: 3,
    state: 'failed',
  });
});

test('a running turn returns a recoverable 409 while a missing conversation remains 404', async () => {
  for (const missing of [false, true]) {
    const { chat, generate, event } = chatFixture(missing ? 'running' : 'running', missing);
    const response = await postChat(event);
    expect(response.status).toBe(missing ? 404 : 409);
    expect(await response.json()).toMatchObject(
      missing ? { error: 'not_found' } : { code: 'running', recoverable: true },
    );
    expect(generate).not.toHaveBeenCalled();
    expect(chat.findMessageByClientId).not.toHaveBeenCalled();
    if (missing) {
      expect(chat.admitGeneration).not.toHaveBeenCalled();
    }
  }
});

test('a reused idempotency key with changed content returns conflict without provider work', async () => {
  const { generate, event } = chatFixture('conflict');
  const response = await postChat(event);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'conflict' });
  expect(generate).not.toHaveBeenCalled();
});

test('notes follow pages until the last page or the 200-note limit', async () => {
  for (const total of [73, 230]) {
    const notes = Array.from({ length: total }, (_, id) => ({
      id: String(id),
      ownerId: user.id,
      title: 'note',
      body: '',
      createdAt: 1,
      updatedAt: 1,
    }));
    const calls: (string | null)[] = [];
    const list = mock(async (_owner: string, cursor: string | null) => {
      calls.push(cursor);
      const page = cursor === null ? 0 : Number(atob(cursor));
      const hasMore = (page + 1) * 50 < total;
      return {
        notes: notes.slice(page * 50, (page + 1) * 50),
        hasMore,
        serverTime: 1,
        nextCursor: hasMore ? btoa(String(page + 1)) : null,
      };
    });
    const service = createRequestNotesService({
      context: {
        backendProfile: 'supabase',
        user,
        services: { identity: { user }, notes: { list } },
      },
    } as unknown as Parameters<typeof createRequestNotesService>[0]);
    expect(await service.list(user.id)).toEqual(notes.slice(0, 200));
    expect(calls).toEqual(
      Array.from({ length: Math.ceil(Math.min(total, 200) / 50) }, (_, page) =>
        page === 0 ? null : btoa(String(page)),
      ),
    );
    await expect(service.list('other')).rejects.toThrow(/owner/);
  }
});

test('Supabase job admission starts one Cloudflare Workflow and a failed start is visible', async () => {
  for (const [outcome, dispatchState] of [
    ['created', 'pending'],
    ['replayed', 'pending'],
    ['replayed', 'dispatch_failed'],
    ['replayed', 'dispatched'],
  ] as const) {
    const shouldStart = outcome === 'created' || dispatchState !== 'dispatched';
    const jobs = {
      dispatch: 'cloud_run',
      admit: mock(
        async (input: { id: string; fixture: string; preset: string; workflowId: string }) => ({
          outcome,
          jobId: input.id,
        }),
      ),
      disableDispatch: mock(async () => false),
      startEncode: mock(
        async (_input: {
          jobId: string;
          fixture: 'sample-v1';
          preset: 'demo-180p-v1';
          attemptId: string;
        }) => false,
      ),
      getForOwner: mock(async () => ({ id: 'job', dispatchState })),
    };
    const response = await postJob({
      locals: {
        user: { ...user, email: 'owner@example.test', displayName: 'Owner', provider: 'email' },
        container: { jobsProfile: 'encode' },
        applicationServices: { identity: { user }, jobs },
      },
      request: new Request('http://localhost/api/jobs', {
        method: 'POST',
        headers: { 'idempotency-key': 'turn' },
        body: JSON.stringify({ fixture: 'sample-v1', preset: 'demo-180p-v1' }),
      }),
    } as unknown as Parameters<typeof postJob>[0]);
    expect(response.status).toBe(shouldStart ? 503 : 202);
    expect(jobs.startEncode).toHaveBeenCalledTimes(shouldStart ? 1 : 0);
    expect(jobs.disableDispatch).not.toHaveBeenCalled();
    if (shouldStart) {
      const admitted = jobs.admit.mock.calls[0]?.[0];
      expect(admitted).toMatchObject({ fixture: 'sample-v1', preset: 'demo-180p-v1' });
      expect(admitted?.workflowId).toBe(`encode-${admitted?.id}`);
      expect(jobs.startEncode.mock.calls[0]?.[0]).toMatchObject({
        jobId: admitted?.id,
        fixture: 'sample-v1',
        preset: 'demo-180p-v1',
      });
      expect(await response.json()).toMatchObject({ error: 'job_dispatch_failed' });
      expect(jobs.getForOwner).toHaveBeenCalledTimes(outcome === 'created' ? 0 : 1);
    } else {
      expect((await response.json()) as { id: string }).toEqual({ id: 'job' });
    }
  }
});

test('Supabase job reads keep dispatch state out of the public DTO', async () => {
  const job = { id: 'job_a', dispatchState: 'dispatch_failed' };
  const locals = {
    user,
    context: { backendProfile: 'supabase', user },
    container: { jobsProfile: 'encode' },
    applicationServices: {
      identity: { user },
      jobs: {
        listForOwner: async () => [job],
        getForOwner: async () => job,
      },
    },
  };
  const list = await getJobs({ locals } as unknown as Parameters<typeof getJobs>[0]);
  const listBody = await list.json();
  expect(listBody).toMatchObject({ jobs: [{ id: 'job_a' }] });
  expect(JSON.stringify(listBody)).not.toContain('dispatchState');
  const detail = await getJob({ locals, params: { id: job.id } } as unknown as Parameters<
    typeof getJob
  >[0]);
  const detailBody = await detail.json();
  expect(detailBody).toMatchObject({ id: 'job_a' });
  expect(JSON.stringify(detailBody)).not.toContain('dispatchState');
});

const job = { id: 'job', outputAvailable: true, errorCode: null, dispatchState: 'dispatched' };
const jobsFixture = () => {
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
  for (const handler of [getJobs, getJob, output]) {
    const { jobs, bucket, event } = jobsFixture();
    event.locals.container.jobsProfile = 'disabled';
    const response = await handler(
      event as unknown as Parameters<typeof getJobs>[0] &
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
    const { jobs, bucket, event } = jobsFixture();
    jobs.getForOwner.mockImplementation(async () =>
      state === 'missing' ? null : { ...job, outputAvailable: state !== 'unfinished' },
    );
    jobs.outputForOwner.mockImplementation(async () => null);
    const response = await output(event as unknown as Parameters<typeof output>[0]);
    const [status, error] = (
      {
        missing: [404, 'not_found'],
        unfinished: [409, 'output_not_ready'],
        expired: [410, 'output_expired'],
      } as const
    )[state];
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect(bucket.head).not.toHaveBeenCalled();
  }
});

test('full and partial private artifacts preserve their type and use sandbox and nosniff', async () => {
  for (const partial of [false, true]) {
    const { event } = jobsFixture();
    if (partial) {
      event.request.headers.set('range', 'bytes=0-3');
    }
    const response = await output(event as unknown as Parameters<typeof output>[0]);
    expect(response.status).toBe(partial ? 206 : 200);
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
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
    const { jobs, event } = jobsFixture();
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
