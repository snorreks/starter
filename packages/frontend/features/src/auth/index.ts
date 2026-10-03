// packages/frontend/features/src/auth/index.ts
//
// The account feature's reusable half.
//
// What is here is the screen's *state* and its controls. What is not here is
// anything about how a host runs a submission without JavaScript: the web
// application's form actions, their origin and rate checks, and the SSR redirects
// live in `apps/frontend/client/src/routes/**`, where the server plane can reach
// them. A native shell has no form actions and must not be given a component that
// pretends to.

export {
  type AccountService,
  createAccountService,
  type PasswordResetInput,
  VERIFICATION_RETURN_PATH,
  type VerificationRequest,
} from './account_service.ts';
export {
  type AuthSession,
  AuthSessionService,
  type AuthSessionServiceOptions,
  SessionState,
} from './auth_session_service.svelte.ts';
export { default as AuthView } from './auth_view.svelte';
export {
  AUTHENTICATED_PATH,
  type AuthMode,
  type AuthOutcome,
  AuthViewModel,
  type AuthViewModelOptions,
} from './auth_view_model.svelte.ts';
export {
  createDeviceAuthorizationService,
  type DeviceAuthorizationEvent,
  type DeviceAuthorizationOutcome,
  type DeviceAuthorizationService,
  type DeviceAuthorizationServiceOptions,
  type Sleeper,
} from './device_authorization_service.ts';
