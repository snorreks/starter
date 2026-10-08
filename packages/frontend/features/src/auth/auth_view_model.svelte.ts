// packages/frontend/features/src/auth/auth_view_model.svelte.ts
//
// The sign-in / sign-up screen's state and commands.
//
// Plain class, no base class
// -------------------------
// This extended `BaseFormViewModel`, whose whole job was `form`, `isSubmitting`
// and an error map. Three of those four fields are two `$state` declarations and
// a setter, and the fourth — the base's schema validation, `isValid`, `handleChange`
// and the `onSubmit` callback — had no reachable call path in this repository,
// because this class overrode `handleSubmit` without ever calling up.
//
// So the base is gone and the four fields are here, where they are visible. The
// form is validated with the same `@starter/schemas` Valibot schemas the server
// validates with, so the browser cannot accept something the Worker will refuse.
//
// Three sign-in outcomes, not one boolean
// --------------------------------------
// An unverified address produces a *specific* failure from Supabase Auth, and it
// needs a specific response: telling someone "check your email" when their password
// is wrong teaches them that a wrong password means mail is coming. So the outcome
// is a union, and the view picks the message.
//
// Everything host-specific arrives through the constructor
// -------------------------------------------------------
// The session, the account endpoints and navigation are injected, and each is an
// interface rather than a concrete class. That is what lets this screen run under
// Bun with no SvelteKit app runtime: `$app/navigation` and a module-scope
// `apiClient` are exactly what made the previous copy untestable outside a page
// load. There is no default for any of the three — a default would resolve to the
// web host's implementation at module scope, and this file would work in a browser
// and nowhere else, which is the situation this extraction exists to end.

import type { Navigation } from '@starter/platform';
import {
  AccountErrorCode,
  authErrorCode,
  type SignInInput,
  SignInInputSchema,
  type SignUpInput,
  SignUpInputSchema,
} from '@starter/schemas/auth';
import { reportError } from '@starter/ui';
import { disposeScreen, type ScreenGuards, type ScreenOwner } from '@starter/ui/screen';
import { MutationGuard, StaleGuard, toAppError } from '@starter/utils';
import * as v from 'valibot';
import type { AccountService } from './account_service.ts';
import type { AuthSession } from './auth_session_service.svelte.ts';

export type AuthMode = 'sign-in' | 'sign-up';

/** Where a successful sign-in goes. Named because it appears in two places. */
export const AUTHENTICATED_PATH = '/notes';

export type AuthOutcome =
  | { kind: 'signed-in' }
  /** Sign-up worked; the address has to be confirmed before signing in. */
  | { kind: 'awaiting-verification'; email: string }
  /** Password is wrong, or the address does not exist. Deliberately the same. */
  | { kind: 'invalid-credentials' }
  /** The address exists but is unconfirmed. */
  | { kind: 'unverified'; email: string }
  | { kind: 'rate-limited' }
  | { kind: 'failed'; message: string };

export interface AuthViewModelOptions {
  session: AuthSession;
  mode: AuthMode;
  /** The mail-sending endpoints. Injected because one of them costs a rate limit. */
  account: AccountService;
  /** How this host moves between screens. */
  navigation: Navigation;
}

export class AuthViewModel implements ScreenOwner, ScreenGuards {
  readonly className = 'AuthViewModel';

  mode = $state<AuthMode>('sign-in');
  form = $state<SignUpInput>({ email: '', password: '', displayName: '' });
  isSubmitting = $state(false);
  errors = $state<Record<string, string>>({});
  outcome = $state<AuthOutcome | undefined>(undefined);

  /**
   * Claimed by `ScreenContainer`; never written from here.
   *
   * Declared as a mutable field rather than a getter because the container assigns
   * it. Read access is what this class needs, and `readonly` would break the
   * container's contract.
   */
  mounted = false;

  readonly #session: AuthSession;
  readonly #account: AccountService;
  readonly #navigation: Navigation;

  /**
   * The submission guard, and the only one this screen needs.
   *
   * There is no `StaleGuard` here, and that is not an oversight. Loads need one —
   * two searches race and the older must not win — but a form submission is not a
   * load: the user either clicks again, which `isSubmitting` already refuses, or
   * the screen goes away, which `MutationGuard` handles. A second guard would be a
   * way to cancel one sign-in attempt in favour of another, and the second one
   * would be the duplicate submission this screen must never send.
   */
  readonly requests = new StaleGuard();
  readonly mutations = new MutationGuard();

  constructor(options: AuthViewModelOptions) {
    this.#session = options.session;
    this.mode = options.mode;
    this.#account = options.account;
    this.#navigation = options.navigation;
  }

