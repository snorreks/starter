import { createSupabaseAccountService } from '@starter/auth/supabase';
import { createAdminDatabaseClient } from '@starter/database/supabase';
import { AppError, errorTypeForStatus } from '@starter/utils';
import type { Cookies } from '@sveltejs/kit';
import type { Container } from './container.ts';
import { createSupabaseAuthClient } from './supabase_context.ts';

export type AuthActionPath =
  | 'sign-in/email'
  | 'sign-up/email'
  | 'send-verification-email'
  | 'request-password-reset'
  | 'reset-password';

export const submitAuthAction = async (
  container: Container,
  _request: Request,
  cookies: Cookies,
  path: AuthActionPath,
  body: Record<string, string>,
  responseHeaders: Headers | null = null,
): Promise<number> => {
  let applied = 0;
  const config = {
    ...container.supabase,
    origin: container.baseUrl,
    allowedCallbacks: ['/verify-email', '/reset-password'],
  };
  const client = createSupabaseAuthClient(config, {
    getAll: () => cookies.getAll().map(({ name, value }) => ({ name, value })),
    setAll: (writes, headers) => {
      for (const [name, value] of Object.entries(headers)) {
        responseHeaders?.set(name, value);
      }
      for (const { name, value, options } of writes) {
        cookies.set(name, value, { ...options, path: options.path ?? '/' });
        applied += 1;
      }
    },
  });
  const account = createSupabaseAccountService(
    client,
    createAdminDatabaseClient(container.supabase),
    config,
  );
  try {
    switch (path) {
      case 'sign-in/email':
        await account.signIn({ email: body.email ?? '', password: body.password ?? '' });
        break;
      case 'sign-up/email':
        await account.signUp({
          email: body.email ?? '',
          password: body.password ?? '',
          name: body.name ?? '',
        });
        break;
      case 'send-verification-email':
        await account.sendVerificationEmail({ email: body.email ?? '' });
        break;
      case 'request-password-reset':
        await account.requestPasswordReset({
          email: body.email ?? '',
          redirectTo: '/reset-password',
        });
        break;
      case 'reset-password':
        await account.resetPassword({ newPassword: body.newPassword ?? '' });
        break;
    }
    return applied;
  } catch (error) {
    const status =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof error.status === 'number'
        ? error.status
        : 400;
    throw new AppError(errorTypeForStatus(status), 'Could not complete that request.', {
      status,
      cause: error,
    });
  }
};
