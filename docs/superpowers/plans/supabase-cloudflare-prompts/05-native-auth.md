# Prompt 05 — Native Supabase PKCE and secure session lifecycle

Implement only Prompt 05 from the migration plan; read its common contract, spec, and 03 handoff. Create one Herdr worktree and one PR.

**Branch:** `feat/supabase-05-native-auth`. **Requires:** 03 merged. **Budget:** target 30–55 paths, maximum 99. **Parallel:** with 04 and 06. Own shared auth/session-store changes; coordinate HTTP pagination compatibility with 04 through its exported contracts.

## Files and scope

- Create `apps/frontend/native/src/lib/platform/supabase_auth.ts` and tests; adapt `bearer_transport.ts`, lifecycle modules, `vault_session_store.ts`, Stronghold integration, and native composition.
- Update `packages/frontend/platform/src/session_store.ts` and tests for a versioned credential record; update shared auth facades only against 03's frozen contract.
- Update Tauri capabilities/config/Rust bridge where the supported deep-link integration requires it; keep platform APIs confined to the native bridge role. Update native doctor/artifact checks and platform docs.
- Keep legacy native implementation selectable until 08 so intermediate default behavior remains complete. The Supabase native profile must be tested explicitly and cannot fall back.

## Contracts

Persist `{version:1, accessToken, refreshToken, expiresAt, accountId, supabaseProjectRef, apiOrigin}` through the secure store only when enabled. Scope to environment/project/origin/account. Memory is the default; no plain localStorage fallback. Recognize older vault records as incompatible with a clear reauthentication outcome; never reinterpret a legacy bearer string as a refresh token.

Supabase auth uses external-browser PKCE and allowlisted web/native callbacks. The runtime transport reads the current access token on each request. Refresh is single-flight; logout/account/environment switch invalidates late completions. Keep refresh secrets out of URLs, logs and artifacts. Use actual Supabase logout/revocation semantics: JWT verification alone does not promise instant access-token revocation.

## Sequence and checks

- [ ] Add fixtures for wrong environment/project/account, expired token, invalid/reused callback, unavailable/unlocked/locked vault and legacy credential migration.
- [ ] Add deferred refresh race tests: `logout()` followed by late refresh must leave both memory and store empty; concurrent requests trigger one refresh; changing project invalidates the prior attempt.
- [ ] Implement PKCE callback handling, refresh/session facade, persistence and current-token bearer transport. Preserve DTO/byte/stream behavior under the same host policy.
- [ ] Test real local Supabase native-auth exchange using an owned browser callback harness; simulate lifecycle separately from actual OS deep links. A browser harness is not device evidence.
- [ ] Assert foreign destinations never receive credentials and callback URLs cannot override deployment scope. Recheck Tauri capability/CSP changes against emitted artifacts.
- [ ] Ensure the native notes/jobs paths work against the Supabase preview Worker; handle 04 cursor-envelope changes through stable feature adapters. Do not add web remote function imports.
- [ ] Run native/platform/auth tests, native package typecheck and `check:bundle`/artifact checks, whole-repo guard, lint and format. Run supported native CI builds/emulator lanes with actual prerequisites; record physical-device PKCE/vault checks as NOT RUN if absent.
- [ ] Run the PR-budget command and create one PR. Do not remove web legacy auth routes or publish installers/stores.

## Handoff

Record credential format and invalidation behavior, allowlisted callbacks, OS capability changes, exact CI/manual commands and device observations. 07 must consume these callback/project/origin fields through the resolved target; it cannot independently invent native destinations.