  get isSignUp(): boolean {
    return this.mode === 'sign-up';
  }

  /** A message about the last attempt, or undefined. The only one the view shows. */
  get message(): string | undefined {
    switch (this.outcome?.kind) {
      case 'awaiting-verification':
        return 'Check your inbox to confirm your address, then sign in.';
      case 'invalid-credentials':
        return 'That email and password do not match an account.';
      case 'unverified':
        return 'Confirm your address before signing in. We can send the link again.';
      case 'rate-limited':
        return 'Too many attempts. Wait a minute and try again.';
      case 'failed':
        return this.outcome.message;
      default:
        return undefined;
    }
  }

  /** Whether the view should offer "send the link again". */
  get canResendVerification(): boolean {
    return this.outcome?.kind === 'unverified' || this.outcome?.kind === 'awaiting-verification';
  }

  toggleMode(): void {
    this.mode = this.isSignUp ? 'sign-in' : 'sign-up';
    // Deliberately not `this.form = {...}`: the email is worth keeping across the
    // switch, because the common path is "typed an address, realised it is not
    // signed up yet". Clearing the password is the one thing that must happen.
    this.form.password = '';
    this.errors = {};
    this.outcome = undefined;
  }

  async handleSubmit(form?: HTMLFormElement, submitter?: HTMLElement | null): Promise<boolean> {
    // The mode-switch button is a submitter carrying its own `toggle` field, so it
    // arrives here like any other submission. Handling it explicitly is what stops "I
    // need an account" from signing somebody in — the two differ only in which button
    // was pressed, and `FormData(form)` cannot see that on its own.
    if (submitter !== undefined && submitter !== null && isModeToggle(submitter)) {
      this.toggleMode();
      return false;
    }

    // A second click while the first is in the air must not start a second
    // sign-up. `isSubmitting` is checked before anything else for that reason.
    if (this.isSubmitting || this.mutations.disposed) {
      return false;
    }

    this.errors = {};
    this.outcome = undefined;

    // With scripting, the values are read from the form the user actually filled in,
    // rather than from `this.form`. That matters because a browser autofill writes
    // into the DOM without firing the `oninput` handlers this screen binds, so
    // `this.form` can hold the previous value while the input shows the new one. The
    // form is the only place both exist.
    //
    // The `intent` field is read the same way and overwrites `mode`, so the form and
    // the ViewModel cannot disagree about which mode is being submitted.
    if (form !== undefined) {
      this.form = readForm(form);
      this.mode = readIntent(form);
    }

    const values: SignInInput | SignUpInput = this.isSignUp
      ? this.form
      : { email: this.form.email, password: this.form.password };

    const errors = validate(values);
    if (errors !== undefined) {
      this.errors = errors;
      return false;
    }

    this.isSubmitting = true;
    const handle = this.mutations.begin();
    if (handle === null) {
      this.isSubmitting = false;
      return false;
    }

    try {
      const outcome = this.isSignUp
        ? await this.#signUp(values as SignUpInput)
        : await this.#signIn(values as SignInInput);

      if (this.mutations.disposed) {
        return false;
      }
      this.outcome = outcome;

      if (this.outcome.kind === 'signed-in') {
        await this.#navigation.go(AUTHENTICATED_PATH);
      }
      return this.outcome.kind === 'signed-in' || this.outcome.kind === 'awaiting-verification';
    } catch (error) {
      if (this.mutations.disposed) {
        return false;
      }
      const appError = toAppError(error, 'Could not complete that request.');
      this.outcome = { kind: 'failed', message: appError.message };
      reportError(appError);
      return false;
    } finally {
      this.mutations.end();
      this.isSubmitting = false;
    }
  }

  /**
   * Ask for another verification mail.
   *
   * Routed through the client service rather than a resubmitted form because the
   * address is already known here, and a second submission of the sign-up form
   * would be the same request wearing a different hat — which is how a duplicate
   * submission becomes two accounts, or two rate-limit hits.
   */
  async resendVerification(email?: string): Promise<boolean> {
    const address = email ?? this.form.email;
    if (address.trim().length === 0 || this.isSubmitting || this.mutations.disposed) {
      return false;
    }

    this.isSubmitting = true;
    try {
      await this.#account.sendVerificationEmail({ email: address });
      if (this.mutations.disposed) {
        return false;
      }
      // Reported as the same "awaiting verification" outcome, because from the
      // user's point of view it is: nothing about the account changed.
      this.outcome = { kind: 'awaiting-verification', email: address };
      return true;
    } catch (error) {
      if (this.mutations.disposed) {
        return false;
      }
      const appError = toAppError(error, 'Could not send that email.');
      this.outcome = { kind: 'failed', message: appError.message };
      reportError(appError);
      return false;
    } finally {
      this.isSubmitting = false;
    }
  }

