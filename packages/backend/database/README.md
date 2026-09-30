# @starter/database

Drizzle schema and migrations for Cloudflare D1 (SQLite).

- `src/lib/schema.ts` is the single source of truth. Row types are derived from
  it with `$inferSelect` / `$inferInsert`; never hand-write a parallel type.
- `drizzle-d1/` holds forward-only generated migrations.
- Generate: `bun run db:generate`. Apply locally: `bun run db:migrate`.

Adding a table:

1. Add it to `src/lib/schema.ts`.
2. `bun run db:generate` (commits the SQL + snapshot).
3. `bun run db:migrate` to apply locally.
4. Add the matching TypeBox schema to `@starter/schemas` if it crosses the wire.

Server-only: importing this from frontend code is a layering violation.
