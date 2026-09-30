// apps/frontend/client/src/lib/services/api_client.ts
//
// The single HTTP seam between the client and the API.
//
// Hand-written rather than generated, deliberately: it is ~150 lines, it has no
// code-generation step to keep in sync, and it derives its types from the same
// `@starter/schemas` TypeBox definitions the server validates against. A
// generated client would add a build artifact and a version coupling to save
// less code than the indirection costs.
//
// Everything the client needs to know about the network lives here:
//   - base URL resolution
//   - credentials (cookie in a browser, bearer token in a Tauri webview)
//   - a uniform error shape (`AppError`), so no screen parses a status code
//   - one place to log, bound to a request id for correlation

import { BaseClass } from '@starter/utils';
import { AppError, errorTypeForStatus } from '@starter/utils';
import type { ApiError, SessionUser } from '@starter/schemas/auth';
import { clientConfig } from '#lib/runtime/config.ts';

export type ApiRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Correlates this call with a log event. */
  traceId?: string;
};

type TokenProvider = () => string | undefined;

let tokenProvider: TokenProvider = () => undefined;

/**
 * Install the bearer-token source.
 *
 * A Tauri webview's origin is `tauri://localhost`, so the API is a different
 * *site* and the session cookie is never attached. The native client therefore
 * presents the session token as a bearer token instead. A browser never calls
 * this, and keeps using the cookie.
 */
export const setApiTokenProvider = (provider: TokenProvider): void => {
  tokenProvider = provider;
};

const buildHeaders = (options: ApiRequestOptions): Headers => {
  const headers = new Headers({ accept: 'application/json' });

  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  if (options.traceId !== undefined) {
    headers.set('x-trace-id', options.traceId);
  }

  const token = tokenProvider();
  if (token !== undefined && token.length > 0) {
    headers.set('authorization', `Bearer ${token}`);
  }

  return headers;
};

const parseBody = async (response: Response): Promise<unknown> => {
  if (response.status === 204) {
    return undefined;
  }

  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('server', 'The server returned a response that was not JSON.', {
      status: response.status,
    });
  }
};

/**
 * The part of `fetch` this client actually uses.
 *
 * Narrower than `typeof fetch` on purpose. Bun adds `fetch.preconnect`, so
 * `typeof fetch` means something different in the Bun unit lane than in a
 * browser, and a fake built to satisfy it would need a cast to be correct.
 * Naming the requirement instead makes the fake's shape exact.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ApiClient extends BaseClass {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(
    options: { baseUrl?: string; className?: string; fetch?: FetchLike } = {},
  ) {
    super({ className: options.className ?? 'ApiClient' });
    this.#baseUrl = options.baseUrl ?? clientConfig.apiBaseUrl;
    // Defaults to the global at call time rather than at construction, so a test
    // that replaces `globalThis.fetch` before constructing still gets its fake.
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /**
   * Perform a request and return the parsed body.
   *
   * Every non-2xx becomes an `AppError` with a classified `errorType`, so a
   * ViewModel can decide "recoverable, offer retry" vs "not recoverable" from
   * data rather than from a status-code switch at each call site.
   */
  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const { method = 'GET', body, signal, traceId } = options;
    const url = `${this.#baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

    this.debug('request', method, path);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: buildHeaders({ body, traceId }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // Browser: the session cookie. Tauri: ignored, and the bearer token
        // above is what authenticates instead.
        credentials: 'include',
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      // A dead network and a cancelled request both land here; the AbortError
      // branch is what keeps a cancellation from being reported as an outage.
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new AppError('aborted', 'The request was cancelled.', { cause: error });
      }
      throw new AppError('network', 'Could not reach the server.', { cause: error });
    }

    const parsed = await parseBody(response);

    if (!response.ok) {
      const errorPayload = parsed as Partial<ApiError> | undefined;
      throw new AppError(errorTypeForStatus(response.status), errorPayload?.message ?? 'The request failed.', {
        status: response.status,
        cause: parsed,
      });
    }

    return parsed as T;
  }

  get<T>(path: string, options: Omit<ApiRequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body: unknown, options: Omit<ApiRequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  patch<T>(path: string, body: unknown, options: Omit<ApiRequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  delete<T>(path: string, options: Omit<ApiRequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  getSession(signal?: AbortSignal): Promise<{ user: SessionUser | null } | null> {
    return this.get<{ user: SessionUser | null } | null>('/api/auth/get-session', { signal });
  }

  async signIn(email: string, password: string): Promise<SessionUser> {
    const result = await this.post<{ user: SessionUser; token?: string }>('/api/auth/sign-in/email', {
      email,
      password,
      returnHeaders: true,
    });
    return result.user;
  }

  async signUp(input: { email: string; password: string; name: string }): Promise<SessionUser> {
    const result = await this.post<{ user: SessionUser; token?: string }>('/api/auth/sign-up/email', {
      email: input.email,
      password: input.password,
      name: input.name,
    });
    return result.user;
  }

  async signOut(): Promise<void> {
    await this.post('/api/auth/sign-out', {});
  }
}

export const apiClient = ApiClient.create({ className: 'ApiClient' });