  /**
   * Nothing to load.
   *
   * Present only because `ScreenOwner` requires it. This screen's state arrives
   * with the page — the layout load already resolved the identity — and
   * `handleSubmit` is the only work it does. Returning immediately is the honest
   * answer; a fetch here would be a second copy of the session lookup the server
   * just did.
   */
  async initialize(): Promise<void> {
    // No-op. See above.
  }

  async dispose(): Promise<void> {
    disposeScreen(this);
  }

  async #signIn(values: SignInInput): Promise<AuthOutcome> {
    try {
      await this.#session.signIn(values.email, values.password);
      return { kind: 'signed-in' };
    } catch (error) {
      return classifyAuthFailure(error, values.email);
    }
  }

  async #signUp(values: SignUpInput): Promise<AuthOutcome> {
    try {
      await this.#session.signUp({
        email: values.email,
        password: values.password,
        name: values.displayName,
      });
      // No session: `autoSignIn` is off, because the address is not confirmed yet.
      return { kind: 'awaiting-verification', email: values.email };
    } catch (error) {
      return classifyAuthFailure(error, values.email);
    }
  }
}

/**
 * Map a failure onto the outcome the view can act on.
 *
 * Supabase Auth's own message is not shown to the user: for a sign-in it would say
 * which half of the pair was wrong, which is an account-existence oracle.
 * Everything unrecognised collapses into one generic failure — so a future error
 * code from the library cannot accidentally become a new, more specific message.
 */
const classifyAuthFailure = (error: unknown, email: string): AuthOutcome => {
  const appError = toAppError(error, 'Could not complete that request.');

  // Checked *before* the status, because an unverified address arrives as 403 —
  // the same status as a wrong password. Ordering these the other way round would
  // tell someone to check their inbox when their password is simply wrong, and
  // they would wait for a mail that is never coming.
  if (authErrorCode(error) === AccountErrorCode.emailNotVerified) {
    return { kind: 'unverified', email };
  }
  if (appError.errorType === 'forbidden' || appError.errorType === 'unauthorized') {
    return { kind: 'invalid-credentials' };
  }
  if (appError.errorType === 'rate_limited') {
    return { kind: 'rate-limited' };
  }
  return { kind: 'failed', message: appError.message };
};

/**
 * Read the submitted values out of the form element.
 *
 * Deliberately reads the DOM rather than trusting `this.form`: an autofilled field
 * never fires `input`, so the reactive copy can be stale while the input shows the
 * user's actual value. Reading the form is what makes the two agree.
 */
const readForm = (form: HTMLFormElement): SignUpInput => {
  const data = new FormData(form);
  return {
    email: String(data.get('email') ?? '').trim(),
    password: String(data.get('password') ?? ''),
    displayName: String(data.get('name') ?? '').trim(),
  };
};

/**
 * Whether the pressed button is the mode switch.
 *
 * Read from the element's own attributes rather than from a test id or a class, so a
 * rename of either cannot quietly turn the mode switch into a sign-in submission. The
 * field name is the same one the server action looks for, which is what keeps the two
 * paths in step: if this button stopped posting `toggle`, the no-JS path would stop
 * switching modes too, and the tests above this one would be the only thing to notice.
 */
const isModeToggle = (submitter: HTMLElement): boolean =>
  submitter instanceof HTMLButtonElement && submitter.name === 'toggle';

/** The mode the form is being submitted as, per its hidden `intent` field. */
const readIntent = (form: HTMLFormElement): AuthMode => {
  const intent = String(new FormData(form).get('intent') ?? '');
  return intent === 'sign-up' ? 'sign-up' : 'sign-in';
};

/**
 * Validate against the shared Standard Schema contract the server uses.
 *
 * Returns `undefined` when valid, or the first error per field. Returning early on
 * the first error per field rather than all of them keeps the message stable, so
 * typing a character does not shuffle which complaint appears.
 */
const validate = (values: SignInInput | SignUpInput): Record<string, string> | undefined => {
  const schema = 'displayName' in values ? SignUpInputSchema : SignInInputSchema;
  const result = v.safeParse(schema, values);
  if (result.success) {
    return undefined;
  }

  const errors: Record<string, string> = {};
  for (const issue of result.issues) {
    const field = issue.path?.map(({ key }) => String(key)).join('.') || '_form';
    errors[field] ??= issue.message;
  }
  return errors;
};
