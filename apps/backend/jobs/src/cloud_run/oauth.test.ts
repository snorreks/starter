import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { createGoogleOAuthProvider } from './oauth.ts';

describe('Google OAuth provider', () => {
  it('uses workerd-compatible manual redirects and refuses a redirect response', async () => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let calls = 0;
    const token = createGoogleOAuthProvider({
      secret: JSON.stringify({
        client_email: 'dispatcher@project.iam.gserviceaccount.com',
        private_key: key.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      }),
      fetcher: async (_input, init) => {
        calls += 1;
        expect(init?.redirect).toBe('manual');
        return new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example' },
        });
      },
    });
    await expect(token()).rejects.toThrow('exchange failed (302)');
    expect(calls).toBe(1);
  });
  it('refuses malformed or non-Google key exchanges before making a request', async () => {
    const token = createGoogleOAuthProvider({
      secret: 'not-json',
      fetcher: async () => {
        throw new Error('must not fetch');
      },
    });
    await expect(token()).rejects.toThrow('service-account JSON key');
    const wrongHost = createGoogleOAuthProvider({
      secret: JSON.stringify({
        client_email: 'dispatcher@project.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
        token_uri: 'https://attacker.example/token',
      }),
      fetcher: async () => {
        throw new Error('must not fetch');
      },
    });
    await expect(wrongHost()).rejects.toThrow('token endpoint');
    const wrongPath = createGoogleOAuthProvider({
      secret: JSON.stringify({
        client_email: 'dispatcher@project.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----',
        token_uri: 'https://oauth2.googleapis.com/attacker',
      }),
      fetcher: async () => {
        throw new Error('must not fetch');
      },
    });
    await expect(wrongPath()).rejects.toThrow('token endpoint');
  });
});
