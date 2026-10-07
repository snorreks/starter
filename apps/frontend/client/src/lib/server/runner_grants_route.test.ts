import { expect, test } from 'bun:test';
import { DELETE, GET, PATCH, POST } from '../../routes/api/internal/jobs/[id]/grants/+server.ts';

const invoke = (request: Request) =>
  POST({
    request,
    params: { id: 'job_a' },
    platform: { STARTER_BACKEND_PROFILE: 'supabase' },
    url: new URL(request.url),
  } as unknown as Parameters<typeof POST>[0]);

test('grant bodies are bounded during streaming before runner authentication', async () => {
  let cancelled = false;
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks += 1;
      controller.enqueue(new Uint8Array(2048).fill(32));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await invoke(
    new Request('https://app.example/grants', {
      method: 'POST',
      body,
      ...{ duplex: 'half' },
    }),
  );
  expect(response.status).toBe(413);
  expect((await response.json()) as { error: string; message: string }).toEqual({
    error: 'payload_too_large',
    message: expect.any(String),
  });
  expect(cancelled).toBe(true);
  expect(chunks).toBeLessThanOrEqual(4);
});

test('malformed grant bodies and unsupported methods use the shared error shape', async () => {
  for (const body of ['{', JSON.stringify({ attemptId: 'a', executionName: 'e', extra: true })]) {
    const response = await invoke(
      new Request('https://app.example/grants', { method: 'POST', body }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string; message: string }).toMatchObject({
      error: expect.any(String),
      message: expect.any(String),
    });
  }
  for (const handler of [DELETE, PATCH]) {
    const response = handler();
    expect(response.status).toBe(405);
    expect((await response.json()) as { error: string; message: string }).toEqual({
      error: 'method_not_allowed',
      message: expect.any(String),
    });
  }
  const disabled = await GET({ platform: {} } as unknown as Parameters<typeof GET>[0]);
  expect(disabled.status).toBe(503);
  expect(await disabled.json()).toMatchObject({
    error: 'runner_grants_disabled',
    message: expect.any(String),
  });
});
