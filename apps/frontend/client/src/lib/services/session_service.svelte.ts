// apps/frontend/client/src/lib/services/session_service.svelte.ts
//
// The signed-in user, as a single source of truth for the whole client.
//
// A `$state` singleton rather than a service instance per screen: the session
// is genuinely global, it has one writer (this module) and many readers, and
// two screens disagreeing about who is signed in is a bug the user sees
// immediately.

import type { SessionUser } from '@starter/schemas/auth';
import { type ApiClient, apiClient } from './api_client.ts';

class SessionState {
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

export const sessionState = new SessionState();

export class SessionService {
  readonly #api: ApiClient;

  constructor(options: { api?: ApiClient } = {}) {
    this.#api = options.api ?? apiClient;
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
      const result = await this.#api.getSession(signal);
      const user = result?.user ?? null;
      sessionState.set(user);
      return user;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      sessionState.set(null);
      return null;
    }
  }

  async signIn(email: string, password: string): Promise<SessionUser> {
    const user = await this.#api.signIn(email, password);
    sessionState.set(user);
    return user;
  }

  async signUp(input: { email: string; password: string; name: string }): Promise<SessionUser> {
    const user = await this.#api.signUp(input);
    sessionState.set(user);
    return user;
  }

  async signOut(): Promise<void> {
    await this.#api.signOut();
    sessionState.set(null);
  }
}

export const sessionService = new SessionService();
