# @starter/database

Drizzle schema and migrations for Cloudflare D1 (SQLite).

## Purpose and runtime

Server code, and the only package that may open a database handle. It runs in
workerd against the `DB` binding, which is why `drizzle-orm` carries the
`worker-runtime` capability in the policy: it is the database implementation, not a
contract.

- `src/lib/schema.ts` is the single source of truth. Row types are derived from it
  with `$inferSelect` / `$inferInsert`; never hand-write a parallel type.
- `drizzle-d1/` holds forward-only generated migrations.

## Setup and configuration

No environment variable. The binding name is `DB`, declared in
`apps/frontend/client/wrangler.jsonc`; the database id is *not* committed — it is
in the git-ignored `.starter/deployment.local.json`, and
`bun run deploy:check` reports which ids are still unset. The `registry-valid`
guard fails the build if a resource id appears as a literal in the registry.

## Commands

From the repository root:

```bash
bun run db:generate   # drizzle-kit generate
bun run db:migrate    # apply to local D1
bun run db:status     # which migrations have been applied
```

From `packages/backend/database`, the generate step is
`bun run --cwd packages/backend/database db:generate` — through the package that
declares `drizzle-kit`, never `bunx`, which would download whatever the registry
serves.

Adding a table:

1. Add it to `src/lib/schema.ts`.
2. `bun run db:generate` (commits the SQL and the snapshot).
3. `bun run db:migrate` to apply locally.
4. Add the matching TypeBox schema to `@starter/schemas` if it crosses the wire.

## Tests and artifacts

`bun test`: the rate limiter's atomic storage is covered here, against a real D1,
because its correctness depends on the installed Better Auth and Drizzle behaviour
rather than on a hand-rolled claim. That is also why this project's `test` script
no longer carries `--pass-with-no-tests` — with a test file present, the flag was
permission for a future test file to be deleted without anything failing.

Artifacts: the SQL files and snapshots under `drizzle-d1/`. Applying them produces
tables, not files.

## Boundaries and documentation

Server-only. Importing this from frontend code is a layering violation, and the
guard reports it as `plane-reachability` or, for a type-only import, as
`server-type-only`.

Migrations are forward-only. There is no down migration and no automatic schema
rollback; a bad release is recovered by deploying a new one — see
[docs/deployment.md](../../docs/deployment.md).

- [docs/cloudflare.md](../../docs/cloudflare.md) — D1, bindings, credentials
- [docs/auth.md](../../docs/auth.md) — why the rate limiter's storage is custom
- [docs/deployment.md](../../docs/deployment.md) — where migrations run in the pipeline
