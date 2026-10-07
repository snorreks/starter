import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export interface RunnerIdentityConfig {
  audience: string;
  serviceAccount: string;
  subject?: string;
}

export const verifyRunnerIdentity = async (
  token: string,
  config: RunnerIdentityConfig,
  now?: Date,
  keySet: JWTVerifyGetKey = GOOGLE_KEYS,
) => {
  const { payload } = await jwtVerify(token, keySet, {
    issuer: GOOGLE_ISSUERS,
    audience: config.audience,
    clockTolerance: 5,
    currentDate: now,
  });
  const email = payload.email;
  const subject = config.subject ?? config.serviceAccount;
  if (
    typeof email !== 'string' ||
    email !== config.serviceAccount ||
    payload.sub !== subject ||
    payload.email_verified !== true
  ) {
    throw new Error('Runner identity does not match the configured Cloud Run service account.');
  }
  return { subject: payload.sub, email };
};
