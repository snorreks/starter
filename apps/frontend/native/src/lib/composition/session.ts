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

import { AuthSessionService, createAccountService, SessionState } from '@starter/features/auth';
import type { Navigation, SessionStore } from '@starter/platform';
import { createBearerTransport } from '#lib/platform/bearer_transport.ts';
import { createExternalBrowser } from '#lib/platform/external_browser.ts';
import { StrongholdVault } from '#lib/platform/stronghold_vault.ts';
import { VaultSessionStore } from '#lib/platform/vault_session_store.ts';
import { nativeConfig } from '#lib/runtime/config.ts';
import { goto } from '$app/navigation';

/**
 * The in-memory credential.
 *
 * A module-scope object rather than a class instance because there is exactly one
 * per window and `getToken` has to be a synchronous read on every request path.
 */
const memory = {
  token: null as string | null,
  /** The account this token belongs to, once the server has confirmed it. */
  account: null as string | null,
};

/** The public API origin, validated at module load by `#lib/runtime/config.ts`. */
export const apiOrigin = nativeConfig.apiOrigin;

/**
 * The HTTP seam: absolute origin, bearer header, no cookies.
 *
 * One instance, like the web application's. Base URL and credentials are decided
 * here once; the token is read per request, so a sign-out is immediately visible
 * to every subsequent call.
 */
export const nativeTransport = createBearerTransport({
  origin: apiOrigin,
  getToken: () => memory.token,
  className: 'NativeApiTransport',
});

/** Shared with the web host's own singleton, and for the same reason. */
export const sessionState = new SessionState();

export const authSessionService = new AuthSessionService({
  transport: nativeTransport,
  state: sessionState,
});

export const accountService = createAccountService(nativeTransport);

export const externalBrowser = createExternalBrowser({ origin: apiOrigin });

/**
 * Persistence. Opt-in, unlocked by the user, scoped to this origin.
 *
 * The vault is constructed eagerly but opens nothing: `Stronghold.load` is only
 * called from `unlock`, so starting the app does not touch a passphrase, does not
 * read a snapshot, and cannot silently restore a session the user did not ask to
 * restore.
 */
export const vaultStore = new VaultSessionStore({
  vault: new StrongholdVault(),
  origin: apiOrigin,
});

/** Where a credential goes when "remember me" is on. An interface, not a class. */
export const persistedSessionStore: SessionStore = vaultStore;

export const nativeNavigation: Navigation = {
  go: async (path: string) => {
    await goto(path);
  },
};

/** The signed-in user's id, or null. Used as the scope's account half. */
export const currentAccount = (): string => memory.account ?? 'anonymous';

/**
 * Adopt a credential that the server has just issued or verified.
 *
 * `remember` is opt-in and means two things at once: keep it in memory, and — only
 * if a vault is unlocked — write it to the vault. The passphrase itself is
 * handled by `unlockVault` and is never passed here, so this function has no way
 * to persist the unlock secret even by mistake.
 */
export const adoptSession = async (
  token: string,
  userId: string,
  remember: boolean,
): Promise<void> => {
  memory.token = token;
  memory.account = userId;

  if (!remember) {
    return;
  }
  if (!(await vaultStore.isAvailable())) {
    throw new Error(
      '"Remember me" needs the vault unlocked. Unlock it first, or sign in without it.',
    );
  }
  await vaultStore.save({ origin: apiOrigin, account: userId }, token);
};

/**
 * Forget the credential, in memory and in the vault.
 *
 * Order matters: the in-memory token goes first and unconditionally, so a vault
 * that cannot be written right now still leaves this window signed out. The vault
 * removal follows, and the store defers it when it is locked (see
 * `VaultSessionStore`) rather than dropping it.
 */
export const discardSession = async (): Promise<void> => {
  const account = memory.account;
  memory.token = null;
  memory.account = null;
  vaultStore.releaseBinding();

  if (account === null) {
    return;
  }
  await vaultStore.clear({ origin: apiOrigin, account });
};

/**
 * Restore a persisted credential, if the vault is open and the scope matches.
 *
 * Returns the user id, or null. A null here is the normal "not remembered, or
 * locked" answer and never throws: the sign-in screen is the right place for both
 * states, and a window that cannot start because a vault is locked cannot tell
 * the user why.
 */
export const restoreSession = async (): Promise<string | null> => {
  if (!(await vaultStore.isAvailable())) {
    return null;
  }
  for (const account of await knownAccounts()) {
    const token = await vaultStore.load({ origin: apiOrigin, account });
    if (token !== null) {
      memory.token = token;
      memory.account = account;
      return account;
    }
  }
  return null;
};

/** The last account is persisted under a fixed, origin-scoped vault key. */
export const rememberStoredAccount = (account: string): Promise<void> =>
  vaultStore.rememberStoredAccount(account);

const knownAccounts = (): Promise<string[]> => vaultStore.knownAccounts();

/**
 * Unlock the vault, and adopt whatever credential was remembered for it.
 *
 * A wrong passphrase rejects from the vault; this function adds nothing to it,
 * because inventing a second meaning for "wrong passphrase" is how a user ends up
 * retyping a correct one.
 */
export const unlockVault = async (passphrase: string): Promise<string | null> => {
  await vaultStore.unlock(passphrase);
  return restoreSession();
};
