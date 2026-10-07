import { describe, expect, it } from 'bun:test';
import { createGoogleOAuthProvider } from './oauth.ts';

describe('Google OAuth provider', () => {
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
