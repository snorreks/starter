import { describe, expect, test } from 'bun:test';
import { readSupabaseCapturedMail } from './supabase_mail.ts';

describe('local Supabase mail capture', () => {
  test('reads only the requested recipient and loads the full link body', async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/messages?')) {
        return Response.json({
          messages: [
            {
              ID: 'one',
              To: [{ Address: 'A@EXAMPLE.test' }],
              Subject: 'Verify',
              Created: '2026-10-07T00:00:00Z',
            },
            { ID: 'two', To: [{ Address: 'b@example.test' }], Subject: 'Other' },
          ],
        });
      }
      if (url.endsWith('.txt')) {
        return new Response('https://app.example.test/auth/callback?code=secret');
      }
      if (url.endsWith('.html')) {
        return new Response(
          '<a href="https://app.example.test/auth/callback?code=secret">Verify</a>',
        );
      }
      return Response.json({});
    }) as typeof fetch;
    const messages = await readSupabaseCapturedMail(
      'http://127.0.0.1:54324',
      'a@Example.TEST',
      fetcher,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain('/auth/callback?code=secret');
    expect(calls).toHaveLength(4);
  });

  test('exposes Supabase confirmation links from Mailpit HTML-only bodies', async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/messages?')) {
        return Response.json({
          messages: [
            { ID: 'html', To: [{ Address: 'A@EXAMPLE.test' }], Subject: 'Confirm your signup' },
          ],
        });
      }
      if (url.endsWith('.txt')) {
        return new Response('');
      }
      if (url.endsWith('.html')) {
        return new Response(
          '<a href="http://app.example.test/auth/callback?code=abc&amp;next=%2Fverify-email">Confirm</a>',
        );
      }
      return Response.json({});
    }) as typeof fetch;
    const messages = await readSupabaseCapturedMail(
      'http://127.0.0.1:54324',
      'a@Example.TEST',
      fetcher,
    );
    expect(messages[0]?.text).toContain(
      'http://app.example.test/auth/callback?code=abc&next=%2Fverify-email',
    );
  });
});
