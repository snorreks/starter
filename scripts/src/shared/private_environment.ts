const PRIVATE_KEYS = new Set([
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_EMAIL',
  'GITHUB_TOKEN',
  'BETTER_AUTH_SECRET',
  'RESEND_API_KEY',
  'SOPS_AGE_KEY',
  'SOPS_AGE_KEY_FILE',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_OWNER_TOKEN',
  'OPENROUTER_API_KEY',
  'E2E_VISION_API_KEY',
  'STARTER_WORKTREE_ENV_SOURCE',
]);

/** Environment for builds and generic tooling processes that need no credentials. */
export const publicToolEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !PRIVATE_KEYS.has(key)));
