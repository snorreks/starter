// apps/frontend/client/src/lib/composition/auth.ts
//
// The web application's sign-in wiring.
//
// See `notes.ts` for why this file exists at all: the shared feature ships a
// ViewModel, and constructing one requires the host's session, account endpoints
// and navigation. All three are answered in `session.ts`; this file assembles them
// and applies the one thing only a route knows — the mode and the address the
// server pre-filled.

import { type AuthMode, AuthViewModel } from '@starter/features/auth';
import { accountService, sessionService, webNavigation } from './session.ts';

export interface AuthComposition {
  mode?: AuthMode;
  /**
   * An address to pre-fill.
   *
   * A construction option rather than something a route assigns afterwards, because the
   * first render happens on the server: a value applied in an effect is empty in the
   * server-rendered HTML and correct only after hydration, which shows as a flash of an
   * empty field on the one screen that is trying not to lose what was typed.
   */
  email?: string;
}

export const getAuthViewModel = (options: AuthComposition = {}): AuthViewModel => {
  const viewModel = new AuthViewModel({
    session: sessionService,
    account: accountService,
    navigation: webNavigation,
    mode: options.mode ?? 'sign-in',
  });

  if (options.email !== undefined && options.email.length > 0) {
    viewModel.form.email = options.email;
  }

  return viewModel;
};
