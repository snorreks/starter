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
job image without layer cache, requires a nonzero Cargo test count and performs a
real FFmpeg encode against owned local metadata and grant fixtures. Subprocesses have
byte and time bounds, cancellation and checked exit statuses. Missing prerequisites
or missing output fail; there is no mocked success or silent skip.

### The image build, and why a repeat run is fast

```bash
bun run test:compute                      # build (or reuse) the image, then encode
bun run dev --stack container             # prepare it for a development run
bun run e2e:full                          # the black-box lane, which also needs it
```

Building the image means compiling a Rust crate and its dependency tree in release
mode. On a checkout that has never built it, that is minutes, and **nothing in this
repository makes it faster** — there is no vendored artefact to fall back on and
substituting one would mean shipping a binary nobody here built.

What is fixed is everything after the first build. `scripts/src/local/media_image.ts`
hashes everything that can change the image — the Dockerfile, the manifests, the
sources, the tests, the fixtures and the runner — and records that hash beside the
image. A caller that needs the image to *exist* reuses it when the hash matches:

```
Finite runner image starter-cloud-run-job:local is current for these sources
(14d7aef42c1b); build skipped.
```

Measured on this checkout: **33s to build, 0.16s to reuse**, with the reuse reported
every time rather than inferred from silence. Three properties make it safe rather
than a cache that hides staleness:

- **Content-addressed, not time-based.** A changed source, a changed `Cargo.lock`
  and a changed base-image digest (which lives in the Dockerfile) each invalidate it.
- **The stamp is per checkout**, under that checkout's own `.wrangler/`, so one
  worktree's claim can never satisfy another's.
- **The stamp is not enough on its own.** The engine must still have the image; a
  stamp surviving `docker image rm` rebuilds.

`bun run test:compute` reuses too. That is sound for the same reason, and it still
passes `--no-cache` whenever a build actually happens, so a first run on a fresh
checkout verifies for real rather than trusting a claim the checkout has never made.

### A number that lives in the artifact, not in a transcript

The count of passing Cargo tests is written into the image, at
`/usr/local/share/starter-media/rust-tests`, and read back with `docker run --entrypoint
cat`. It used to be scraped from the build's console output, which is not a durable
record: when the layer cache serves the test step, the tests are not re-run, their
output is never produced, and the scraper sees zero — which reads as "nothing
verified the encode path" for an image where the tests did pass. A number stored in
the artifact is the same whether the step ran or came from cache.

### What could make a cold build faster, and why it is not here

BuildKit `--mount=type=cache` would keep the compiled dependency tree outside the
layer cache, so even `--no-cache` would stop recompiling serde and friends. It is
deliberately **not** used: the engine this repository is developed against here
backs `docker build` with the legacy builder (output begins `STEP 1/11`, not
`#1 [stage 1/11]`) and **silently ignores cache mounts**. A Dockerfile directive
that does nothing on the host in use reads like a fix while being inert, which is the
same failure as a command that exits zero having achieved nothing. On a host with
BuildKit enabled the directive would help; adding it blind would be unverifiable
here, so it is left out and recorded instead.

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
