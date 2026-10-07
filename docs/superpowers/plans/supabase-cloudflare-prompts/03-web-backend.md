# Prompt 03 — Supabase web identity and application services

Implement only Prompt 03 from the migration plan; read its common contract, spec, and merged 01/02 handoffs. Create one Herdr worktree and one PR.

**Branch:** `feat/supabase-03-web-backend`. **Requires:** 01 and 02 merged. **Budget:** target 65–90 paths, hard maximum 99. This is the shared-contract gate before parallel web/native/compute work.

## Files and scope

- Create `packages/backend/auth/src/supabase/{identity,account}.ts` and tests, exported separately from the retained legacy factory.
- Adapt `apps/frontend/client/src/lib/server/{container,request_context,env,notes_service,chat_service,jobs_service}.ts`, `hooks.server.ts`, `app.d.ts`, page-server loads, HTTP adapters, and web auth routes/composition.
- Add server `supabase_context.ts` for request-scoped client/cookie handling and a temporary complete backend selector. Add auth callback route and local mail-capture adaptation.
- Update `packages/frontend/features/src/auth/` facade contracts and web composition only where required. Freeze these interfaces for 05; leave native-specific implementation to that prompt.
- Extend built Worker/E2E harness, root scripts/CLI argument forwarding and owning package entrypoints with an explicit Supabase preview profile and mandatory test selection. Do not remove the functioning legacy default yet. Root `--backend` options must be handled by the harness, never passed as unsupported Bun-test flags or silently ignored by Moon.

## Interfaces to freeze

Produce `getVerifiedIdentity(request, cookies)` and `createApplicationServices(identity, config)` as stated by the spec; write their exact implemented signatures and errors in the PR handoff. Application services expose notes/chat/jobs operations; route/load code must not select databases independently or self-fetch its origin.

Use official request-scoped Supabase SSR clients, verified claims/fresh users as appropriate, refresh-cookie/header propagation, and user-scoped database clients. Separate administrative clients. Authentication facade methods preserve existing frontend feature behavior while allowing a Supabase implementation. A Supabase preview token must never authenticate against legacy D1 and vice versa.

## Sequence and verification

- [ ] Add failing fixtures for two concurrent SSR identities, spoofed/expired bearer tokens, refresh-cookie propagation, missing preview configuration, and accidental cross-backend identity reuse.
- [ ] Implement explicit complete preview composition. Verify the browser output contains no Supabase administrative key or Google credentials.
- [ ] Implement sign-up/sign-in/verification/recovery/reset/logout/account deletion using Supabase Auth and local captured mail. Reject off-allowlist callback destinations and preserve enumeration-resistant responses. Test email-change/account-deletion behavior against the actual selected SDK semantics.
- [ ] Test a refreshed SSR response carries required `Set-Cookie`/cache headers; authenticated output is private/no-store. Test concurrent requests do not share a Supabase session client. Supported SSR cookies need not retain Better Auth's old HttpOnly assumptions; follow the actual Supabase model.
- [ ] Wire notes/chat/jobs user operations to 02 repositories with validated DTOs. Keep old endpoint envelopes while establishing owner-safe Postgres behavior; 04 owns cursor API changes. Preview jobs use Postgres admission/status even if dispatch is explicitly disabled pending 06.
- [ ] Use real local Auth/Postgres in `bun run test:worker -- --backend supabase` and `bun run e2e -- --backend supabase`; add these arguments as explicit uncached backend selections with isolated stack lifecycles, not ignored flags. The preview suite is required and must discover tests.
- [ ] Run local browser auth journeys, cross-user SSR/API tests, `bun run test:database`, `bun run typecheck`, `bun run lint`, `bun run format`, `bun run guard:whole-repo`, `bun run build`, and `bun run check:bundle`. Preserve functioning legacy checks until 08.
- [ ] Freeze shared facade/context/repository signatures, run the PR-budget command, and create one PR. No hosted Auth configuration or remote deployment.

## Handoff

List the exact cookie/identity/context/session/account service APIs, preview selector, commands and mail harness, auth callback rules, and jobs capability state. 04/05/06 must consume these APIs without inventing parallel identity resolvers. Explicitly identify external SMTP/hosted Auth checks as NOT RUN.
