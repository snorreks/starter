// apps/frontend/client/src/lib/platform/native_session.ts
//
// Tauri-only: hold the session token for the webview.
//
// A Tauri webview's origin is `tauri://localhost`, so the API sees every request
// as cross-site and the session cookie is never attached. The native client
// therefore keeps the token and presents it as a bearer token.
//
// Two things this file is careful about:
//
//   1. `@tauri-apps/api` is imported dynamically, and only after `isTauri()`
//      confirms the host. In browser builds the package is aliased to a stub
//      whose every export throws, so a static import would make the browser
//      bundle carry a module that cannot work.
//   2. The token is cached in a module variable. Reading it through an async
//      store on every request would add a round trip to the Tauri IPC bridge to
//      each API call.

import { isTauri } from '@starter/frontend-services/platform';
import { setApiTokenProvider } from '#lib/services/api_client.ts';

const TOKEN_STORAGE_KEY = 'starter.session.token';

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

let cachedToken: string | undefined;
let installed = false;

const invokeOrThrow = async (): Promise<TauriInvoke> => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke as TauriInvoke;
};

/**
 * Install the bearer-token provider and load any persisted token.
 *
 * Idempotent, and a no-op in a browser — a browser uses the session cookie and
 * has no token to hold.
 */
export const installNativeSessionBridge = async (): Promise<void> => {
  if (installed || !isTauri()) {
    return;
  }
  installed = true;

  setApiTokenProvider(() => cachedToken);

  try {
    const invoke = await invokeOrThrow();
    const stored = await invoke('read_session_value', { key: TOKEN_STORAGE_KEY });
    cachedToken = typeof stored === 'string' && stored.length > 0 ? stored : undefined;
  } catch {
    // A missing or unreadable token store is not fatal: the user simply has to
    // sign in again. Failing here would take the whole app down over a cache.
    cachedToken = undefined;
  }
};

export const persistSessionToken = async (token: string): Promise<void> => {
  cachedToken = token;

  if (!isTauri()) {
    return;
  }
  const invoke = await invokeOrThrow();
  await invoke('write_session_value', { key: TOKEN_STORAGE_KEY, value: token });
};

export const clearSessionToken = async (): Promise<void> => {
  cachedToken = undefined;

  if (!isTauri()) {
    return;
  }
  const invoke = await invokeOrThrow();
  await invoke('remove_session_value', { key: TOKEN_STORAGE_KEY });
};

/** Test seam. */
export const __setCachedTokenForTest = (token: string | undefined): void => {
  cachedToken = token;
};
