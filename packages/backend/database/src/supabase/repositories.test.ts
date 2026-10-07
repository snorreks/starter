import { afterEach, describe, expect, test } from 'bun:test';
import { createSupabaseChatRepository } from './chat_repository.ts';
import { createAdminDatabaseClient, createUserDatabaseClient } from './client.ts';
import { createSupabaseJobRepository } from './jobs_repository.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const captureRequests = (responses: unknown[] = [[]]): Headers[] => {
  const headers: Headers[] = [];
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return Response.json(responses.shift());
    },
    { preconnect: originalFetch.preconnect },
  );
  return headers;
};

const userClient = () =>
  createUserDatabaseClient({ url: 'http://127.0.0.1:54321', anonKey: 'anon' }, 'user-token');
const adminClient = () =>
  createAdminDatabaseClient({
    url: 'http://127.0.0.1:54321',
    anonKey: 'anon',
    serviceRoleKey: 'local-only-service-role',
  });

describe('request scoped Supabase clients', () => {
  test('user requests carry the caller token and the public API key', async () => {
    const headers = captureRequests();
    const client = userClient();
    const { error } = await client.from('notes').select('id');
    expect(error).toBeNull();
    expect(headers).toHaveLength(1);
    expect(headers[0]?.get('Authorization')).toBe('Bearer user-token');
    expect(headers[0]?.get('apikey')).toBe('anon');
  });

  test('admin requests carry the service role in both authorization headers', async () => {
    const headers = captureRequests();
    const client = adminClient();
    const { error } = await client.from('notes').select('id');
    expect(error).toBeNull();
    expect(headers).toHaveLength(1);
    expect(headers[0]?.get('Authorization')).toBe('Bearer local-only-service-role');
    expect(headers[0]?.get('apikey')).toBe('local-only-service-role');
  });

  test('chat completion refuses a missing admin client before making a request', async () => {
    const headers = captureRequests();
    const repository = createSupabaseChatRepository(userClient());
    await expect(
      repository.completeGeneration({
        conversationId: 'conv_123',
        clientId: 'turn',
        attempt: 1,
        content: 'answer',
      }),
    ).rejects.toThrow('requires an explicit admin client');
    expect(headers).toHaveLength(0);
  });

  test('chat completion uses the explicit admin identity', async () => {
    const headers = captureRequests(['assistant-id']);
    const repository = createSupabaseChatRepository(userClient(), adminClient());
    expect(
      await repository.completeGeneration({
        conversationId: 'conv_123',
        clientId: 'turn',
        attempt: 1,
        content: 'answer',
      }),
    ).toBe('msg_assistant-id');
    expect(headers[0]?.get('Authorization')).toBe('Bearer local-only-service-role');
  });

  test('job admission uses the caller while claim and completion use the service role', async () => {
    const headers = captureRequests([[{ outcome: 'created', job_id: 'job' }], true, true]);
    const repository = createSupabaseJobRepository(userClient(), adminClient());
    expect(
      await repository.admit({
        id: 'job',
        fixture: 'sample-v1',
        preset: 'demo-180p-v1',
        idempotencyKey: 'key',
        fingerprint: 'a'.repeat(64),
        workflowId: 'workflow',
      }),
    ).toEqual({ outcome: 'created', jobId: 'job' });
    expect(await repository.claim('job', 'attempt')).toBe(true);
    expect(
      await repository.complete({
        jobId: 'job',
        attemptId: 'attempt',
        outputKey: 'output',
        bytes: 123,
        sha256: 'a'.repeat(64),
        format: 'mp4',
        codec: 'h264',
        width: 320,
        height: 180,
        durationMs: 1000,
      }),
    ).toBe(true);
    expect(headers.map((request) => request.get('Authorization'))).toEqual([
      'Bearer user-token',
      'Bearer local-only-service-role',
      'Bearer local-only-service-role',
    ]);
  });

  test('Cloud Run execution records, failure and grants remain service-role and attempt scoped', async () => {
    const headers = captureRequests([
      true,
      true,
      [
        {
          job_id: 'job_a',
          attempt_id: 'attempt_a',
          fixture: 'sample-v1',
          preset: 'demo-180p-v1',
          output_key: 'media/v1/jobs/job_a/attempts/attempt_a.mp4',
          expires_at: '2026-10-07T12:00:00.000Z',
        },
      ],
      [],
    ]);
    const repository = createSupabaseJobRepository(userClient(), adminClient());
    expect(
      await repository.recordExecution(
        'job_a',
        'attempt_a',
        'projects/p/locations/r/jobs/j/executions/e',
      ),
    ).toBe(true);
    expect(await repository.fail('job_a', 'attempt_a', 'internal_error', true)).toBe(true);
    expect(
      await repository.authorizeRunner(
        'job_a',
        'attempt_a',
        'projects/p/locations/r/jobs/j/executions/e',
      ),
    ).toEqual({
      jobId: 'job_a',
      attemptId: 'attempt_a',
      fixture: 'sample-v1',
      preset: 'demo-180p-v1',
      outputKey: 'media/v1/jobs/job_a/attempts/attempt_a.mp4',
      expiresAt: Date.parse('2026-10-07T12:00:00.000Z'),
    });
    expect(
      await repository.authorizeRunner(
        'job_a',
        'attempt_stale',
        'projects/p/locations/r/jobs/j/executions/e',
      ),
    ).toBeNull();
    expect(headers.map((request) => request.get('Authorization'))).toEqual([
      'Bearer local-only-service-role',
      'Bearer local-only-service-role',
      'Bearer local-only-service-role',
      'Bearer local-only-service-role',
    ]);
  });

  test('job status and list use owner-scoped RPCs and reject malformed DTO data', async () => {
    const status = {
      id: 'job_preview_1',
      kind: 'encode',
      status: 'pending',
      createdAt: 1,
      updatedAt: 2,
      outputAvailable: false,
      errorCode: null,
    } as const;
    const headers = captureRequests([
      status,
      [status],
      true,
      { ...status, kind: 'invalid' },
      [status, { ...status, kind: 'invalid' }],
      status,
    ]);
    const repository = createSupabaseJobRepository(userClient(), adminClient());
    expect(await repository.getForOwner(status.id)).toEqual(status);
    expect(await repository.listForOwner()).toEqual([status]);
    expect(await repository.disableDispatch(status.id)).toBe(true);
    expect(headers.map((request) => request.get('Authorization'))).toEqual([
      'Bearer user-token',
      'Bearer user-token',
      'Bearer local-only-service-role',
    ]);
    expect(await repository.getForOwner(status.id)).toBeNull();
    await expect(repository.listForOwner()).rejects.toThrow();
    await expect(repository.listForOwner()).rejects.toThrow();
  });
});

test('conversation and stored-message lookups constrain the owner and ID in the query', async () => {
  const urls: URL[] = [];
  const row = {
    id: '123',
    owner_id: 'owner',
    title: 'Older conversation',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    messages: [{ count: 2 }],
  };
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      return Response.json(url.searchParams.get('owner_id') === 'eq.owner' ? row : null);
    },
    { preconnect: originalFetch.preconnect },
  );
  const repository = createSupabaseChatRepository(userClient());
  expect(await repository.findConversation('owner', 'conv_123')).toMatchObject({
    id: 'conv_123',
    messageCount: 2,
  });
  expect(await repository.findConversation('other', 'conv_123')).toBeNull();
  expect(await repository.findMessageByClientId('other', 'conv_123', 'turn')).toBeNull();
  expect(urls[0]?.searchParams.get('id')).toBe('eq.123');
  expect(urls[1]?.searchParams.get('owner_id')).toBe('eq.other');
  expect(urls[2]?.searchParams.get('conversations.owner_id')).toBe('eq.other');
  expect(urls[2]?.searchParams.get('conversation_id')).toBe('eq.123');
  expect(urls[2]?.searchParams.get('client_id')).toBe('eq.turn');
});
