# @starter/client

The one application: a SvelteKit app whose server half is a Cloudflare Worker and
whose browser half is the same app's pages. One origin serves the HTML, the assets
and the public authenticated API. There is no second API service and no proxy.

## Runtime and layout

| Path | Plane | What lives there |
|---|---|---|
| `src/hooks.server.ts` | server | The composition root. Builds the container, builds **one** request context, applies cache policy, writes one record per served request. |
| `src/lib/server/` | server | Bindings container, request context, telemetry ingestion, health/readiness, mail, auth helpers. May import `@starter/database` and `@starter/auth`. Nothing else may. |
| `src/lib/features/`, `src/lib/services/` | browser | View → ViewModel → service, with injected transport. |
| `src/routes/**/+server.ts` | server | API adapters: bound body, validated, mapped to a response. |
| `src/routes/**/+page.svelte` | browser | Presentation. Excluded from the server permission set on purpose. |

The plane boundary is enforced twice — Biome's import rules and `bun run guard` —
because a convention nobody checks is a comment.

## Setup and configuration

Bindings live in `wrangler.jsonc`, which the adapter reads for **both** the build and
the dev runtime, so local and deployed cannot disagree. `DEPLOYMENT_ENV` decides
whether development defaults are permitted; it is never inferred from a URL, and
missing is an error rather than a default. `RELEASE` is injected by the deploy step
and is what `/health` reports.

Secrets are handled through SOPS (`bun run secrets:doctor`); no secret is committed
and none is written to a remote environment by this repository's own commands.

## Commands

Run from the repository root unless noted.

```bash
bun run dev                 # vite dev, Node, emulated bindings (see known gaps)
bun run dev:worker          # the BUILT Worker in real workerd; needs a build first
bun run build               # vite build -> .svelte-kit/cloudflare/
bun run check:bundle        # asserts the artifact and that server code stayed server-side
bun run test                # unit lane for this package
bun run test:browser        # real Svelte in Chromium
bun run test:worker         # built Worker in workerd against real local D1
bun run typecheck           # svelte-check --threshold error
bun run lint                # biome lint src
```

## Lanes and what they need

| Lane | Needs | Symptom when absent |
|---|---|---|
| `dev`, `test`, `test:browser` | `bun install`, Chromium (`bun run setup`) | missing shared libraries |
| `dev:worker`, `test:worker`, `e2e` | `node` on `PATH`, a completed `bun run build` | `env: 'node': No such file or directory` |

## Artifacts

`.svelte-kit/cloudflare/` holds the built Worker (`_worker.js`) and assets. It is
what `bun run deploy:apply` publishes after validating it, and what the worker and E2E
lanes drive. `bun run check:bundle` is the check that it is deployable at all.

## Known gaps

`bun run dev` currently fails on `main` with
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` from a TypeScript parameter property in
`@starter/utils`, because Node strips types without transforming them. `bun run
dev:worker` and every test lane are unaffected. See `docs/capability-matrix.md`.

## Canonical docs

[architecture](../docs/architecture.md) · [auth](../docs/auth.md) ·
[cloudflare](../docs/cloudflare.md) · [logs](../docs/logs.md) ·
[testing](../docs/testing.md) · [deployment](../docs/deployment.md)