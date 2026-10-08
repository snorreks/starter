# Optional compute

The starter's compute example is optional. `JOBS_PROFILE=disabled` is explicit in the fresh template; no compute Worker is enabled by inference. Requesting `encode` requires a complete Supabase, Cloudflare, R2 and Google Cloud Run target. Missing prerequisites are named and fail before apply.

## Runtime ownership

Cloudflare Workflows own durable orchestration. Supabase Postgres owns job/attempt state and fencing. Cloud Run Jobs execute a finite non-root runner around the existing Rust/FFmpeg `encode` entrypoint. R2 stores fixture and output bytes. Supabase scheduled database work and the maintenance Workflow perform bounded retention.

The runner receives opaque job and attempt ids, gets an identity token from the platform metadata endpoint, and asks the Worker for short lived input/output grants. It has no Supabase secret or persistent R2 key. Terminal acceptance checks job/attempt fencing, object identity and integrity before publishing output.

## Local verification

```bash
bun run test:compute
```

This lane requires a running Docker-compatible engine, builds the real runner image, uses local metadata/grant fixtures, invokes real FFmpeg, and verifies a real output artifact. Without Docker it exits nonzero with the prerequisite named. It does not prove hosted Cloud Run IAM, hosted Supabase, Cloudflare-managed Workflows, billing/cost or cross-cloud transfer behavior.

Cloud Run dispatch credentials are a least privilege operational secret used by the jobs Worker. Workload identity federation is not configured by this repository. Hosted Google actions are NOT RUN until an operator configures the project, identities, permissions and credentials.

See [docs/deployment.md](deployment.md), [docs/database.md](database.md), and [apps/backend/jobs/README.md](../apps/backend/jobs/README.md).
