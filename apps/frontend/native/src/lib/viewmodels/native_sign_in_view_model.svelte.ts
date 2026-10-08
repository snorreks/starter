import type { Navigation } from '@starter/platform';
import type { SessionUser } from '@starter/schemas/auth';

export type SignInPhase =
  | 'signed-out'
  | 'authenticated'
  | 'requesting'
  | 'waiting'
  | 'error'
  | 'cancelled';

export interface NativeSignInOptions {
  readonly apiOrigin: string;
  readonly session: { readonly user: SessionUser | null };
  readonly activeVault: { isAvailable(): Promise<boolean> };
  readonly refreshSession: () => Promise<void>;
  readonly requiresReauthentication: () => boolean;
  readonly hasSession: () => boolean;
  readonly unlockSupabaseVault: (passphrase: string) => Promise<void>;
  readonly beginSupabaseOAuth: (provider: string, remember: boolean) => Promise<void>;
  readonly nativeNavigation: Navigation;
}

export class NativeSignInViewModel {
  phase = $state<SignInPhase>('signed-out');
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
    try {
      if (this.remember && !(await this.#options.activeVault.isAvailable())) {
        if (!this.passphrase) {
          this.errorText = 'Enter a passphrase to unlock the secure store, or clear "remember me".';
          return;
        }
        await this.#options.unlockSupabaseVault(this.passphrase);
        this.passphrase = '';
        this.vaultAvailable = true;
        this.reauthenticationRequired = this.#options.requiresReauthentication();
        if (this.#options.hasSession()) {
          this.phase = 'authenticated';
          this.statusText = '';
          try {
            await this.#options.nativeNavigation.go('/notes');
          } catch (error) {
            const detail = error instanceof Error ? error.message : 'Navigation failed.';
            this.errorText = `Signed in, but could not open notes: ${detail}`;
          }
          return;
        }
      }
      this.phase = 'waiting';
      this.statusText = 'Opening Google sign-in in your browser…';
      await this.#options.beginSupabaseOAuth('google', this.remember);
      this.phase = 'signed-out';
      this.statusText =
        'Complete sign-in in your browser. This app will reopen when it is finished.';
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || /cancelled/i.test(error.message))
      ) {
        this.phase = 'cancelled';
        return;
      }
      if (this.phase !== 'authenticated') {
        this.phase = 'error';
      }
      this.statusText = '';
      this.errorText = error instanceof Error ? error.message : 'Sign-in failed.';
    } finally {
      if (this.busy) {
        this.phase = 'signed-out';
      }
    }
  };
}
