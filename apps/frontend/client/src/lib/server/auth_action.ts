import { AppError, errorTypeForStatus } from '@starter/utils';
import type { Cookies } from '@sveltejs/kit';
import type { Container } from './container.ts';
import { applySetCookies } from './response_cookies.ts';

/** Run a form submission through Better Auth's origin checks and D1 limiter. */
export const submitAuthAction = async (
  container: Container,
  request: Request,
  cookies: Cookies,
  path: string,
  body: Record<string, string>,
): Promise<number> => {
  // Preserve the incoming origin, cookies and ingress IP headers. Only the body
  // encoding changes from the browser's form to Better Auth's JSON endpoint.
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  const response = await container.auth.handler(
    new Request(new URL(`/api/auth/${path}`, container.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
  const applied = applySetCookies(cookies, response.headers);
  if (!response.ok) {
    const cause: unknown = await response.json().catch(() => undefined);
    throw new AppError(errorTypeForStatus(response.status), 'Could not complete that request.', {
      status: response.status,
      cause,
    });
  }
  return applied;
};
