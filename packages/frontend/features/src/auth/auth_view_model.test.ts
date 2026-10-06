// apps/frontend/client/src/lib/features/auth/auth_view_model.test.ts
//
// The sign-in screen's outcome classification, and the duplicate-submission guard.
//
// This is a unit test with stubbed runes, which normally proves nothing about
// reactivity. That is acceptable *here* for one specific reason: nothing in this file
// is about reactivity. It is about which of five outcomes a given failure maps to,
// and about the fact that a second click does not start a second sign-up. Both are
// pure control flow, and the real-browser assertions for the reactive half live in
// `src/browser_tests/`.
//
// The thing being protected here is subtle. `EMAIL_NOT_VERIFIED` and a wrong
// password arrive with the same HTTP status, so a classifier that branched on status
// would tell someone to go and check their inbox when their password is simply
// wrong — and they would wait there for mail that is never coming.

import { describe, expect, mock, test } from 'bun:test';
import type { Navigation } from '@starter/platform';
import type { SessionUser } from '@starter/schemas/auth';
import { AppError, errorTypeForStatus } from '@starter/utils';
import type { AccountService } from './account_service.ts';
import type { AuthSession } from './auth_session_service.svelte.ts';
import { AuthViewModel } from './auth_view_model.svelte.ts';

const ADDRESS = 'someone@example.test';

/**
 * A user of the right shape, so a stub that resolves successfully resolves a
 * value the production signature promises. `as unknown as AuthSession` above is
 * then only carrying the *rejecting* stubs, where the return value is never read.
 */
const USER: SessionUser = {
  id: 'user_1',
  email: ADDRESS,
  displayName: 'Someone',
  provider: 'email',
  emailVerified: true,
};

/** A `SessionService` whose every method the test controls. */
const sessionStub = (
  overrides: Partial<Record<'signIn' | 'signUp', () => Promise<unknown>>> = {},
): AuthSession =>
  ({
    signIn: overrides.signIn ?? (() => Promise.resolve(USER)),
    signUp: overrides.signUp ?? (() => Promise.resolve(USER)),
    signOut: () => Promise.resolve(),
  }) as unknown as AuthSession;

/** The three host capabilities, all fakes. Nothing here reaches an application. */
const accountStub = (
  overrides: Partial<{ sendVerificationEmail: () => Promise<void> }> = {},
): AccountService => ({
  sendVerificationEmail: overrides.sendVerificationEmail ?? (() => Promise.resolve()),
  requestPasswordReset: () => Promise.resolve(),
  resetPassword: () => Promise.resolve(),
});

const build = (
  options: {
    signIn?: () => Promise<unknown>;
    signUp?: () => Promise<unknown>;
    mode?: 'sign-in' | 'sign-up';
    account?: AccountService;
  } = {},
): { viewModel: AuthViewModel; navigations: string[] } => {
  const navigations: string[] = [];
  const navigation: Navigation = {
    go: (path) => {
      navigations.push(path);
    },
  };

  const viewModel = new AuthViewModel({
    session: sessionStub({
      ...(options.signIn ? { signIn: options.signIn } : {}),
      ...(options.signUp ? { signUp: options.signUp } : {}),
    }),
    account: options.account ?? accountStub(),
    navigation,
    mode: options.mode ?? 'sign-in',
  });

  viewModel.form = { email: ADDRESS, password: 'correct horse battery', displayName: 'Someone' };
  return { viewModel, navigations };
};

/**
 * A server failure carrying a Better Auth code, the way `ApiClient` throws one.
 *
 * The `errorType` comes from `errorTypeForStatus` rather than being written by hand,
 * so these fixtures classify exactly as the transport does. That matters here: the
 * classifier under test branches on `errorType`, and a hand-written `'forbidden'`
 * on a 401 would have made the first test pass for the wrong reason.
 */
const serverError = (code: string, status: number): AppError =>
  new AppError(errorTypeForStatus(status), `server said ${code}`, {
    status,
    cause: { code, message: `server said ${code}` },
  });

