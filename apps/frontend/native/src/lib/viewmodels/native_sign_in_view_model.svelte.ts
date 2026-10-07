import type { AuthSessionService, DeviceAuthorizationService } from '@starter/features/auth';
import type { Navigation } from '@starter/platform';
import type { SessionUser } from '@starter/schemas/auth';

export type SignInPhase =
  | 'signed-out'
  | 'requesting'
  | 'waiting'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'error'
  | 'cancelled';

export interface NativeSignInOptions {
  readonly authProfile: 'legacy' | 'supabase';
  readonly apiOrigin: string;
  readonly session: { readonly user: SessionUser | null };
  readonly activeVault: { isAvailable(): Promise<boolean> };
  readonly refreshSession: () => Promise<void>;
  readonly requiresReauthentication: () => boolean;
  readonly hasSession: () => boolean;
  readonly unlockSupabaseVault: (passphrase: string) => Promise<void>;
  readonly unlockVault: (passphrase: string) => Promise<string | null>;
  readonly beginSupabaseOAuth: (provider: string, remember: boolean) => Promise<void>;
  readonly authSessionService: Pick<AuthSessionService, 'refresh' | 'signOut'>;
  readonly deviceService: DeviceAuthorizationService;
  readonly externalBrowser: { open(url: string): Promise<void> };
  readonly adoptSession: (token: string, userId: string, remember: boolean) => Promise<void>;
  readonly nativeNavigation: Navigation;
}

/** Screen state and sign-in decisions; host operations arrive from composition. */
export class NativeSignInViewModel {
  phase = $state<SignInPhase>('signed-out');
  userCode = $state('');
  statusText = $state('');
  errorText = $state('');
  remember = $state(false);
  passphrase = $state('');
  vaultAvailable = $state(false);
  reauthenticationRequired = $state(false);
  #inFlight = new AbortController();
  readonly #options: NativeSignInOptions;

  constructor(options: NativeSignInOptions) {
    this.#options = options;
  }

  get user() {
    return this.#options.session.user;
  }
  get authProfile() {
    return this.#options.authProfile;
  }
  get apiOrigin() {
    return this.#options.apiOrigin;
  }
  get busy() {
    return this.phase === 'requesting' || this.phase === 'waiting';
  }

  initialize = async (): Promise<void> => {
    try {
      this.vaultAvailable = await this.#options.activeVault.isAvailable();
      await this.#options.refreshSession();
      this.reauthenticationRequired = this.#options.requiresReauthentication();
    } catch (error) {
      this.errorText = error instanceof Error ? error.message : 'Could not restore the session.';
    }
  };

  dispose = (): void => {
    this.#inFlight.abort();
  };

  signInWithBrowser = async (): Promise<void> => {
    if (this.busy) {
      return;
    }
    this.phase = 'requesting';
    this.errorText = '';
    this.#inFlight.abort();
    this.#inFlight = new AbortController();
    const { signal } = this.#inFlight;

    try {
      if (this.authProfile === 'supabase') {
        if (this.remember && !(await this.#options.activeVault.isAvailable())) {
          if (this.passphrase.length === 0) {
            this.errorText =
              'Enter a passphrase to unlock the secure store, or clear "remember me".';
            return;
          }
          await this.#options.unlockSupabaseVault(this.passphrase);
          this.passphrase = '';
          this.vaultAvailable = true;
          this.reauthenticationRequired = this.#options.requiresReauthentication();
          if (this.#options.hasSession()) {
            await this.#options.nativeNavigation.go('/notes');
            return;
          }
        }
        this.phase = 'waiting';
        this.statusText = 'Opening Supabase sign-in in your browser…';
        await this.#options.beginSupabaseOAuth('google', this.remember);
        this.phase = 'signed-out';
        this.statusText =
          'Complete sign-in in your browser. This app will reopen when it is finished.';
        return;
      }

      if (this.remember && !(await this.#options.activeVault.isAvailable())) {
        if (this.passphrase.length === 0) {
          this.errorText = 'Enter a passphrase to unlock the vault, or clear "remember me".';
          return;
        }
        await this.#options.unlockVault(this.passphrase);
        this.vaultAvailable = true;
        // A remembered session, if there was one, was restored above. If the user
        // asked to remember this one and already had a session, that is the old
        // account: signing out of it is cheaper than carrying two credentials.
        await this.#options.authSessionService.signOut().catch(() => undefined);
      }

      this.phase = 'requesting';
      this.statusText = 'Asking the server for a sign-in code…';
      const code = await this.#options.deviceService.requestCode(signal);

      this.userCode = code.user_code;
      this.phase = 'waiting';
      this.statusText = 'Waiting for you to approve this device in your browser.';

      // Out to the user's own browser, never a webview: see external_browser.ts.
      await this.#options.externalBrowser.open(code.verification_uri_complete);

      const outcome = await this.#options.deviceService.awaitApproval(code, signal);

      if (outcome.status === 'denied') {
        this.phase = 'denied';
        this.errorText = 'That request was denied in the browser. Nothing was stored.';
        return;
      }
      if (outcome.status === 'expired') {
        this.phase = 'expired';
        this.errorText = 'That code expired before it was approved. Start again.';
        return;
      }

      this.phase = 'approved';
      this.statusText = 'Approved. Loading your account…';

      // Adopt first, then resolve: the identity comes from the server with the new
      // credential in hand, so there is exactly one answer to "who is signed in".
      await this.#options.adoptSession(outcome.token.access_token, 'pending', false);
      const user = await this.#options.authSessionService.refresh(signal);

      if (user === null) {
        await this.#options.authSessionService.signOut().catch(() => undefined);
        this.phase = 'error';
        this.errorText = 'The server did not accept that token. Nothing was stored.';
        return;
      }

      if (this.remember) {
        await this.#options.adoptSession(outcome.token.access_token, user.id, true);
        this.passphrase = '';
      } else {
        await this.#options.adoptSession(outcome.token.access_token, user.id, false);
      }

      await this.#options.nativeNavigation.go('/notes');
    } catch (error) {
      // Cancellation is not a failure. Reporting it as one puts an error on the
      // screen every time the user navigates away mid-flow.
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || /cancelled/i.test(error.message))
      ) {
        this.phase = 'cancelled';
        return;
      }
      this.phase = 'error';
      this.errorText = error instanceof Error ? error.message : 'Sign-in failed.';
    } finally {
      if (this.busy) {
        this.phase = 'signed-out';
      }
    }
  };
}
