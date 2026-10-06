# @starter/client

The one application: a SvelteKit app whose server half is a Cloudflare Worker and
whose browser half is the same app's pages. One origin serves the HTML, the assets
and the public authenticated API. There is no second API service and no proxy.

## Build artifact

`bun run build` runs Vite plus pinned Wrangler in credential-free dry-run mode.
It closes the adapter's SSR imports into `.svelte-kit/cloudflare/_worker.js` before
Moon caches or the release checker hashes that artifact. Only platform imports may
remain; generated remote configs upload it without re-bundling. Intermediate SSR
trees are not deployment dependencies. Worker code and source maps are excluded
from public assets and covered by real workerd regression checks.

## Runtime and layout

| Path | Plane | What lives there |
|---|---|---|
| `src/hooks.server.ts` | server | The composition root. Builds the container, builds **one** request context, applies cache policy, writes one record per served request. |
| `src/lib/server/` | server | Bindings container, request context, telemetry ingestion, health/readiness, mail, auth helpers. May import `@starter/database` and `@starter/auth`. Nothing else may. |
| `src/lib/composition/` | browser | The composition roots. The only place that knows which transport, navigation and session this host has; every feature collaborator comes from here. |
| `src/routes/**/+server.ts` | server | API adapters: bound body, validated, mapped to a response. |
| `src/routes/**/+page.svelte` | browser | Presentation. Excluded from the server permission set on purpose. |

The notes screen, the account screen and the sample-encode screen themselves live in
`packages/frontend/features`, because two hosts render them; this application is
the composition root for one of them. See that package's README for the contracts
it requires.

### `/jobs`, and the one capability this app may not have

`/jobs` renders the shared jobs screen. Its server load calls
`locals.container.jobs` **directly** — not `fetch('/api/jobs')` — for the same
reason `notes/+page.server.ts` calls the notes service: a server load that
HTTP-fetches its own origin is a second, differently authenticated path to the same
data.

The load also asks about the deployment mode before it reads. `JOBS_PROFILE` is
explicitly `disabled` in this repository's default `wrangler.jsonc`; in that case the load reports the capability and the page renders "jobs
are switched off here" from the HTML, without making a request it already knows the
answer to. `bun run e2e` asserts both halves: the state renders, and the page issues
**no** `/api/jobs` request at all.

Two endpoints back it, both owner-checked and both closed DTOs:

| Endpoint | Answers |
|---|---|
| `GET /api/jobs`, `POST /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/:id/output` | the owner's jobs, admission, and a streamed artifact |
| `GET /api/jobs/maintenance` | the latest maintenance run and the latest **scheduled** run, separately |

Two fields rather than one on the maintenance read, because collapsing them is how a
manual trigger gets reported as a natural scheduled firing.

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

## What a deploy of this app touches

One Worker, one database, one origin — plus, when the compute profile is on, a second
Worker and a private bucket. `resolveTarget(environment)` in
`scripts/src/deploy/target.ts` resolves all of them together, and the offline plan
prints every one of them before anything is mutated, because a plan that named only
the web Worker would be approving something the pipeline then does not do.

`wrangler.jsonc` is the canonical binding source for both the build and the dev
runtime, so local and deployed cannot disagree; and `migrationStep` compares the
database id Wrangler would actually reach against the resolved one, because both
commands name the binding `DB` and the argv alone cannot tell two databases apart.

See [docs/deployment.md](../../../docs/deployment.md).

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

None for `bun run dev`. It used to answer 500 on every request, because
`@starter/utils` had a TypeScript parameter property and Node — which loads the
packages' TypeScript source directly — strips types without transforming them.
`noParameterProperties`, `noEnum` and `noNamespace` are now `error` in `biome.json`, so
that class of failure is refused at the file that introduces it. See `docs/lint.md` and
`docs/capability-matrix.md`.

The one warning `bun run dev` still prints is
`config_option_deprecated_alias`: `#lib` is spelled as a SvelteKit `alias` entry rather
than a `package.json` `imports` map, because the `imports` form resolves in Vite and
Node and then reports `Cannot find module '#lib/…'` for every import under
`svelte-check`. The reason is written down at the alias in `vite.config.ts`.

## Boundaries

May import `@starter/ui`, `@starter/schemas`, `@starter/utils`. Only the `server`
rows of the table above may import `@starter/database` and `@starter/auth` — even as
a type. A `+page.server.ts` calls `#lib/server/…` directly and never fetches its own
origin: a round trip from inside the process that serves `/api` is a second,
differently authenticated path to the same data.

A relative path that leaves this workspace is refused by `bun run guard`, because it
skips both the `exports` map and the dependency list; the one declared exemption is
`vitest.config.ts` reaching `scripts/src/shared/browser_path.ts`, and the guard
reports that row if nothing uses it any more.

## Canonical docs

[architecture](../../../docs/architecture.md) · [auth](../../../docs/auth.md) ·
[cloudflare](../../../docs/cloudflare.md) · [logs](../../../docs/logs.md) ·
[testing](../../../docs/testing.md) · [deployment](../../../docs/deployment.md)