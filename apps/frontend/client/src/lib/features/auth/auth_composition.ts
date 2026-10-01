// apps/frontend/client/src/lib/features/auth/auth_composition.ts
//
// Wiring. See notes_composition.ts for why this file exists.

import { type SessionService, sessionService } from '#lib/services/session_service.svelte.ts';
import { type AuthMode, createAuthViewModel } from './auth_view_model.svelte.ts';

export interface AuthComposition {
  session?: SessionService;
  navigate?: (path: string) => Promise<void> | void;
  mode?: AuthMode;
}

export const getAuthViewModel = (options: AuthComposition = {}) =>
  createAuthViewModel({
    className: 'AuthViewModel',
    ...options,
    session: options.session ?? sessionService,
  });
