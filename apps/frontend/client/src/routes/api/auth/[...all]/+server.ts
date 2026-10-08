import { createSupabaseAccountService } from '@starter/auth/supabase';
import { createAdminDatabaseClient } from '@starter/database/supabase';
import { SignInInputSchema, SignUpInputSchema } from '@starter/schemas/auth';
import { checkSchema } from '@starter/schemas/common';
import { errorTypeForStatus } from '@starter/utils';
import * as v from 'valibot';
import { json, jsonError, readJsonBody } from '#lib/server/http.ts';
import {
  applySupabaseResponseHeaders,
  createSupabaseAuthClient,
} from '#lib/server/supabase_context.ts';
import type { RequestHandler } from './$types';

const USER_IDENTITY = (user: {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
}) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  provider: 'email' as const,
  emailVerified: user.emailVerified,
});

// Wire field names follow the account client; value validation uses the shared schemas below.
const BODY_FIELDS: Record<string, readonly string[]> = {
  'sign-up/email': ['email', 'password', 'name', 'callbackURL'],
  'sign-in/email': ['email', 'password', 'callbackURL', 'rememberMe'],
  'sign-out': [],
  'request-password-reset': ['email', 'redirectTo'],
  'send-verification-email': ['email', 'callbackURL'],
  'reset-password': ['newPassword', 'token'],
  'account/delete': [],
  'account/email-change': ['email'],
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
    {
      ...config,
      origin: event.locals.container.baseUrl,
      allowedCallbacks: ['/verify-email', '/reset-password'],
    },
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
    origin: event.locals.container.baseUrl,
    allowedCallbacks: ['/verify-email', '/reset-password'],
  });
  const endpoint = event.url.pathname.replace(/^\/api\/auth\//, '');
  let body: Record<string, unknown> = {};
  if (event.request.method !== 'GET') {
    const fields = Object.hasOwn(BODY_FIELDS, endpoint) ? (BODY_FIELDS[endpoint] ?? []) : [];
    const schema = v.pipe(
      v.unknown(),
      v.check((value) => typeof value === 'object' && value !== null && !Array.isArray(value)),
      v.strictObject(Object.fromEntries(fields.map((field) => [field, v.optional(v.unknown())]))),
    );
    const parsed = await readJsonBody(event.request, schema, {
      maxBytes: 16 * 1024,
      invalidStatus: 400,
    });
    if (!parsed.ok) {
      return parsed.response;
    }
    body = parsed.value;
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
      if (!event.locals.supabaseIdentity) {
        return jsonError(401, 'unauthorized', 'Sign in to continue.');
      }
      if (typeof body.email !== 'string') {
        return jsonError(422, 'validation', 'The email is invalid.');
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
    return applySupabaseResponseHeaders(json(200, result), responseHeaders);
  } catch (error) {
    for (const item of cookieWrites) {
      event.cookies.set(item.name, item.value, {
        ...(item.options as object),
        path: typeof item.options.path === 'string' ? item.options.path : '/',
      });
    }
    return applySupabaseResponseHeaders(failure(error), responseHeaders);
  }
};

const handle: RequestHandler = async (event) => {
  if (event.request.method !== 'GET' && event.request.method !== 'POST') {
    return jsonError(405, 'method_not_allowed', 'Use GET or POST.');
  }
  return handleSupabase(event);
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
