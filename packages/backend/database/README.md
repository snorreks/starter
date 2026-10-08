# @starter/database

Supabase Postgres clients and repository adapters for the application.

## Purpose and runtime

Server only. SQL migrations under `supabase/migrations/` define tables, RLS, grants and transactional RPCs. Generated types in `src/supabase/database.types.ts` are derived from a fresh local migration reset. Repository adapters project database rows into shared DTOs.

User clients carry a verified request token and rely on RLS. Service role clients are reserved for server owned operations and never enter browser or native artifacts. Jobs and maintenance use fenced RPCs; the `private` schema is not exposed through the Data API.

## Setup and commands

Local Supabase requires Docker or Podman. The root tooling allocates a unique project id and API, Postgres, Studio and Mailpit ports for each run.

```bash
bun run test:database
bun run db:types
bun run db:types:check
bun run db:migrate
bun run db:status
```

`db:types:check` regenerates into a temporary file and compares without overwriting the committed types. Use the package's pinned Supabase CLI; do not run `bunx` for stateful tools.

## Tests and boundaries

Unit tests cover adapter projection and request behavior. `test:database` is the real local Postgres/Auth/Data API lane and refuses with a named Docker prerequisite when unavailable. It verifies cross-user denial, concurrent transactional admission, retries, leases, fencing, maintenance and retention.

The package is server only. See [docs/database.md](../../../docs/database.md), [docs/auth.md](../../../docs/auth.md), and [docs/deployment.md](../../../docs/deployment.md).
