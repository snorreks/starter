# @starter/auth

Supabase Auth server integration for the web application.

## Purpose and runtime

This package contains request scoped Supabase Auth helpers. The application identity is a Supabase UUID. The web Worker verifies each bearer token and constructs a request scoped user client; privileged service role clients stay on the server.

The package does not implement password hashing, sessions, token signing or a parallel identity store. Browser and native clients use the public Supabase URL and publishable key. Administrative keys are server only.

## Commands

From `packages/backend/auth`:

```bash
bun run typecheck
bun run lint
bun run test
```

Authentication flows are exercised through the web Worker, local Supabase and browser lanes. A project with no configured hosted OAuth provider does not claim a live provider exchange.

## Setup

Run `bun install` from the repository root. Local auth integration requires Docker or Podman through the Supabase CLI.

## Validation

Run `bun run test` here for package tests and `bun run test:database` from the repository root for local Supabase Auth and Postgres behavior.

## Boundaries

Server only. It may import `@starter/database` and `@starter/schemas`; browser modules may not import this package. See [docs/auth.md](../../../docs/auth.md), [docs/native.md](../../../docs/native.md), and [docs/secrets.md](../../../docs/secrets.md).