describe('a failed sign-in', () => {
  test('a wrong password and an unknown account read identically', async () => {
    // One says the account is not there; the other says the password is wrong.
    // Both must produce the same outcome and the same message, or this screen tells
    // an attacker which addresses are registered.
    const unknown = build({
      signIn: () => Promise.reject(serverError('INVALID_EMAIL_OR_PASSWORD', 401)),
    });
    const wrongPassword = build({
      signIn: () => Promise.reject(serverError('INVALID_EMAIL_OR_PASSWORD', 403)),
    });

    await unknown.viewModel.handleSubmit();
    await wrongPassword.viewModel.handleSubmit();

    expect(unknown.viewModel.outcome).toEqual({ kind: 'invalid-credentials' });
    expect(wrongPassword.viewModel.outcome).toEqual(unknown.viewModel.outcome);
    expect(unknown.viewModel.message).toBe(wrongPassword.viewModel.message);
  });

  test('an unverified address is distinguished from a wrong password', async () => {
    // Both are 403. Branching on status alone would produce the wrong message and
    // hide the resend affordance this outcome exists to offer.
    const { viewModel } = build({
      signIn: () => Promise.reject(serverError('EMAIL_NOT_VERIFIED', 403)),
    });

    await viewModel.handleSubmit();

    expect(viewModel.outcome).toEqual({ kind: 'unverified', email: ADDRESS });
    // The specific thing a user can act on.
    expect(viewModel.canResendVerification).toBe(true);
    expect(viewModel.message).toMatch(/confirm your address/i);
  });

  test('a rate limit is reported as such rather than as a bad password', async () => {
    const { viewModel } = build({
      signIn: () =>
        Promise.reject(new AppError('rate_limited', 'Too many requests.', { status: 429 })),
    });

    await viewModel.handleSubmit();

    expect(viewModel.outcome).toEqual({ kind: 'rate-limited' });
    expect(viewModel.canResendVerification).toBe(false);
  });

  test('an unrecognised failure is generic, not a new specific message', async () => {
    // A future error code from the library must not silently become a more
    // informative message. That is how an existence oracle gets added by accident.
    const { viewModel } = build({
      signIn: () => Promise.reject(new AppError('server', 'The database is on fire.')),
    });

    await viewModel.handleSubmit();

    expect(viewModel.outcome).toEqual({ kind: 'failed', message: 'The database is on fire.' });
    expect(viewModel.canResendVerification).toBe(false);
  });

  test('an unverified account created by sign-up offers the resend', async () => {
    const { viewModel } = build({ mode: 'sign-up', signUp: () => Promise.resolve() });

    const accepted = await viewModel.handleSubmit();

    expect(accepted).toBe(true);
    expect(viewModel.outcome).toEqual({ kind: 'awaiting-verification', email: ADDRESS });
    expect(viewModel.canResendVerification).toBe(true);
  });
});

describe('a successful sign-in', () => {
  test('navigates once, to the workspace', async () => {
    const { viewModel, navigations } = build();

    await viewModel.handleSubmit();

    expect(viewModel.outcome).toEqual({ kind: 'signed-in' });
    expect(navigations).toEqual(['/notes']);
  });

  test('sign-up does not navigate, because there is no session yet', async () => {
    // `autoSignIn` is off. Navigating to `/notes` would land on a page that redirects
    // straight back, which reads as a broken application rather than as "confirm
    // your address first".
    const { viewModel, navigations } = build({ mode: 'sign-up' });

    await viewModel.handleSubmit();

    expect(navigations).toEqual([]);
  });
});

describe('disposal during verification resend', () => {
  for (const rejected of [false, true]) {
    test(`a ${rejected ? 'failed' : 'successful'} resend cannot publish after teardown`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sendVerificationEmail = mock(async () => {
        await gate;
        if (rejected) {
          throw new Error('send failed');
        }
      });
      try {
        const { viewModel } = build({ account: accountStub({ sendVerificationEmail }) });
        const pending = viewModel.resendVerification();
        await viewModel.dispose();
        release();

        // Both outcomes are the same from here: the screen has been torn down, so
        // neither a success message nor a failure may be published into it.
        expect(await pending).toBe(false);
        expect(viewModel.outcome).toBeUndefined();
        expect(viewModel.isSubmitting).toBe(false);
        expect(await viewModel.resendVerification()).toBe(false);
        expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
      } finally {
        sendVerificationEmail.mockRestore();
      }
    });
  }
});

describe('disposal during sign-in', () => {
  test('a pending sign-in cannot publish an outcome or navigate after teardown', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { viewModel, navigations } = build({ signIn: () => gate });

    const pending = viewModel.handleSubmit();
    await viewModel.dispose();
    release();

    expect(await pending).toBe(false);
    expect(viewModel.outcome).toBeUndefined();
    expect(navigations).toEqual([]);
    expect(viewModel.isSubmitting).toBe(false);
  });
});

