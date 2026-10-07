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
});
