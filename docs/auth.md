# Authentication

The web Worker uses Supabase Auth and Postgres. It does not select between auth
providers or adapt obsolete provider payloads. The native host uses the same
Supabase identity boundary, with a bearer transport and its own platform storage.

## Request identity and ownership

`apps/frontend/client/src/hooks.server.ts` creates one verified identity and one
set of application services for each request. Configuration comes from the
validated container; request Host headers do not choose the public auth origin.

`apps/frontend/client/src/lib/server/supabase_context.ts` composes the user-scoped
Data API client and repositories. The service-role client is server-only and is
not a substitute for a caller's token on ordinary ownership reads. Postgres RLS
and RPC ownership checks protect notes, conversations, messages and jobs.

The shared `SessionUserSchema` is a closed application DTO with a UUID subject,
email, display name, application account category and verification state. Both
web and native reject unknown identity fields and obsolete provider-shaped
payloads. The `provider` field describes the application account category, not
which OAuth provider authenticated a native session.

No identity or request collaborator is cached as module-level mutable state.
`locals.user` and the repositories are rebuilt for every request.

## Account lifecycle

The HTTP adapter is `apps/frontend/client/src/routes/api/auth/[...all]/+server.ts`.
Server form actions call the account service directly, rather than fetching the
application's own origin. Both paths use the container's configured public origin.

The account service in `packages/backend/auth/src/supabase/account.ts` provides
sign-up, sign-in, sign-out, verification resend, password recovery/reset, email
change and account deletion. Recovery requests do not disclose whether an address
exists. Account deletion requires a verified Supabase identity.

Verification and recovery callbacks pass through `/auth/callback`. Only
`/verify-email` and `/reset-password` are permitted next paths; an arbitrary URL
is refused before exchanging a code or writing session cookies. Provider cookie
writes and cache-control headers are forwarded on success and failure.

Supabase owns its token, session and authentication rate-limit semantics. The
removed D1 limiter's budgets, replay rules and revocation behavior are not claims
about this provider. Email confirmation and redirect allowlists must be configured
on the Supabase project. Native OAuth configuration and platform requirements are
recorded in `apps/frontend/native/README.md`.

## Mail and configuration

Supabase auth mail integrates through the configured server mail hook and transport.
Local fixtures capture mail; hosted delivery requires explicit configuration.
Do not treat a successful local capture as evidence of Resend delivery or DNS setup.
No service-role credential, mail secret or provider token belongs in browser output.

`apps/frontend/client/src/lib/server/container.ts` validates the server configuration.
Deployed environments must state their public origin instead of accepting it from
a request. A missing required binding is a named configuration failure.

## Validation and schema changes

- `bun run test` checks schemas, services and route contracts.
- `bun run test:database` exercises real local Postgres, Auth, Data API, RLS and RPCs.
- `bun run test:worker` drives the built Worker; `bun run e2e` drives a real browser.
- Add new SQL migrations under `supabase/migrations/`; do not rewrite applied ones.
  Regenerate database types with `bun run db:types` and compare with
  `bun run db:types:check`.

These commands name missing prerequisites rather than silently skipping. Current
counts and evidence belong in [the capability matrix](capability-matrix.md), not
in hand-maintained copies here. Hosted Supabase configuration, real Resend delivery,
distributed production traffic and physical native-device flows require separate
live verification; local or fixture checks do not prove them.
