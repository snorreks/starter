# @starter/database

Supabase Postgres clients and repository adapters for the application.

## Purpose and runtime

Server only. SQL migrations under `supabase/migrations/` define tables, RLS, grants and transactional RPCs. Generated types in `src/supabase/database.types.ts` are derived from a fresh local migration reset. Repository adapters project database rows into shared DTOs.

User clients carry a verified request token and rely on RLS. Service role clients are reserved for server owned operations and never enter browser or native artifacts. Jobs and maintenance use fenced RPCs; the `private` schema is not exposed through the Data API.

## Setup and commands

The local stack uses real Postgres, Supabase Auth, Data API and Mailpit containers. Docker or Podman is required. Each run owns a unique project id, API/database/Studio/mail ports and lifecycle token; one run cannot reset another run's stack.

```bash
bun run setup:doctor -- --profile database
bun run test:database
bun run db:types
bun run db:types:check
bun run db:migrate
bun run db:status
```

`db:types:check` regenerates into a temporary file and compares without overwriting the committed types. Use the package's pinned Supabase CLI; do not run `bunx` for stateful tools.

## Tests and boundaries

Unit tests cover adapter projection and request behavior. `test:database` is the real local Postgres/Auth/Data API lane and refuses with a named Docker prerequisite when unavailable. It verifies cross-user denial, concurrent transactional admission, retries, leases, fencing, maintenance and retention.

## Access model

Supabase Postgres is the sole application database. The Data API exposes only application relations protected by RLS. Internal job, generation and maintenance state lives in the unexposed `private` schema. User clients are request scoped and carry a verified access token. Service role access stays in server operations and fixed RPCs; it is not a general browser or native capability.

Multi-step operations that require atomicity use SQL RPCs with fixed search paths, explicit grants, authenticated identity checks and concurrency controls. The database lane refuses nonzero when its engine is missing; credential-free unit tests do not start Docker.

The package is server only. See [docs/auth.md](../../../docs/auth.md), [docs/testing.md](../../../docs/testing.md), and [docs/deployment.md](../../../docs/deployment.md).
