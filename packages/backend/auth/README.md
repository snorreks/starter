# @starter/auth

Better Auth, bound to D1 through the Drizzle adapter.

## Purpose and runtime

Server code. It runs in workerd, because it owns sessions, password hashing and
the database adapter — none of which a browser may reach, even as a type.

**Enabled:** email and password, the D1-backed rate limiter, verification and
recovery.

**Not enabled (and not advertised in the UI):** OAuth providers, custom JWTs.
Enabling any of them is a deliberate change: the schema, the client screens and
the E2E expectations all assume the current surface, and a half-wired provider
produces confusing partial failures.

Adding a provider means adding its credentials to the Worker's secrets, adding the
origin to `trustedOrigins`, and adding a client screen — in that order.

## Setup and configuration

Everything is a Worker binding or a secret; nothing is configured per-project.

- The D1 binding name is `DB`, declared in `apps/frontend/client/wrangler.jsonc`
  and read through that app's container. Local development gets the same binding
  set through the adapter's platform proxy, so a fresh clone reaches a working
  login without an account.
- `AUTH_SECRET` is read from the environment at runtime. `bun run setup` writes a
  development value from the example file; a deployed environment installs its own
  through `bun run secrets:*` or the deployment plan. The `registry-valid` and
  `secret`-reading guards fail the build on a literal committed secret.

## Commands

From `packages/backend/auth`:

```bash
bun run typecheck
bun run lint
bun run test       # bun test --pass-with-no-tests
```

From the repository root, migrations are generated and applied through the
database project — this project owns no migration files.

## Tests and artifacts

`bun test --pass-with-no-tests`: this project currently has no test file of its own
and says so rather than printing a green run that asserted nothing. Its behaviour
is covered from the outside — the Worker integration lane signs up, verifies,
recovers a password, signs out and asserts the session is gone, and the E2E lane
drives the same paths through a real browser.

Artifacts: the `session`, `account`, `verification` and rate-limit tables in D1.
Apply them with `bun run db:migrate`.

## Boundaries and documentation

May import `@starter/schemas` and `@starter/database`. May not be imported by any
browser module: `ruleServerTypeOnlyBoundary` refuses even an `import type` of this
package from a `browser`-plane file, because the browser's compile-time surface
tied to a private server entity is one value import away from a bundle leak. The
wire shape belongs in `@starter/schemas`.

- [docs/auth.md](../../docs/auth.md) — the account lifecycle, the D1 rate limiter, and mail
- [docs/cloudflare.md](../../docs/cloudflare.md) — bindings and credentials
- [docs/secrets.md](../../docs/secrets.md) — SOPS, and what never goes in the repository
