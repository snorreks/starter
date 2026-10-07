import {
  ReauthenticationRequiredError,
  type SessionCredential,
  type SessionScope,
  type SessionStore,
} from '@starter/platform';

export interface SupabaseAuthConfig extends Omit<SessionScope, 'accountId'> {
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly nativeCallback: string;
  readonly webCallback: string;
  readonly allowedCallbacks: readonly string[];
}

export interface SupabaseUser {
  readonly id: string;
  readonly email: string | null;
  readonly displayName?: string;
  readonly emailVerified?: boolean;
}

export interface SupabaseAuthOptions {
  readonly config: SupabaseAuthConfig;
  readonly store: SessionStore;
  readonly fetch?: AuthFetch;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly now?: () => number;
}

export type AuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class SupabaseAuthError extends Error {
  override readonly name: string = 'SupabaseAuthError';

  readonly status: number | undefined;
  readonly path: string | undefined;

  constructor(message: string, status?: number, path?: string) {
    super(message);
    this.status = status;
    this.path = path;
  }
}

export class InvalidAuthCallbackError extends SupabaseAuthError {
  override readonly name: string = 'InvalidAuthCallbackError';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const randomVerifier = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
};

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const challengeFor = async (verifier: string): Promise<string> =>
  base64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );

const callbackKey = (raw: string): string => {
  const url = new URL(raw);
  return `${url.protocol}//${url.host}${url.pathname}`;
};

const validateConfig = (config: SupabaseAuthConfig): void => {
  for (const [label, raw] of [
    ['Supabase URL', config.supabaseUrl],
    ['API origin', config.apiOrigin],
  ] as const) {
    const url = new URL(raw);
    if (
      url.origin !== raw ||
      (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))
    ) {
      throw new Error(
        `${label} must be an HTTPS origin, or a loopback HTTP origin for local development.`,
      );
    }
  }
  if (
    config.environment.length === 0 ||
    config.supabaseProjectRef.length === 0 ||
    config.anonKey.length === 0
  ) {
    throw new Error('Supabase native environment, project reference, and public key are required.');
  }
  for (const callback of config.allowedCallbacks) {
    if (callbackKey(callback) !== callback) {
      throw new Error('Callback allowlist entries must be exact origins and paths.');
    }
  }
  if (
    !config.allowedCallbacks.includes(config.nativeCallback) ||
    !config.allowedCallbacks.includes(config.webCallback)
  ) {
    throw new Error('Both configured native and web callbacks must be allowlisted.');
  }
};

const parseToken = (value: unknown, now: number): SessionCredential => {
  if (!isRecord(value) || !isRecord(value.user)) {
    throw new SupabaseAuthError('Supabase returned an invalid session.');
  }
  const accessToken = value.access_token;
  const refreshToken = value.refresh_token;
  const accountId = value.user.id;
  const expiresIn = value.expires_in;
  if (
    typeof accessToken !== 'string' ||
    accessToken.length === 0 ||
    typeof refreshToken !== 'string' ||
    refreshToken.length === 0 ||
    typeof accountId !== 'string' ||
    accountId.length === 0 ||
    typeof expiresIn !== 'number' ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new SupabaseAuthError('Supabase returned an incomplete session.');
  }
  return {
    version: 1,
    accessToken,
    refreshToken,
    expiresAt:
      typeof value.expires_at === 'number' ? value.expires_at * 1000 : now + expiresIn * 1000,
    accountId,
    supabaseProjectRef: '',
    apiOrigin: '',
  };
};

