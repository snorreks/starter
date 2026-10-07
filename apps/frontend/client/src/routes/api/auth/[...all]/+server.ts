import { createSupabaseAccountService } from '@starter/auth/supabase';
import { createAdminDatabaseClient } from '@starter/database/supabase';
import { SignInInputSchema, SignUpInputSchema } from '@starter/schemas/auth';
import { checkSchema } from '@starter/schemas/common';
import { errorTypeForStatus } from '@starter/utils';
import { json, jsonError } from '#lib/server/http.ts';
import { createSupabaseAuthClient } from '#lib/server/supabase_context.ts';
import type { RequestHandler } from './$types';

const USER_IDENTITY = (user: {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
}) => ({
  id: user.id,
  name: user.displayName,
  email: user.email,
  emailVerified: user.emailVerified,
  image: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const readObject = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const value: unknown = await request.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const failure = (error: unknown): Response => {
  const status =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
      ? error.status
      : 400;
  const type = errorTypeForStatus(status);
  return jsonError(status, type, 'Could not complete that request.');
};

const handleSupabase = async (event: Parameters<RequestHandler>[0]): Promise<Response> => {
  const config = event.locals.container.supabase;
  if (!config) {
    return jsonError(503, 'auth_unconfigured', 'Supabase Auth is not configured.');
  }
  const cookieWrites: { name: string; value: string; options: Record<string, unknown> }[] = [];
  const responseHeaders = new Headers();
  const client = createSupabaseAuthClient(
    { ...config, origin: event.url.origin, allowedCallbacks: ['/verify-email', '/reset-password'] },
    {
      getAll: () => event.cookies.getAll().map(({ name, value }) => ({ name, value })),
      setAll: (writes, headers) => {
        cookieWrites.push(...writes);
        for (const [name, value] of Object.entries(headers)) {
          responseHeaders.set(name, value);
        }
      },
    },
  );
  const admin = createAdminDatabaseClient(config);
  const accounts = createSupabaseAccountService(client, admin, {
    origin: event.url.origin,
    allowedCallbacks: ['/verify-email', '/reset-password'],
  });
  const endpoint = event.url.pathname.replace(/^\/api\/auth\//, '');
  const body = event.request.method === 'GET' ? {} : await readObject(event.request);
  if (body === null) {
    return jsonError(400, 'validation', 'A JSON object is required.');
  }

  try {
    let result: unknown;
    if (event.request.method === 'GET' && endpoint === 'get-session') {
      result = { user: event.locals.user ? USER_IDENTITY(event.locals.user) : null };
    } else if (event.request.method === 'POST' && endpoint === 'sign-up/email') {
      const input = { email: body.email, password: body.password, displayName: body.name };
      if (!checkSchema(SignUpInputSchema, input)) {
        return jsonError(422, 'validation', 'The sign-up details are invalid.');
      }
      const user = await accounts.signUp({
        email: String(input.email),
        password: String(input.password),
        name: String(input.displayName),
      });
      result = { user: USER_IDENTITY(user), session: null };
    } else if (event.request.method === 'POST' && endpoint === 'sign-in/email') {
      const input = { email: body.email, password: body.password };
      if (!checkSchema(SignInInputSchema, input)) {
        return jsonError(422, 'validation', 'The sign-in details are invalid.');
      }
      const user = await accounts.signIn({
        email: String(input.email),
        password: String(input.password),
      });
      result = { user: USER_IDENTITY(user) };
    } else if (event.request.method === 'POST' && endpoint === 'sign-out') {
      await accounts.signOut();
      result = { success: true };
    } else if (event.request.method === 'POST' && endpoint === 'request-password-reset') {
      if (typeof body.email === 'string') {
        await accounts.requestPasswordReset({ email: body.email, redirectTo: '/reset-password' });
      }
      result = { success: true };
    } else if (event.request.method === 'POST' && endpoint === 'send-verification-email') {
      if (typeof body.email === 'string') {
        await accounts.sendVerificationEmail({ email: body.email });
      }
      result = { success: true };
    } else if (event.request.method === 'POST' && endpoint === 'reset-password') {
      if (
        typeof body.newPassword !== 'string' ||
        body.newPassword.length < 8 ||
        body.newPassword.length > 128
      ) {
        return jsonError(422, 'validation', 'The password is invalid.');
      }
      await accounts.resetPassword({ newPassword: body.newPassword });
      result = { success: true };
    } else if (event.request.method === 'POST' && endpoint === 'account/delete') {
      if (!event.locals.supabaseIdentity) {
        return jsonError(401, 'unauthorized', 'Sign in to continue.');
      }
      await accounts.deleteAccount(event.locals.supabaseIdentity);
      result = { success: true };
    } else if (event.request.method === 'POST' && endpoint === 'account/email-change') {
      if (!event.locals.supabaseIdentity || typeof body.email !== 'string') {
        return jsonError(401, 'unauthorized', 'Sign in to continue.');
      }
      await accounts.changeEmail({ email: body.email });
      result = { success: true };
    } else {
      return jsonError(404, 'not_found', 'No such authentication operation.');
    }
    for (const item of cookieWrites) {
      event.cookies.set(item.name, item.value, {
        ...(item.options as object),
        path: typeof item.options.path === 'string' ? item.options.path : '/',
      });
    }
    const response = json(200, result);
    responseHeaders.forEach((value, name) => {
      response.headers.set(name, value);
    });
    return response;
  } catch (error) {
    for (const item of cookieWrites) {
      event.cookies.set(item.name, item.value, {
        ...(item.options as object),
        path: typeof item.options.path === 'string' ? item.options.path : '/',
      });
    }
    return failure(error);
  }
};

const handle: RequestHandler = async ({ request, locals, ...event }) => {
  if (locals.container.backendProfile === 'supabase') {
    return await handleSupabase({ request, locals, ...event } as Parameters<RequestHandler>[0]);
  }
  try {
    return await locals.container.auth.handler(request);
  } catch (error) {
    locals.context.logger.error('auth.handler_failed', {
      component: 'auth',
      message: error instanceof Error ? error.message : String(error),
    });
    return jsonError(503, 'auth_unconfigured', 'Authentication is not configured.');
  }
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
