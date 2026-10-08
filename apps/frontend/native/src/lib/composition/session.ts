// apps/frontend/native/src/lib/composition/session.ts
//
// The native application's composition root.
//
// This is the whole host-specific surface of the frontend: five values that exist
// because a Tauri shell has no cookie jar, no server render and no browser, and
// everything else — the notes service, the account service, the session service,
// the device-authorization flow, every ViewModel and every component — is the
// same code the web app runs.
//
// A singleton is correct here and is a real distinction, not a copy of the web
// app's accident: a native window has one user, one process and one write at a
// time. In a Worker isolate it would be a bug (two concurrent requests rendering
// each other's identity), which is exactly why `@starter/features` holds no
// instance of its own and why this file is a host, not a package.
//
// The credential lives in three places, and only one of them persists:
//
//   * `#token` — this module's memory. Dies with the process, and is the *default*:
//     a client that was never asked to remember anything keeps nothing.
//   * `vaultStore` — a Stronghold snapshot, only written when the user typed a
//     passphrase into "remember me". Never `localStorage`, never `sessionStorage`,
//     never a file in the data directory.
//   * nowhere else. It is not in a URL, not in a log line, and not in a
//     module-level export a bundler could inline into the bundle.

import { SessionState } from '@starter/features/auth';
import { type Navigation, parseDto } from '@starter/platform';
import { type SessionUser, SessionUserSchema } from '@starter/schemas/auth';
import { createBearerTransport } from '#lib/platform/bearer_transport.ts';
import { createExternalBrowser } from '#lib/platform/external_browser.ts';
import { StrongholdVault } from '#lib/platform/stronghold_vault.ts';
import {
  type SupabaseAuthConfig,
  SupabaseAuthError,
  SupabaseNativeAuth,
  type SupabaseUser,
} from '#lib/platform/supabase_auth.ts';
import { CredentialVaultSessionStore } from '#lib/platform/vault_session_store.ts';
import { nativeConfig } from '#lib/runtime/config.ts';
import { NativeSignInViewModel } from '#lib/viewmodels/native_sign_in_view_model.svelte.ts';
import { goto } from '$app/navigation';

/** The public API origin, validated at module load by `#lib/runtime/config.ts`. */
export const apiOrigin = nativeConfig.apiOrigin;

const strongholdVault = new StrongholdVault();
export const externalBrowser = createExternalBrowser({
  origin: apiOrigin,
  allowLoopbackHttp: nativeConfig.dev,
  allowedOrigins: [nativeConfig.supabaseUrl],
});
const supabaseConfiguration = (): SupabaseAuthConfig => {
  return {
    environment: nativeConfig.environment,
    supabaseProjectRef: nativeConfig.supabaseProjectRef,
    apiOrigin,
    supabaseUrl: nativeConfig.supabaseUrl,
    anonKey: nativeConfig.supabaseAnonKey,
    nativeCallback: nativeConfig.nativeCallback,
    webCallback: nativeConfig.webCallback,
    allowedCallbacks: nativeConfig.allowedCallbacks,
  };
};
const supabaseConfig = supabaseConfiguration();
const supabaseScope = {
  environment: supabaseConfig.environment,
  supabaseProjectRef: supabaseConfig.supabaseProjectRef,
  apiOrigin: supabaseConfig.apiOrigin,
};
export const supabaseVaultStore = new CredentialVaultSessionStore({
  vault: strongholdVault,
  scope: supabaseScope,
});
export const supabaseNativeAuth = new SupabaseNativeAuth({
  config: supabaseConfig,
  store: supabaseVaultStore,
  openBrowser: async (url) => externalBrowser.open(url),
});

/**
 * The HTTP seam: absolute origin, bearer header, no cookies.
 *
 * One instance, like the web application's. Base URL and credentials are decided
 * here once; the token is read per request, so a sign-out is immediately visible
 * to every subsequent call.
 */
export const nativeTransport = createBearerTransport({
  origin: apiOrigin,
  getToken: () => supabaseNativeAuth.accessToken,
  beforeRequest: () => supabaseNativeAuth.ensureFreshAccessToken(),
});

/** Shared with the web host's own singleton, and for the same reason. */
export const sessionState = new SessionState();

export const nativeNavigation: Navigation = {
  go: async (path: string) => {
    await goto(path);
  },
};

const toSessionUser = (user: SupabaseUser): SessionUser => {
  if (user.email === null) {
    throw new Error('Supabase did not return an email for this account.');
  }
  return parseDto(
    SessionUserSchema,
    {
      id: user.id,
      email: user.email,
      displayName: user.displayName?.trim() || user.email,
      provider: 'email',
      emailVerified: user.emailVerified ?? false,
    },
    'a native Supabase session user',
  );
};

export const beginSupabaseOAuth = async (provider: string, remember = false): Promise<void> => {
  if (remember && !(await supabaseVaultStore.isAvailable())) {
    throw new Error('Unlock the secure session store before choosing remember sign-in.');
  }
  supabaseNativeAuth.setPersistenceEnabled(remember);
  await supabaseNativeAuth.beginOAuth(provider);
};

export const handleSupabaseCallback = async (url: string): Promise<void> => {
  const identity = await supabaseNativeAuth.handleCallback(url);
  sessionState.set(toSessionUser(identity));
  await nativeNavigation.go('/notes');
};

export const refreshNativeSession = async (): Promise<void> => {
  try {
    const restored =
      supabaseNativeAuth.accessToken === null
        ? await supabaseNativeAuth.restore()
        : supabaseNativeAuth.user;
    if (restored !== null) {
      await supabaseNativeAuth.ensureFreshAccessToken();
    }
    const identity = restored === null ? null : await supabaseNativeAuth.getCurrentUser();
    if (identity === null) {
      sessionState.set(null);
      return;
    }
    sessionState.set(toSessionUser(identity));
  } catch (error) {
    sessionState.set(null);
    if (
      error instanceof SupabaseAuthError &&
      (error.status === 401 ||
        error.status === 403 ||
        (error.status === 400 && error.path === '/auth/v1/token?grant_type=refresh_token'))
    ) {
      await supabaseNativeAuth.signOut().catch(() => undefined);
    }
  }
};

export const signOutNativeSession = async (): Promise<void> => {
  try {
    await supabaseNativeAuth.signOut();
  } finally {
    sessionState.set(null);
  }
};

export const unlockSupabaseVault = async (passphrase: string): Promise<void> => {
  await supabaseVaultStore.unlock(passphrase);
  await refreshNativeSession();
};

/** Each sign-in screen owns its state; this root selects its host operations. */
export const createNativeSignInViewModel = (): NativeSignInViewModel =>
  new NativeSignInViewModel({
    apiOrigin,
    session: sessionState,
    activeVault: supabaseVaultStore,
    refreshSession: refreshNativeSession,
    requiresReauthentication: () => supabaseNativeAuth.requiresReauthentication,
    hasSession: () => sessionState.user !== null,
    unlockSupabaseVault,
    beginSupabaseOAuth,
    nativeNavigation,
  });
