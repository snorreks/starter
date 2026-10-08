# Supabase application identity and data

Supabase is the sole application identity and data backend. The browser uses the public publishable key; server requests validate Supabase Auth sessions and use request-scoped clients with the caller JWT for RLS. A separate service-role client exists only in server code for operations that require administrative access. Missing URL, publishable key, or service-role key fails application setup explicitly. There is no backend selector or legacy authentication fallback.

## Request boundary

`@starter/auth/supabase` verifies bearer tokens and SSR cookie sessions through Supabase Auth. Server request composition builds the identity, user-scoped data clients, and services for that request. The access token and service-role key stay in server-only modules. Shared DTOs use UUID user ids and named schemas for resource ids.

The account lifecycle covers email signup and verification, sign-in, sign-out, password recovery, password reset, and account deletion. Local confirmation mail is captured by the Supabase development stack; deployed mail uses Resend and missing credentials fail readiness. Auth responses avoid disclosing whether an email address exists.

## Local verification

```sh
bun run test:browser
bun run test:worker
bun run e2e
bun run test:database
```

The browser lane exercises the real Svelte UI. Worker integration and E2E start an owned local Supabase stack and use a built Worker; database integration exercises migrations, Postgres, Auth, Data API/RLS and concurrent RPCs. These commands require a Docker-compatible runtime. Teardown is scoped to each run's ownership record. Hosted Supabase and Resend behavior are NOT RUN by these local checks.

See [auth.md](auth.md), [database.md](database.md), and [testing.md](testing.md).