/** Native Auth REST adapter. PKCE verifier/state never leave this process. */
export class SupabaseNativeAuth {
  readonly #fetch: AuthFetch;
  readonly #store: SessionStore;
  readonly #now: () => number;
  readonly #openBrowser: (url: string) => Promise<void>;
  #config: SupabaseAuthConfig;
  #credential: SessionCredential | null = null;
  #refreshPromise: Promise<string | null> | null = null;
  #generation = 0;
  #pending: {
    readonly state: string;
    readonly verifier: string;
    readonly callback: string;
  } | null = null;
  #persistEnabled = false;
  #requiresReauthentication = false;

  constructor(options: SupabaseAuthOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#openBrowser = options.openBrowser;
    validateConfig(options.config);
  }

  get accessToken(): string | null {
    return this.#credential?.accessToken ?? null;
  }

  get user(): SupabaseUser | null {
    return this.#credential === null ? null : { id: this.#credential.accountId, email: null };
  }

  get requiresReauthentication(): boolean {
    return this.#requiresReauthentication;
  }

  setPersistenceEnabled(enabled: boolean): void {
    this.#persistEnabled = enabled;
  }

  async beginOAuth(provider: string): Promise<void> {
    if (this.#credential !== null) {
      throw new SupabaseAuthError('Sign out before starting a new account sign-in.');
    }
    if (!/^[a-z][a-z0-9_-]*$/iu.test(provider)) {
      throw new SupabaseAuthError('Invalid OAuth provider.');
    }
    const verifier = randomVerifier();
    const challenge = await challengeFor(verifier);
    const state = randomVerifier();
    const callback = this.#config.nativeCallback;
    this.#pending = { state, verifier, callback };
    const url = new URL('/auth/v1/authorize', this.#config.supabaseUrl);
    url.searchParams.set('provider', provider);
    const returnTo = new URL(callback);
    returnTo.searchParams.set('state', state);
    url.searchParams.set('redirect_to', returnTo.toString());
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 's256');
    await this.#openBrowser(url.toString());
  }

  async handleCallback(rawUrl: string): Promise<SupabaseUser> {
    const generation = this.#generation;
    const pending = this.#pending;
    this.#pending = null;
    if (pending === null) {
      throw new InvalidAuthCallbackError('No sign-in request is awaiting a callback.');
    }
    let callback: URL;
    try {
      callback = new URL(rawUrl);
    } catch {
      throw new InvalidAuthCallbackError('The sign-in callback is not a URL.');
    }
    if (
      !this.#config.allowedCallbacks.includes(callbackKey(rawUrl)) ||
      callbackKey(rawUrl) !== pending.callback
    ) {
      throw new InvalidAuthCallbackError('The sign-in callback destination is not allowlisted.');
    }
    if (callback.hash.length > 0 || callback.username.length > 0 || callback.password.length > 0) {
      throw new InvalidAuthCallbackError(
        'Fragments and URL credentials are refused in sign-in callbacks.',
      );
    }
    for (const key of callback.searchParams.keys()) {
      if (!['state', 'code', 'error', 'error_description'].includes(key)) {
        throw new InvalidAuthCallbackError(
          'The sign-in callback contains an unsupported parameter.',
        );
      }
    }
    if (
      callback.searchParams.getAll('state').length !== 1 ||
      callback.searchParams.get('state') !== pending.state
    ) {
      throw new InvalidAuthCallbackError('The sign-in callback state is invalid or reused.');
    }
    if (callback.searchParams.has('access_token') || callback.searchParams.has('refresh_token')) {
      throw new InvalidAuthCallbackError('Token values in callback URLs are refused.');
    }
    const codes = callback.searchParams.getAll('code');
    const code = codes[0];
    if (codes.length !== 1 || code === undefined || code.length === 0) {
      throw new InvalidAuthCallbackError('The sign-in callback has no authorization code.');
    }
    const response = await this.#request('/auth/v1/token?grant_type=pkce', {
      method: 'POST',
      body: JSON.stringify({ auth_code: code, code_verifier: pending.verifier }),
    });
    if (generation !== this.#generation) {
      throw new InvalidAuthCallbackError(
        'The sign-in callback was invalidated by a session change.',
      );
    }
    const token = parseToken(response, this.#now());
    const credential = {
      ...token,
      supabaseProjectRef: this.#config.supabaseProjectRef,
      apiOrigin: this.#config.apiOrigin,
    };
    await this.#publish(credential, generation);
    const responseUser = isRecord(response) && isRecord(response.user) ? response.user : null;
    return {
      id: credential.accountId,
      email:
        responseUser !== null && typeof responseUser.email === 'string' ? responseUser.email : null,
      displayName:
        responseUser !== null &&
        isRecord(responseUser.user_metadata) &&
        typeof responseUser.user_metadata.full_name === 'string'
          ? responseUser.user_metadata.full_name
          : undefined,
      emailVerified: responseUser !== null && typeof responseUser.email_confirmed_at === 'string',
    };
  }

  async restore(): Promise<SupabaseUser | null> {
    const scope = this.#scope();
    let accountIds: string[];
    try {
      accountIds = await this.#store.knownAccounts(scope);
    } catch (error) {
      if (error instanceof ReauthenticationRequiredError) {
        this.#requiresReauthentication = true;
        return null;
      }
      throw error;
    }
    const accountId = accountIds[0];
    if (accountId === undefined) {
      return null;
    }
    let stored: SessionCredential | null;
    try {
      stored = await this.#store.load({ ...scope, accountId });
    } catch (error) {
      if (error instanceof ReauthenticationRequiredError) {
        this.#requiresReauthentication = true;
        return null;
      }
      throw error;
    }
    if (stored === null) {
      return null;
    }
    if (
      stored.version !== 1 ||
      stored.supabaseProjectRef !== this.#config.supabaseProjectRef ||
      stored.apiOrigin !== this.#config.apiOrigin
    ) {
      await this.#store.clear(this.#scope(stored.accountId));
      return null;
    }
    this.#persistEnabled = true;
    this.#credential = stored;
    this.#requiresReauthentication = false;
    if (stored.expiresAt - this.#now() < 60_000) {
      try {
        await this.refresh();
      } catch (error) {
        this.#credential = null;
        if (
          error instanceof SupabaseAuthError &&
          error.path === '/auth/v1/token?grant_type=refresh_token' &&
          (error.status === 400 || error.status === 401)
        ) {
          await this.#store.clear(this.#scope(stored.accountId));
        }
        return null;
      }
    }
    return this.#credential === null ? null : { id: this.#credential.accountId, email: null };
  }

  async refresh(): Promise<string | null> {
    if (this.#refreshPromise !== null) {
      return this.#refreshPromise;
    }
    const current = this.#credential;
    if (current === null) {
      return null;
    }
    const generation = this.#generation;
    const task = (async () => {
      const response = await this.#request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: current.refreshToken }),
      });
      const token = parseToken(response, this.#now());
      if (token.accountId !== current.accountId) {
        throw new SupabaseAuthError('Refresh changed the account identity.');
      }
      const next = {
        ...token,
        supabaseProjectRef: this.#config.supabaseProjectRef,
        apiOrigin: this.#config.apiOrigin,
      };
      if (generation !== this.#generation) {
        return null;
      }
      await this.#publish(next, generation);
      return generation === this.#generation ? next.accessToken : null;
    })();
    const tracked = task.finally(() => {
      if (this.#refreshPromise === tracked) {
        this.#refreshPromise = null;
      }
    });
    this.#refreshPromise = tracked;
    return tracked;
  }

  async ensureFreshAccessToken(): Promise<void> {
    if (this.#credential !== null && this.#credential.expiresAt <= this.#now() + 60_000) {
      await this.refresh();
    }
  }

  async getCurrentUser(): Promise<SupabaseUser | null> {
    if (this.#credential === null) {
      return null;
    }
    const response = await this.#request('/auth/v1/user', {
      method: 'GET',
      headers: { authorization: `Bearer ${this.#credential.accessToken}` },
    });
    if (!isRecord(response) || typeof response.id !== 'string') {
      throw new SupabaseAuthError('Supabase returned an invalid user identity.');
    }
    return {
      id: response.id,
      email: typeof response.email === 'string' ? response.email : null,
      displayName:
        isRecord(response.user_metadata) && typeof response.user_metadata.full_name === 'string'
          ? response.user_metadata.full_name
          : undefined,
      emailVerified: typeof response.email_confirmed_at === 'string',
    };
  }

  async signOut(): Promise<void> {
    const current = this.#credential;
    const generation = ++this.#generation;
    this.#refreshPromise = null;
    this.#credential = null;
    this.#pending = null;
    const tasks: Promise<unknown>[] = [];
    if (this.#persistEnabled && current !== null) {
      tasks.push(this.#store.clear(this.#scope(current.accountId)));
    }
    this.#persistEnabled = false;
    if (current !== null) {
      tasks.push(
        this.#request('/auth/v1/logout?scope=global', {
          method: 'POST',
          headers: { authorization: `Bearer ${current.accessToken}` },
        }),
      );
    }
    const outcomes = await Promise.allSettled(tasks);
    if (generation === this.#generation) {
      this.#credential = null;
    }
    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new SupabaseAuthError(
        'Supabase sign-out could not complete every local and remote cleanup step.',
      );
    }
  }

  async switchScope(next: SupabaseAuthConfig): Promise<void> {
    validateConfig(next);
    const previous = this.#scope();
    const nextScope = {
      environment: next.environment,
      supabaseProjectRef: next.supabaseProjectRef,
      apiOrigin: next.apiOrigin,
    };
    if (
      previous.environment === nextScope.environment &&
      previous.supabaseProjectRef === nextScope.supabaseProjectRef &&
      previous.apiOrigin === nextScope.apiOrigin
    ) {
      return;
    }
    ++this.#generation;
    this.#refreshPromise = null;
    this.#pending = null;
    this.#credential = null;
    this.#config = next;
    if (previous.accountId !== 'anonymous') {
      await this.#store.clear(previous);
    }
  }

  async #publish(credential: SessionCredential, generation: number): Promise<void> {
    if (generation !== this.#generation) {
      return;
    }
    if (
      credential.supabaseProjectRef !== this.#config.supabaseProjectRef ||
      credential.apiOrigin !== this.#config.apiOrigin
    ) {
      throw new SupabaseAuthError('Credential deployment scope does not match this native app.');
    }
    const scope = this.#scope(credential.accountId);
    const persist = this.#persistEnabled;
    if (persist) {
      try {
        await this.#store.save(scope, credential);
      } catch (error) {
        if (generation === this.#generation) {
          this.#credential = null;
        }
        throw error;
      }
    }
    if (generation !== this.#generation) {
      if (persist) {
        await this.#store.clear(scope);
      }
      return;
    }
    this.#credential = credential;
    this.#requiresReauthentication = false;
  }

  #scope(accountId = this.#credential?.accountId ?? 'anonymous'): SessionScope {
    return {
      environment: this.#config.environment,
      supabaseProjectRef: this.#config.supabaseProjectRef,
      apiOrigin: this.#config.apiOrigin,
      accountId,
    };
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.#fetch(new URL(path, this.#config.supabaseUrl), {
      ...init,
      headers: {
        apikey: this.#config.anonKey,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok) {
      throw new SupabaseAuthError(
        `Supabase Auth request failed (${response.status}).`,
        response.status,
        path,
      );
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }
}
