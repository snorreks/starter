# apps/backend/jobs — the durable compute Worker

## Purpose and runtime

One Cloudflare Worker that owns the durable half of the compute example: two
Workflows, one container Durable Object, and the hourly maintenance sweep.

```text
web Worker (public router, sessions)
  POST /api/jobs ──► ENCODE_WORKFLOW binding ──► EncodeWorkflow
                                             ├─► D1      (job state, fencing)
                                             ├─► CONTAINER Durable Object ──► FFmpeg container
                                             └─► R2      (fixtures in, artifacts out)

cron 17 * * * * ─► MAINTENANCE_WORKFLOW ──► MaintenanceWorkflow (one run per slot)
```

| Export | Invoked by | Runtime |
|---|---|---|
| `EncodeWorkflow` | a deterministic instance id, from the web Worker or from this Worker's own recovery pass | workerd |
| `MaintenanceWorkflow` | the `schedules` entry in `wrangler.jsonc`, or an operator | workerd |
| `EncodeContainer` | a Durable Object stub, once per job | workerd + one container |

The Worker has **no HTTP API**. The default handler answers `404` to everything,
so "this Worker has no REST surface" is true by construction rather than by the
absence of a route nobody has written yet. The jobs API belongs to the web Worker,
which owns the session and the authorization check.

## Setup and configuration

Prerequisites: Bun (pinned in `config/toolchain.json`), Node on `PATH`, and — for
the compute lane only — a running Docker-compatible engine.

Everything is declared in [`wrangler.jsonc`](./wrangler.jsonc):

| Binding | What it is | Where it comes from |
|---|---|---|
| `DB` | the shared, environment-isolated D1 database | the same database the web Worker binds |
| `MEDIA` | the private R2 bucket: named fixtures and encoded artifacts | never public, no key handed to the container |
| `ENCODE_WORKFLOW` | the encode Workflow | bound by the web Worker across Workers |
| `MAINTENANCE_WORKFLOW` | the maintenance Workflow, scheduled `17 * * * *` UTC | schedule declared per environment |
| `CONTAINER` | one Durable Object per job | the only component allowed to reach the container |
| `PROCESSOR_ORIGIN` | optional: a processor this Worker does not run itself | absent in the shipped config |

The compute profile is `JOBS_PROFILE`. It is `disabled` at the top level and
`encode` in the `[env.staging]` and `[env.production]` sections — the same sections
that declare the schedule, so "compute is on" and "maintenance runs hourly" are one
configuration decision rather than two.

### Deploying this Worker

Every identity it needs is resolved by one function, `resolveTarget(environment)` in
`scripts/src/deploy/target.ts`, and it covers this Worker as well as the web one:
`jobsWorkerName`, `mediaBucketName`, `encodeWorkflowName`, `maintenanceWorkflowName`,
`containerImage`, `imageProtocol`, `containerProfile` and `jobsProfile`.

```bash
bun run deploy:configure -- --env staging --jobs-worker starter-jobs-staging \
  --media-bucket starter-media-staging --image-protocol sample-v1 \
  --container-profile basic --jobs-profile encode
```

`resolveTarget` refuses, before anything is mutated, when the profile is `encode` and
the image, bucket or protocol is missing — a profile that admits jobs which can never
complete is worse than one that does not offer them. And it refuses when two
environments resolve to the same jobs Worker, bucket or Workflow identity: staging's
maintenance sweep would then delete production's output.

Resource ids are not committed. `bun run deploy:configure` writes them into the
gitignored overlay, `bun run deploy:check` reports what is still unset, and CI reads
the same values from a **repository**-scoped variable because its plan job has no
environment and therefore no secrets.

This Worker is deployed **before** the web Worker, so the public origin is never live
pointing at a binding that does not resolve. `--only jobs` runs exactly that part.
See [docs/deployment.md](../../../docs/deployment.md) for the ordering, the release
record and the rollback limits, and [docs/compute.md](../../../docs/compute.md) for
what this example demonstrates and when it is the wrong tool.

