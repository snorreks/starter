const CREDENTIAL_KEYS = new Set([
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_EMAIL',
  'BETTER_AUTH_SECRET',
  'RESEND_API_KEY',
  'SOPS_AGE_KEY',
  'SOPS_AGE_KEY_FILE',
]);

/** Build tools receive public inputs and PATH, never deploy/runtime credentials. */
export const buildEnvironment = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !CREDENTIAL_KEYS.has(key)));
