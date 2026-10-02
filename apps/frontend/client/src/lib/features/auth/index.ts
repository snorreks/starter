// apps/frontend/client/src/lib/features/auth/index.ts
//
// The account feature's public surface.

export { type AuthComposition, getAuthViewModel } from './auth_composition.ts';
export { default as AuthView } from './auth_view.svelte';
export {
  AUTHENTICATED_PATH,
  type AuthMode,
  type AuthOutcome,
  AuthViewModel,
} from './auth_view_model.svelte.ts';