## Commands

Run from `apps/backend/jobs` unless the row says otherwise.

| Command | What it does |
|---|---|
| `bun run build` | bundles `src/index.ts` into `dist/index.js` with Bun — the artifact a deploy ships |
| `bun run test` | unit lane: `src/**/*.test.ts`. No Docker, no runtime, no database |
| `bun run test:compute` | **the compute lane**: the built Worker in the real local runtime, real D1 and R2, and the real FFmpeg image |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` / `format` / `fix` | Biome, through this project's own `package.json` |
| `bun run dev` | the built Worker under `wrangler dev`, with the processor container beside it |
| `moon run jobs-worker:test-compute` | the same lane from the repository root |
| `bun run test:all` (root) | every lane; the compute lane is deliberately **not** in it |

## Validation

| Lane | What it proves | Count |
|---|---|---|
| `bun run test` | key derivation, refusal classification, the streaming hash against `crypto.subtle`, the processor protocol against a real local server, and the committed schedule configuration | 31 tests |
| `bun run test:compute` | a real dispatch returns before the encode finishes; the Workflow finishes afterwards with real FFmpeg output in real R2; retries, fencing, terminal refusals, maintenance counts and recovery | 17 tests |

The compute lane requires Docker and **fails with a named prerequisite message**
when it is missing. It is never cached and never part of `bun run test:all`.

What the compute lane proves, and what it cannot:

* **Proved:** the local Workflows engine, Durable Objects, local D1 and R2, the
  processor protocol, the byte and integrity checks, the retry policy and the
  maintenance counts.
* **Not proved:** Cloudflare's managed container runtime. The local runtime has no
  `ctx.container`, so the lane starts the real image with Docker and points the
  Durable Object at it through `PROCESSOR_ORIGIN`. The bytes and the protocol are
  real; the container lifecycle is Docker's.
* **Not proved:** a natural scheduled firing. The local runtime cannot deliver a
  cron event to a Workflow binding's `schedules`; the manual invocation path is
  exercised here and the trigger branch is unit-tested. Genuine scheduled evidence
  is a deployed environment's.

## Boundaries

* It may import `@starter/schemas`, `@starter/jobs`, `@starter/utils` and other
  `packages/shared` / `packages/backend` modules.
* It may **not** import `apps/frontend/client/**`. The jobs Worker must run
  maintenance without the web application — importing it would drag SvelteKit into
  a Worker that has no routes.
* `scripts/` and `tests/` run on Node and Bun, not in workerd; `bun run guard`
  enforces the split.
* `EncodeContainer` declares **no** `DB` and no `MEDIA`. The container this object
  controls holds no account credential, no R2 key and no database handle.
* The container has no public route and no credentials of its own: bytes arrive on
  the request and leave on the response.

## The shape of one encode

1. `admit` claims the job's lease. A refusal means another attempt owns it, or the
   job is already terminal — both end this instance without work.
2. `encode` reads the named fixture from private R2, sends the bounded bytes
   through the Durable Object port, and streams the answer to an **attempt-scoped**
   key while hashing it.
3. `commit` re-reads the stored object's size and only then writes the fenced
   success. A superseded attempt's commit matches no rows.
4. `cleanup` releases the container, so the instance stops after the work rather
   than waiting out its idle timeout.

Retries: only `encode` retries, twice, and only for refusals the processor calls
retryable. Invalid media, an unknown preset and a protocol mismatch are terminal
and cost one container start.

## Related

* [`packages/backend/jobs`](../../../packages/backend/jobs/README.md) — job state,
  admission, fencing and the maintenance services this Worker runs.
* [`apps/backend/media`](../media/README.md) — the Rust/FFmpeg processor, its
  protocol, its measured profile and its image.
* [`docs/cloudflare.md`](../../../docs/cloudflare.md) — Workflows, Containers and the
  deployment-mode rules.
* [`docs/architecture.md`](../../../docs/architecture.md) — why compute is a separate
  Worker.