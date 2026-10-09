# Compute: a finite Cloud Run job

Compute is optional and disabled by default. The web Worker owns the public job
API; the jobs Worker exposes no public route and orchestrates encoding through
Cloudflare Workflows. Supabase Postgres owns admission, job state and attempt
fencing. Private R2 owns input and output bytes.

The shipped processor is `apps/backend/media`, built from
`apps/backend/media/Dockerfile.job`. It runs a finite Rust/FFmpeg command and exits;
there is no container HTTP server or container Durable Object. Workflows dispatches
the configured Cloud Run Job. The runner obtains short-lived, attempt-scoped grants
from the web Worker using its Google workload identity, not a database credential
or a bucket key.

## Setup and commands

The default application needs no Google account or compute configuration. Enabling
compute requires the resolved Cloud Run project, region, job and runner identity,
plus the private storage and Workflow configuration described in
[deployment.md](deployment.md).

```bash
bun run test
bun run test:database
bun run test:compute
```

The compute lane requires a running Docker-compatible engine. It builds the finite
job image without cache, requires a nonzero Cargo test count and performs a real
FFmpeg encode against owned local metadata and grant fixtures. Subprocesses have
byte and time bounds, cancellation and checked exit statuses. Missing prerequisites
or missing output fail; there is no mocked success or silent skip.

## Verification boundaries

- Unit tests cover dispatch policy, request validation, identity and attempt fencing.
- The database lane exercises transactional RPCs and ownership/RLS in local Supabase.
- The Docker compute lane exercises the finite runner and real FFmpeg; its Google
  metadata and grant endpoint are fixtures, not deployed services.
- Hosted Google IAM, Cloud Run dispatch, hosted Supabase configuration, natural cron
  delivery and deployment behavior are **NOT RUN** by these local lanes. A configured
  schedule or a successful image build does not prove a deployed execution.

This task does not deploy, provision, delete remote resources or remove user data.

## Boundaries and alternatives

One synthetic fixture and one preset demonstrate the admission/execution path,
not a general media platform. Idempotency and fencing do not make external writes
exactly-once. Attempt-specific artifacts are validated before publication.

For a product whose requirement is managed video ingestion, rendition ladders and
playback, replace this example with a managed service such as Cloudflare Stream;
do not add a second encoding backend to the template.

See [jobs](../apps/backend/jobs/README.md),
[media](../apps/backend/media/README.md), [testing](testing.md), and
[capability-matrix.md](capability-matrix.md) for commands and recorded evidence.
