import { importPKCS8, SignJWT } from 'jose';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLOUD_RUN_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export interface GoogleServiceAccountSecret {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Exchanges an injected dispatcher key for a short-lived OAuth token. Never log or persist the key/assertion. */
export const createGoogleOAuthProvider = (options: {
  secret: string;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  deadlineMs?: number;
}) => {
  const fetcher = options.fetcher ?? fetch;
  return async (): Promise<string> => {
    let account: GoogleServiceAccountSecret;
    try {
      account = JSON.parse(options.secret) as GoogleServiceAccountSecret;
    } catch {
      throw new Error('GOOGLE_DISPATCHER_CREDENTIAL must contain a service-account JSON key.');
    }
    if (
      !account.client_email?.endsWith('.iam.gserviceaccount.com') ||
      !account.private_key?.includes('PRIVATE KEY')
    ) {
      throw new Error('GOOGLE_DISPATCHER_CREDENTIAL is not a valid dispatcher service account.');
    }
    const endpoint = account.token_uri ?? TOKEN_URL;
    const url = new URL(endpoint);
    if (url.href !== TOKEN_URL) {
      throw new Error('Google OAuth token endpoint must be https://oauth2.googleapis.com/token.');
    }
    const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
    const key = await importPKCS8(account.private_key, 'RS256');
    const assertion = await new SignJWT({ scope: CLOUD_RUN_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(account.client_email)
      .setSubject(account.client_email)
      .setAudience(url.href)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.deadlineMs ?? 8_000);
    try {
      const response = await fetcher(url, {
        method: 'POST',
        // workerd supports manual, not error; non-2xx (including redirects) is refused below.
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
      });
      if (!response.ok) {
        throw new Error(`Google OAuth token exchange failed (${response.status}).`);
      }
      const body: unknown = await response.json();
      const token = (body as { access_token?: unknown }).access_token;
      if (typeof token !== 'string' || token.length < 20) {
        throw new Error('Google OAuth returned no access token.');
      }
      return token;
    } finally {
      clearTimeout(timer);
    }
  };
};