describe('a duplicate submission', () => {
  test('a second click while the first is in flight is ignored', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { viewModel } = build({
      signIn: async () => {
        calls += 1;
        await gate;
      },
    });

    const first = viewModel.handleSubmit();
    // Not awaited: the point is that it is still pending when the second arrives.
    const second = viewModel.handleSubmit();

    release();
    await Promise.all([first, second]);

    // Exactly one. Two sign-ins against the same account from one click is how a
    // duplicate account appears, and it also spends two of the three sign-in
    // attempts Better Auth allows per ten seconds.
    expect(calls).toBe(1);
  });

  test('a submission after teardown is refused rather than sent', async () => {
    const signIn = mock(() => Promise.resolve());
    const { viewModel } = build({ signIn });

    await viewModel.dispose();
    const accepted = await viewModel.handleSubmit();

    expect(accepted).toBe(false);
    // The screen is gone. A request sent now would resolve into a ViewModel nobody
    // is reading, and would set a cookie on a page the user has left.
    expect(signIn).not.toHaveBeenCalled();
  });

  test('a submission after teardown does not navigate', async () => {
    const { viewModel, navigations } = build();

    await viewModel.dispose();
    await viewModel.handleSubmit();

    expect(navigations).toEqual([]);
  });
});

describe('client-side validation', () => {
  test('missing required properties are reported on each field before any request', async () => {
    const signUp = mock(() => Promise.resolve());
    const { viewModel } = build({ mode: 'sign-up', signUp });
    // Simulate incomplete runtime data while retaining the sign-up schema selector.
    Reflect.deleteProperty(viewModel.form, 'email');
    Reflect.deleteProperty(viewModel.form, 'password');

    expect(await viewModel.handleSubmit()).toBe(false);
    expect(viewModel.errors.email).toBeDefined();
    expect(viewModel.errors.password).toBeDefined();
    expect(viewModel.errors._form).toBeUndefined();
    expect(signUp).not.toHaveBeenCalled();
  });

  test('a short password is refused before any request', async () => {
    const signUp = mock(() => Promise.resolve());
    const { viewModel } = build({ mode: 'sign-up', signUp });
    viewModel.form = { email: ADDRESS, password: 'short', displayName: 'Someone' };

    const accepted = await viewModel.handleSubmit();

    expect(accepted).toBe(false);
    expect(viewModel.errors.password).toBeDefined();
    // The server enforces the same minimum, but telling the user here saves a round
    // trip and an error that arrives after they have moved on.
    expect(signUp).not.toHaveBeenCalled();
  });

  test('an empty address is refused before any request', async () => {
    // An empty field rather than a malformed one, and that is deliberate:
    // `SignInInputSchema`/`SignUpInputSchema` bound the address with `minLength: 3`,
    // not with an email format. So `a@b` — syntactically wrong, and the kind of thing
    // a browser's own `type="email"` validation catches — *passes* these schemas and
    // is refused by the server instead.
    //
    // Which means this file cannot claim the form rejects malformed addresses, and
    // asserting that it does would be asserting a guarantee that lives in the input
    // element rather than here. The browser-side guarantee is proved in
    // `src/browser_tests/`, where a real input element is in the DOM.
    const signUp = mock(() => Promise.resolve());
    const { viewModel } = build({ mode: 'sign-up', signUp });
    viewModel.form = { email: '', password: 'correct horse battery', displayName: 'S' };

    await viewModel.handleSubmit();

    expect(viewModel.errors.email).toBeDefined();
    expect(signUp).not.toHaveBeenCalled();
  });

  test('sign-in accepts a password the current policy would refuse', async () => {
    // An account created under an older, stricter policy must still be able to sign
    // in. Refusing short input at the *sign-in* form would lock those users out of
    // the very page they would use to fix it — which is why `SignInInputSchema`
    // carries no minimum and only this assertion would notice if it changed.
    const signIn = mock(() => Promise.resolve());
    const { viewModel } = build({ signIn });
    viewModel.form = { email: ADDRESS, password: 'old', displayName: '' };

    expect(await viewModel.handleSubmit()).toBe(true);
    expect(viewModel.errors).toEqual({});
    expect(signIn).toHaveBeenCalledTimes(1);
  });
});

describe('switching between sign-in and sign-up', () => {
  test('keeps the address and clears the password', async () => {
    // The common path is "typed an address, then realised it is not signed up yet".
    // Clearing the email makes that a retype; keeping the password in a field after
    // the mode changes is worse.
    const { viewModel } = build();

    viewModel.toggleMode();

    expect(viewModel.isSignUp).toBe(true);
    expect(viewModel.form.email).toBe(ADDRESS);
    expect(viewModel.form.password).toBe('');
  });

  test('clears a previous outcome, so a stale message cannot survive', async () => {
    const { viewModel } = build({
      signIn: () => Promise.reject(serverError('EMAIL_NOT_VERIFIED', 403)),
    });
    await viewModel.handleSubmit();
    expect(viewModel.message).toBeDefined();

    viewModel.toggleMode();

    // Otherwise the user switches to sign-up and is still told to confirm an address.
    expect(viewModel.outcome).toBeUndefined();
    expect(viewModel.message).toBeUndefined();
    expect(viewModel.canResendVerification).toBe(false);
  });
});
