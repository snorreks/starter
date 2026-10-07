import { describe, expect, it } from 'bun:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyRunnerIdentity } from './runner_identity.ts';

describe('Cloud Run runner identity', () => {
  it('rejects malformed tokens and wrong audience before grants can be issued', async () => {
    await expect(
      verifyRunnerIdentity('not-a-jwt', {
        audience: 'https://app.example',
        serviceAccount: 'runner@project.iam.gserviceaccount.com',
      }),
    ).rejects.toThrow();
  });

  it('rejects a cryptographically valid token with the wrong audience or service-account subject', async () => {
    const pair = await generateKeyPair('RS256');
    const jwk = await exportJWK(pair.publicKey);
    const keys = createLocalJWKSet({
      keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }],
    });
    const config = {
      audience: 'https://app.example',
      serviceAccount: 'runner@project.iam.gserviceaccount.com',
      subject: '1234567890',
    };
    const wrongAudience = await new SignJWT({ email: config.serviceAccount, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://accounts.google.com')
      .setSubject(config.subject)
      .setAudience('https://other.example')
      .setExpirationTime('5m')
      .sign(pair.privateKey);
    await expect(verifyRunnerIdentity(wrongAudience, config, undefined, keys)).rejects.toThrow();
    const wrongSubject = await new SignJWT({ email: config.serviceAccount, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://accounts.google.com')
      .setSubject('9999999999')
      .setAudience(config.audience)
      .setExpirationTime('5m')
      .sign(pair.privateKey);
    await expect(verifyRunnerIdentity(wrongSubject, config, undefined, keys)).rejects.toThrow(
      'service account',
    );
  });
});
