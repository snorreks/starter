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
    { ...config, origin: locals.container.baseUrl, allowedCallbacks: [...CALLBACKS] },
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
  const invalidDestination =
    requested === '/reset-password' ? '/reset-password?invalid=1' : '/login?error=invalid_callback';
  if (requested === '/reset-password') {
    cookies.delete('starter-recovery-user', { path: '/reset-password' });
  }
  const code = url.searchParams.get('code');
  if (!code) {
    redirect(303, invalidDestination);
  }
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error) {
    redirect(303, invalidDestination);
  }
  if (requested === '/reset-password' && data.user) {
    // The form requires both a verified session and this short-lived callback
    // marker. A query token alone must never make a reset form usable.
    cookies.set('starter-recovery-user', data.user.id, {
      path: '/reset-password',
      httpOnly: true,
      sameSite: 'lax',
      secure: new URL(locals.container.baseUrl).protocol === 'https:',
      maxAge: 600,
    });
  }
  redirect(303, requested);
};
