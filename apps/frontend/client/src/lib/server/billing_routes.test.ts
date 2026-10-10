import { expect, test } from 'bun:test';
import { POST as checkout } from '../../routes/api/billing/checkout/+server.ts';
import { POST as webhook } from '../../routes/api/webhooks/stripe/+server.ts';

const invokeWebhook = (request: Request) =>
  webhook({ request, locals: { container: { env: {} } } } as unknown as Parameters<
    typeof webhook
  >[0]);

test('oversized declared webhook length is rejected before reading', async () => {
  const request = new Request('https://app.test/webhook', {
    method: 'POST',
    body: 'small',
    headers: { 'content-length': String(256 * 1024 + 1) },
  });
  const response = await invokeWebhook(request);
  expect(response.status).toBe(413);
  expect(request.bodyUsed).toBe(false);
  expect(await response.json()).toMatchObject({
    error: 'payload_too_large',
    message: expect.any(String),
  });
});

test('webhook streaming counts UTF-8 bytes and cancels oversized input', async () => {
  let cancelled = false;
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks += 1;
      controller.enqueue(new TextEncoder().encode('é'.repeat(64 * 1024)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await invokeWebhook(
    new Request('https://app.test/webhook', {
      method: 'POST',
      body,
      headers: { 'content-length': '1' },
      ...{ duplex: 'half' },
    }),
  );
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(chunks).toBeLessThanOrEqual(4);
});

test('checkout resolves price IDs, keeps the lookup key and hides transport errors', async () => {
  let failure: 'none' | 'list' | 'session' | 'missing' = 'none';
  const postedPrices: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/v1/prices') {
        expect(url.searchParams.get('active')).toBe('true');
        expect(url.searchParams.get('lookup_keys[]')).toBe('team_month');
        if (failure === 'list') {
          return new Response('private Stripe detail', { status: 500 });
        }
        return Response.json({
          data:
            failure === 'missing'
              ? []
              : [{ id: 'price_real_id', active: true, lookup_key: 'team_month' }],
        });
      }
      postedPrices.push(new URLSearchParams(await request.text()).get('line_items[0][price]'));
      if (failure === 'session') {
        return new Response('private Stripe detail', { status: 500 });
      }
      return Response.json({ id: 'cs_current', url: 'https://checkout.test/current' });
    },
  });
  try {
    const invoke = () =>
      checkout({
        request: new Request('https://app.test/api/billing/checkout', {
          method: 'POST',
          body: JSON.stringify({ kind: 'subscription', planId: 'team', interval: 'month' }),
        }),
        locals: {
          user: { id: 'user', emailVerified: true },
          container: {
            baseUrl: 'https://app.test',
            env: { STRIPE_API_BASE: server.url.origin, STRIPE_SECRET_KEY: 'fixture' },
          },
        },
      } as unknown as Parameters<typeof checkout>[0]);
    const created = await invoke();
    expect(created.status).toBe(201);
    expect(postedPrices).toEqual(['price_real_id']);
    expect(await created.json()).toMatchObject({
      sessionId: 'cs_current',
      lookupKey: 'team_month',
    });
    for (const mode of ['list', 'session'] as const) {
      failure = mode;
      const response = await invoke();
      expect(response.status).toBe(502);
      expect((await response.json()) as { error: string; message: string }).toEqual({
        error: 'checkout_unavailable',
        message: 'Unable to start checkout. Please try again.',
      });
    }
    failure = 'missing';
    expect((await invoke()).status).toBe(422);
  } finally {
    await server.stop(true);
  }
});
