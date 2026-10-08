// packages/frontend/features/src/auth/auth_session_service.svelte.ts
//
// The signed-in user, as one source of truth for a client.
//
// A `$state` object rather than a service instance per screen: the session is
// genuinely global, it has one writer (this class) and many readers, and two
// screens disagreeing about who is signed in is a bug the user sees immediately.
//
// But the *instance* is not global. Whoever constructs it constructs it — the web
// app's composition root, a native shell's composition root, or a test — and this
// file exports no singleton. A module-scope `new SessionState()` here would be
// read by every server-rendered request in the same isolate and would answer
// "who is signed in" with whoever arrived first, which is the identity confusion
// that per-request identity exists to prevent.
//
// The endpoints are the provider's, not ours, so the paths are constants here for
// the same reason the verification callback is: they are part of one contract with
// the application auth API, and a screen that could choose paths could be pointed at a different
// one.

import { type ApiTransport, parseDto } from '@starter/platform';
import { type SessionUser, SessionUserWireSchema, toSessionUser } from '@starter/schemas/auth';

/** The signed-in user, plus whether a check has ever completed. */
export class SessionState {
  #user = $state<SessionUser | null>(null);
  #loaded = $state(false);
  #listeners = new Set<(user: SessionUser | null) => void>();

  get user(): SessionUser | null {
    return this.#user;
  }

  /** True once a session check has completed at least once. */
  get loaded(): boolean {
    return this.#loaded;
  }

  get isAuthenticated(): boolean {
    return this.#user !== null;
  }

  /** Subscribe to identity changes. Returns an unsubscribe function. */
  subscribe(listener: (user: SessionUser | null) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  set(user: SessionUser | null): void {
    this.#user = user;
    this.#loaded = true;
    for (const listener of [...this.#listeners]) {
      listener(user);
    }
  }

  markLoaded(): void {
    this.#loaded = true;
  }
}

/** What a session screen needs. The ViewModel depends on this, not the class. */
export interface AuthSession {
  signIn(email: string, password: string): Promise<SessionUser>;
  signUp(input: { email: string; password: string; name: string }): Promise<SessionUser>;
  signOut(): Promise<void>;
}

/** The stable credential endpoints under the application `/api/auth` mount. */
const AUTH = {
  session: '/api/auth/get-session',
  signIn: '/api/auth/sign-in/email',
  signUp: '/api/auth/sign-up/email',
  signOut: '/api/auth/sign-out',
} as const;

export interface AuthSessionServiceOptions {
  readonly transport: ApiTransport;
  readonly state: SessionState;
}

/**
 * Sign in, sign up and sign out, and keep `state` in step with the answer.
 *
 * Responses are checked against the provider's wire schema and projected onto
 * `SessionUser` before they become the signed-in user. The identity that reaches a
 * shell decides what it may show and what it may send, so a body that is not a user
 * is a refusal, not a partially populated object — and `displayName` is filled from
 * the provider's `name` rather than left `undefined`.
 */
export class AuthSessionService implements AuthSession {
  readonly #transport: ApiTransport;
  readonly #state: SessionState;

  constructor(options: AuthSessionServiceOptions) {
    this.#transport = options.transport;
    this.#state = options.state;
  }

  /**
   * Check the current session.
   *
   * A 401 is the expected "not signed in" answer, not a failure: it resolves to
   * `null` rather than rejecting, so every caller does not have to special-case
   * it and none of them can forget.
   */
  async refresh(signal?: AbortSignal): Promise<SessionUser | null> {
    try {
      const result = await this.#transport.request<{ user: unknown } | null>(AUTH.session, {
        method: 'GET',
        ...(signal === undefined ? {} : { signal }),
      });
      if (result === null || result.user === null || result.user === undefined) {
        this.#state.set(null);
        return null;
      }
      const user = asSessionUser(result.user);
      this.#state.set(user);
      return user;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      this.#state.set(null);
      return null;
    }
  }

  async signIn(email: string, password: string): Promise<SessionUser> {
    const user = await this.#credentials(AUTH.signIn, { email, password, returnHeaders: true });
    this.#state.set(user);
    return user;
  }

  async signUp(input: { email: string; password: string; name: string }): Promise<SessionUser> {
    const user = await this.#credentials(AUTH.signUp, {
      email: input.email,
      password: input.password,
      name: input.name,
    });
    this.#state.set(user);
    return user;
  }

  async signOut(): Promise<void> {
    await this.#transport.request<unknown>(AUTH.signOut, { method: 'POST', body: {} });
    this.#state.set(null);
  }

  async #credentials(path: string, body: unknown): Promise<SessionUser> {
    const result = await this.#transport.request<{ user: unknown }>(path, { method: 'POST', body });
    return asSessionUser(result.user);
  }
}

/**
 * Assert a response body really is the provider's user, and project it.
 *
 * One function for `refresh` and both credential paths, so they cannot drift into
 * checking different things — and so a native host inherits the same refusal the
 * web one has, from the same place.
 *
 * The projection is why this is not `as SessionUser`. The provider returns `name`;
 * this application calls it `displayName`. Casting through produced a
 * `SessionUser` whose display name was `undefined`, which nothing noticed until
 * a screen tried to render one.
 */
const asSessionUser = (value: unknown): SessionUser =>
  toSessionUser(parseDto(SessionUserWireSchema, value, 'a session user'));
