// apps/frontend/client/src/lib/views/auth/auth_composition.ts
//
// Wiring. See notes_composition.ts for why this file exists.

import { sessionService, type SessionService } from '#lib/services/session_service.svelte.ts';
import { createAuthViewModel, type AuthMode } from './auth_view_model.svelte.ts';

export type AuthComposition = {
  session?: SessionService;
  navigate?: (path: string) => Promise<void> | void;
  mode?: AuthMode;
};

export const getAuthViewModel = (options: AuthComposition = {}) =>
  createAuthViewModel({
    className: 'AuthViewModel',
    ...options,
    session: options.session ?? sessionService,
  });
