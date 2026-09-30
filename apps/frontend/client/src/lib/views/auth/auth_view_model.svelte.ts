// apps/frontend/client/src/lib/views/auth/auth_view_model.svelte.ts
//
// Sign-in / sign-up.
//
// A form ViewModel, which is the second thing worth copying: validation comes
// from the TypeBox schema the server also validates against, so the client
// cannot accept input the API will reject.

import { BaseFormViewModel } from '@starter/frontend-services/base';
import { SignInInputSchema, SignUpInputSchema } from '@starter/schemas/auth';
import { type SessionService, sessionService } from '#lib/services/session_service.svelte.ts';
import { goto } from '$app/navigation';

export type AuthMode = 'sign-in' | 'sign-up';

export interface AuthViewModelOptions {
  className?: string;
  session?: SessionService;
  /** Injectable so a test can assert navigation without a router. */
  navigate?: (path: string) => Promise<void> | void;
  mode?: AuthMode;
}

export class AuthViewModel extends BaseFormViewModel<
  typeof SignInInputSchema,
  { className: string }
> {
  mode = $state<AuthMode>('sign-in');
  /** Server-side message from the last attempt, e.g. "invalid credentials". */
  serverMessage = $state<string | undefined>(undefined);

  readonly #session: SessionService;
  readonly #navigate: (path: string) => Promise<void> | void;

  constructor(options: AuthViewModelOptions = {}) {
    // Only the options the *base* classes understand go to `super`. `mode`,
    // `session` and `navigate` are this class's own dependencies and are
    // assigned below; passing them through widens the base option type with
    // details the base has no business knowing.
    super({
      className: options.className ?? 'AuthViewModel',
      schema: SignInInputSchema,
      initialValues: { email: '', password: '' },
    });
    this.mode = options.mode ?? 'sign-in';
    this.#session = options.session ?? sessionService;
    this.#navigate = options.navigate ?? ((path: string) => goto(path));
  }

  override async handleSubmit(): Promise<boolean> {
    this.serverMessage = undefined;

    if (this.mode === 'sign-up') {
      return this.#signUp();
    }
    return this.#signIn();
  }

  toggleMode(): void {
    this.mode = this.mode === 'sign-in' ? 'sign-up' : 'sign-in';
    this.serverMessage = undefined;
    void this.reset();
  }

  async #signIn(): Promise<boolean> {
    this.isSubmitting = true;
    try {
      const email = String(this.form.email ?? '').trim();
      const password = String(this.form.password ?? '');

      await this.#session.signIn(email, password);
      await this.#navigate('/');
      return true;
    } catch (error) {
      // An authentication failure is an expected outcome of this form, not an
      // application error: it is shown inline instead of as a snackbar.
      this.serverMessage = error instanceof Error ? error.message : 'Could not sign in.';
      return false;
    } finally {
      this.isSubmitting = false;
    }
  }

  async #signUp(): Promise<boolean> {
    this.isSubmitting = true;
    try {
      const email = String(this.form.email ?? '').trim();
      const password = String(this.form.password ?? '');

      await this.#session.signUp({
        email,
        password,
        name: email.split('@')[0] ?? 'user',
      });
      await this.#navigate('/');
      return true;
    } catch (error) {
      this.serverMessage = error instanceof Error ? error.message : 'Could not create the account.';
      return false;
    } finally {
      this.isSubmitting = false;
    }
  }
}

export const createAuthViewModel = (options: AuthViewModelOptions = {}): AuthViewModel =>
  AuthViewModel.create({
    ...options,
    className: options.className ?? 'AuthViewModel',
  });

export { SignUpInputSchema };
