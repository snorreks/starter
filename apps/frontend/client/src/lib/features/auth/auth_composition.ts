// apps/frontend/client/src/lib/features/auth/auth_composition.ts
//
// Wiring. See notes_composition.ts for why this file exists.

import { sessionService } from '#lib/services/session_service.svelte.ts';
import { goto } from '$app/navigation';
import { type AuthMode, AuthViewModel } from './auth_view_model.svelte.ts';

export interface AuthComposition {
  session?: typeof sessionService;
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
  /** Injectable for tests; defaults to SvelteKit's router. */
  navigate?: (path: string) => Promise<void> | void;
}

export const getAuthViewModel = (options: AuthComposition = {}): AuthViewModel => {
  const viewModel = new AuthViewModel({
    session: options.session ?? sessionService,
    mode: options.mode ?? 'sign-in',
    navigate: options.navigate ?? ((path: string) => goto(path)),
  });

  if (options.email !== undefined && options.email.length > 0) {
    viewModel.form.email = options.email;
  }

  return viewModel;
};
