import type { SupabasePublicConfig } from '@starter/database/supabase';
import { type CookieMethodsServer, createServerClient } from '@supabase/ssr';

export interface VerifiedIdentity {
  backend: 'supabase';
  user: {
    id: string;
    email: string;
    displayName: string;
    emailVerified: boolean;
  };
  /** Server-only credential used to construct the user's RLS-scoped database client. */
  accessToken: string;
}

export type RequestCookies = CookieMethodsServer;
export type SupabaseIdentityConfig = SupabasePublicConfig;

export type SupabaseFetch = (
  input: Request | URL | string,
  init?: RequestInit,
) => Promise<Response>;

export interface SupabaseIdentityResolver {
  getVerifiedIdentity(request: Request, cookies: RequestCookies): Promise<VerifiedIdentity | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const displayNameFor = (metadata: Record<string, unknown> | undefined, email: string): string => {
  if (typeof metadata?.display_name === 'string') {
    return metadata.display_name;
  }
  if (typeof metadata?.name === 'string') {
    return metadata.name;
  }
  return email;
};

/** Construct a request-local SSR client and verify its user with Supabase Auth. */
export const createSupabaseIdentityResolver = (
  config: SupabaseIdentityConfig,
  fetcher: SupabaseFetch = fetch,
): SupabaseIdentityResolver => {
  if (!config.url.trim() || !config.anonKey.trim()) {
    throw new Error('Supabase preview requires SUPABASE_URL and SUPABASE_ANON_KEY.');
  }

  return {
    async getVerifiedIdentity(request, cookies) {
      const client = createServerClient(config.url, config.anonKey, {
        cookies,
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        global: { fetch: fetcher as typeof fetch },
      });
      const authorization = request.headers.get('authorization');
      const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      const { data, error } = bearer
        ? await client.auth.getUser(bearer)
        : await client.auth.getUser();
      if (error) {
        if (error.status !== undefined && error.status >= 400 && error.status < 500) {
          return null;
        }
        throw error;
      }
      if (!data.user) {
        return null;
      }
      const { data: sessionData } = bearer
        ? { data: { session: null } }
        : await client.auth.getSession();
      const accessToken = bearer ?? sessionData.session?.access_token;
      const id = data.user.id;
      const email = data.user.email;
      if (!UUID.test(id) || !email || !accessToken) {
        return null;
      }
      return {
        backend: 'supabase',
        accessToken,
        user: {
          id,
          email,
          displayName: displayNameFor(data.user.user_metadata, email),
          emailVerified: typeof data.user.email_confirmed_at === 'string',
        },
      };
    },
  };
};
