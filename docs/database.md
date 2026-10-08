# Database

Supabase Postgres is the sole application database. Ordered SQL files in `supabase/migrations/` define schema, constraints, grants, RLS policies and transactional RPCs. `packages/backend/database/src/supabase/database.types.ts` is generated from a fresh local reset and checked against those migrations.

## Access model

The Data API exposes only the application relations protected by RLS. Internal job, generation and maintenance state lives in the unexposed `private` schema. User clients are request scoped and carry a verified access token. Service role access stays in server operations and fixed RPCs; it is not a general browser or native capability.

Repository adapters return explicit DTO projections rather than database rows. Multi-step operations that require atomicity use SQL RPCs with fixed search paths, explicit grants, authenticated identity checks and concurrency controls.

## Local setup and commands

The local stack uses real Postgres, Supabase Auth, Data API and Mailpit containers. Docker or Podman is required. Each run owns a unique project id, API/database/Studio/mail ports and lifecycle token; one run cannot reset another run's stack.

```bash
bun run setup:doctor -- --profile database
bun run test:database
bun run db:types
bun run db:types:check
bun run db:migrate
bun run db:status
```

`db:types:check` writes temporary output and compares it without changing the tracked type file. The database lane refuses nonzero when its engine is missing; credential free unit tests do not start Docker.

See [packages/backend/database/README.md](../packages/backend/database/README.md), [docs/testing.md](testing.md), and [docs/deployment.md](deployment.md).
