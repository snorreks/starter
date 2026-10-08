import { redirect } from '@sveltejs/kit';
import { createSupabaseAuthClient } from '#lib/server/supabase_context.ts';
import type { RequestHandler } from './$types';

const CALLBACKS = new Set(['/verify-email', '/reset-password']);

export const GET: RequestHandler = async ({ url, locals, cookies }) => {
  const config = locals.container.supabase;
  if (config === null) {
    redirect(303, '/login?error=auth_unconfigured');
  }
  const requested = url.searchParams.get('next') ?? '';
  if (!CALLBACKS.has(requested)) {
    redirect(303, '/login?error=invalid_callback');
  }
  const client = createSupabaseAuthClient(
    { ...config, origin: url.origin, allowedCallbacks: [...CALLBACKS] },
    {
      getAll: () => cookies.getAll().map(({ name, value }) => ({ name, value })),
      setAll: (writes, headers) => {
        for (const [name, value] of Object.entries(headers)) {
          locals.context.responseHeaders?.set(name, value);
        }
        for (const { name, value, options } of writes) {
          cookies.set(name, value, { ...options, path: options.path ?? '/' });
        }
      },
    },
  );
  const code = url.searchParams.get('code');
  if (!code) {
    redirect(303, '/login?error=invalid_callback');
  }
  const { error } = await client.auth.exchangeCodeForSession(code);
  if (error) {
    redirect(303, '/login?error=invalid_callback');
  }
  redirect(303, requested);
};
