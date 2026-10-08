# apps/backend/jobs — the durable compute Worker

## Purpose and runtime

The private jobs Worker exports two Cloudflare Workflows and a scheduled maintenance handler. It has no public API. The web Worker verifies the signed-in UUID owner and starts work through the Workflow binding.

```text
web Worker /api/jobs → ENCODE_WORKFLOW → Postgres RPCs
                                      → Cloud Run finite runner → signed R2 grants
cron → MAINTENANCE_WORKFLOW → bounded Postgres/R2 retention
```

Postgres owns job state, admission limits and attempt fencing. Cloud Run executes the existing Rust `encode` entrypoint; it does not run the HTTP server mode. The runner receives opaque job and attempt ids, obtains a platform identity token, and requests short lived grants from the web Worker. It has no Supabase key or persistent R2 credential.

## Configuration

`JOBS_PROFILE` must explicitly be `disabled` or `encode`. The neutral template uses `disabled` and carries no Cloud Run bindings or schedule. If an operator requests `encode`, target resolution and runtime startup require the complete Supabase, Google Cloud, R2 and Workflow configuration and name every missing prerequisite.

`resolveTarget(environment)` is the deployment authority for the web Worker, jobs Worker, Supabase project, Cloud Run identities, R2 bucket, image, protocol, mail sender and native callback/API origin. Applying a jobs change is explicit. See [docs/deployment.md](../../../docs/deployment.md).

## Commands

Run from this directory:

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

The repository root `bun run test:compute` builds and runs the actual non-root runner image with Docker, local metadata/grant fixtures and real FFmpeg. Docker is required; missing Docker fails nonzero. This lane does not certify hosted Google IAM, hosted Supabase, Cloudflare Workflows or physical devices.

## Validation

The package unit lane discovers its tests with `bun run test`; the compute lane verifies the runner image produces the expected encoded output.

## Boundaries

The Worker has no public route and accepts no user identity directly. Only the web application service authorizes owners. `@starter/database` adapters and service role credentials remain server side. See [docs/architecture.md](../../../docs/architecture.md), [docs/compute.md](../../../docs/compute.md), and [docs/testing.md](../../../docs/testing.md).
