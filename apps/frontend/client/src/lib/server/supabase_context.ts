import type { SupabaseAccountService } from '@starter/auth/supabase';
import {
  createSupabaseAccountService,
  createSupabaseIdentityResolver,
  type VerifiedIdentity,
} from '@starter/auth/supabase';
import type { ChatRepository, JobRepository, NotesRepository } from '@starter/database/supabase';
import {
  createAdminDatabaseClient,
  createSupabaseChatRepository,
  createSupabaseJobRepository,
  createSupabaseNotesRepository,
  createUserDatabaseClient,
  type SupabaseAdminConfig,
} from '@starter/database/supabase';
import type { CookieMethodsServer } from '@supabase/ssr';
import { createServerClient } from '@supabase/ssr';
import type { Cookies } from '@sveltejs/kit';

export interface SupabaseWebConfig extends SupabaseAdminConfig {
  origin: string;
  allowedCallbacks: readonly string[];
  mailUrl?: string;
}

export interface ApplicationServices {
  identity: VerifiedIdentity;
  notes: NotesRepository;
  chat: ChatRepository;
  jobs: JobRepository & { dispatch: 'disabled_pending_prompt_06' };
  account: SupabaseAccountService;
}

/** One service graph for one verified caller. The admin client is never exposed to browser code. */
export const createApplicationServices = (
  identity: VerifiedIdentity,
  config: SupabaseWebConfig,
): ApplicationServices => {
  if (identity.backend !== 'supabase' || !identity.accessToken) {
    throw new Error('Refusing to compose Supabase services from a different backend identity.');
  }
  const userClient = createUserDatabaseClient(config, identity.accessToken);
  const adminClient = createAdminDatabaseClient(config);
  return {
    identity,
    notes: createSupabaseNotesRepository(userClient),
    chat: createSupabaseChatRepository(userClient, adminClient),
    jobs: Object.assign(createSupabaseJobRepository(userClient, adminClient), {
      dispatch: 'disabled_pending_prompt_06' as const,
    }),
    account: createSupabaseAccountService(userClient, adminClient, config),
  };
};

export const createSupabaseAuthClient = (config: SupabaseWebConfig, cookies: CookieMethodsServer) =>
  createServerClient(config.url, config.anonKey, {
    cookies,
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

export interface SupabaseRequestContext {
  identity: VerifiedIdentity | null;
  services: ApplicationServices | null;
  responseHeaders: Headers;
}

/** Build a request-local SSR resolver and capture cookie/cache writes for this response. */
export const createSupabaseRequestContext = async (
  request: Request,
  cookies: Cookies,
  config: SupabaseWebConfig,
): Promise<SupabaseRequestContext> => {
  const responseHeaders = new Headers();
  const resolver = createSupabaseIdentityResolver(config);
  const cookieAdapter: CookieMethodsServer = {
    getAll: () => cookies.getAll().map(({ name, value }) => ({ name, value })),
    setAll: (writes, headers) => {
      for (const { name, value, options } of writes) {
        cookies.set(name, value, { ...options, path: options.path ?? '/' });
      }
      for (const [name, value] of Object.entries(headers)) {
        responseHeaders.set(name, value);
      }
    },
  };
  const identity = await resolver.getVerifiedIdentity(request, cookieAdapter);
  return {
    identity,
    services: identity === null ? null : createApplicationServices(identity, config),
    responseHeaders,
  };
};

export const applySupabaseResponseHeaders = (response: Response, headers: Headers): Response => {
  if ([...headers].length === 0) {
    return response;
  }
  const combined = new Headers(response.headers);
  headers.forEach((value, name) => {
    combined.set(name, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: combined,
  });
};
