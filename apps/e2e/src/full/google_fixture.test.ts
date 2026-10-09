import { expect, test } from 'bun:test';
import { createPrivateKey, sign } from 'node:crypto';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { startGoogleFixture } from './google_fixture.ts';

test('the hosted Google boundary rejects forged OAuth and unknown or invalid executions', async () => {
  const fixture = await startGoogleFixture({
    appOrigin: 'http://127.0.0.1:4183',
    runId: 'google_boundary_test',
  });
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'provider-boundary',
          modules: true,
          script: `export default { async fetch(request) {
      const {url, ...init} = await request.json();
      return fetch(url, {...init, redirect: 'manual'});
    }};`,
          compatibilityDate: '2026-10-01',
          outboundService: fixture.outbound,
        },
      ],
    }),
  );
  const call = (
    url: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ) =>
    worker.ready.then((origin) =>
      fetch(origin, {
        method: 'POST',
        body: JSON.stringify({ url, ...init }),
      }),
    );
  try {
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const forged = await call(tokenUrl, { method: 'POST', body: 'assertion=forged' });
    expect(forged.status).toBe(401);
    const credentials = JSON.parse(fixture.bindings.GOOGLE_DISPATCHER_CREDENTIAL) as {
      client_email: string;
      private_key: string;
    };
    const input = [
      { alg: 'RS256' },
      {
        iss: credentials.client_email,
        sub: credentials.client_email,
        aud: tokenUrl,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    ]
      .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
      .join('.');
    const assertion = `${input}.${sign('RSA-SHA256', Buffer.from(input), createPrivateKey(credentials.private_key)).toString('base64url')}`;
    const signature = Buffer.from(assertion.split('.')[2] ?? '', 'base64url');
    signature[0] = (signature[0] ?? 0) ^ 1;
    const tampered = await call(tokenUrl, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${input}.${signature.toString('base64url')}`,
      }).toString(),
    });
    expect(tampered.status).toBe(401);
    const accepted = await call(tokenUrl, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    expect(accepted.status).toBe(200);
    const token = (await accepted.json()) as { access_token: string };
    const base = 'https://run.googleapis.com/v2/projects/e2e-fixture/locations/local/jobs/runner';
    const headers = { authorization: `Bearer ${token.access_token}` };
    expect((await call(`${base}/executions`)).status).toBe(401);
    const list = await call(`${base}/executions`, { headers });
    expect(await list.json()).toEqual({ executions: [] });
    expect(
      (
        await call(`${base}:run`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            overrides: { containerOverrides: [{ args: ['../../escape', 'attempt_a'] }] },
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'https://run.googleapis.com/v2/projects/e2e-fixture/locations/local/operations/missing',
          { headers },
        )
      ).status,
    ).toBe(404);
    const keys = await call('https://www.googleapis.com/oauth2/v3/certs');
    expect(await keys.json()).toMatchObject({
      keys: [{ kty: 'RSA', kid: 'google_boundary_test', alg: 'RS256' }],
    });
  } finally {
    await worker.dispose();
    await fixture.dispose();
  }
});
