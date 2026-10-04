# Compute: the shipped path, the escape route, and when to switch

Two questions this document answers, and one it refuses to answer for you.

1. **What does the compute half of this template actually do**, and what does it
   not do?
2. **When is Cloud Run Jobs the right answer instead**, and what would still have to
   be built to get there?

The third question — "should I switch?" — is yours. What follows gives you the
trade honestly, including the parts of Cloud Run that are easier than what is here.

## What ships

| | |
|---|---|
| Worker | `apps/backend/jobs` — two Workflows and one container Durable Object. **No public route**; its `fetch` answers 404 to anything that reaches it. |
| Orchestration | Cloudflare Workflows. Durable, retry-safe steps with a per-job instance id derived from the job id. |
| Compute | `apps/backend/media` — a Rust crate with two entrypoints over one encoding core: an internal HTTP server for the container, and a finite CLI. |
| Image | Built by Cloudflare from `apps/backend/media/Dockerfile`. Non-root runtime, locked Cargo dependencies, real FFmpeg. |
| State | The environment-isolated D1 database the web Worker already binds. |
| Bytes | A private R2 bucket. No key ever reaches the container: bytes go out through the Durable Object port and come back through the Worker. |
| Schedule | One committed cron on the maintenance Workflow, `[env.staging]` and `[env.production]` only, at `17 * * * *` UTC. |

The web Worker reaches the encode Workflow through a binding. That is the whole
authorization story: no second public API exists, so there is no second
authorization surface with no owner.

Read [`apps/backend/jobs/README.md`](../apps/backend/jobs/README.md) and
[`apps/backend/media/README.md`](../apps/backend/media/README.md) for the wire
contract, the measured numbers and the local commands.

### What it is not

- **Not a media platform.** One admitted synthetic fixture, one frozen preset, no
  upload, no user-controlled URL, no codec or FFmpeg argument, no arbitrary cron
  builder.
- **Not an arbitrary Linux process.** Workflows runs in the Worker runtime. The
  container is where FFmpeg runs, and the container is a container, not a shell.
- **Not exactly-once.** Workflow steps are retryable; FFmpeg and R2 writes are not
  transactional with them. Idempotency and attempt fencing are the repository's job,
  and [`packages/backend/jobs`](../packages/backend/jobs/README.md) is where it is
  done.
- **Not free.** Containers require the Workers Paid plan, and containers, Durable
  Objects, Workers, Workflows, R2 and logs each have their own usage dimension. A
  budget alert is a notification, not a cap.

## Choosing between this and Cloud Run Jobs

| | Workers + Workflows + Containers | Cloud Run Jobs |
|---|---|---|
| Account | the one you already have | a second account, a second project, a second billing relationship |
| Portability | inside Cloudflare's runtime model | anywhere |
| Long finite batch | bounded by the container profile and the Workflow step budget | task timeouts to 168 hours; GPU tasks to 1 hour |
| Storage | D1 + R2, no extra service | a GCS bucket (or an R2 mirror — which is a second data path) |
| Auth | a binding; no credential crosses a boundary | workload identity or a service-account key, either way a real IAM surface |
| Orchestration | Workflows: durable, retryable, visible | Cloud Scheduler + Cloud Run: you build the run record, the retry, the idempotency |
| Extra infrastructure | none | Artifact Registry, a service account, an IAM binding, a scheduler, possibly a VPC path for private objects |
| Demonstrable in one sitting | yes | no |

**Choose this repository's path** when the workload is small, adjacent to the web
app, and lives on the same account as everything else — which is the case this
template demonstrates.

**Choose Cloud Run Jobs** when at least one of these is true:

- a single task regularly exceeds what a container profile can hold (the largest
  documented profile is 4 vCPU / 12 GiB / 20 GB disk, and the ceiling is the plan,
  not the code);
- you need a GPU, or a specific accelerator, or a kernel/architecture combination
  Cloudflare does not offer;
- the job is a long finite batch whose runtime is measured in hours rather than
  seconds, and the Workflow step budget is the wrong shape for it;
- your organisation has a hard requirement that compute not run on Cloudflare.

## What the escape route still needs

Nothing below exists in this repository, and none of it is a small change. It is
listed so nobody mistakes "we have a finite CLI" for "we can run this on Cloud Run
today".

### 1. A container image that runs the CLI, not the HTTP server

`apps/backend/media/src/cli.rs` already encodes a local input file to a local output
file and exits with a real status. That is the right shape. What it needs is a
Dockerfile whose `ENTRYPOINT` is the CLI, so the image starts, does the work and
exits — because **a Cloud Run Job task must exit successfully or fail**. The
container image here is built for a long-running HTTP server, and shipping it as a
Job would hang until the timeout.

That is a real difference, not a flag: two entrypoints over one core is what makes
the core reusable, and the images are still two.

### 2. Object storage, and a transfer that is not the web app's

Input has to reach the task and output has to come back. Options, in increasing
order of work:

- **GCS in and GCS out.** The task reads `gs://…` directly. Needs a service account
  with object read on the input prefix and write on the output prefix, and the media
  has to exist in GCS rather than in R2.
- **R2 out, GCS in** (or the reverse). Needs a transfer step, because R2's S3 API is
  not GCS's and the Workers Data Transfer API is not available from a Cloud Run task.
- **Mirror everything into R2 and use an S3-compatible client against GCS
  interoperability.** The most moving parts: an XML API instead of the JSON one, and
  the same bytes maintained in two providers.

Whichever is chosen, the bucket is a second data store with its own retention,
its own lifecycle rules and its own access policy — and D1's job rows will now point
at an object this repository does not own.

### 3. IAM, named explicitly

A Cloud Run Job execution needs a service account, and that service account needs:

- `roles/run.invoker` for whatever triggers it (Cloud Scheduler's service account, or
  a human, or an API caller);
- object read on the input prefix and object write on the output prefix — **not**
  `roles/storage.objectAdmin` on the whole bucket;
- a log-writing permission, and a decision about Cloud Logging retention.

Service-account keys are worse than workload identity and this repository would not
ship one; workload identity needs a trust policy bound to the invoker, which is a
second piece of IAM to review.

### 4. Orchestration, which Cloud Run does not give you

Cloud Scheduler fires the Job. It does not:

- derive a durable, per-job instance id;
- record a run in D1 with a slot key, so a duplicated schedule cannot sweep twice;
- bound a batch and continue deterministically;
- tell you whether the run *actually* happened, as opposed to being configured.

All of that exists here already — in the maintenance Workflow and in
`@starter/jobs` — and would have to be re-expressed as "an HTTP call that starts a
Job, plus a row in D1, plus a reconciliation pass for the cases where the call
succeeded and the row did not". That reconciliation is the entire content of
`MaintenanceWorkflow`'s recovery step, and it is the part people forget.

### 5. An exit contract, not a service contract

The CLI exits non-zero on failure and prints nothing sensitive. Good. What is missing
is the surrounding machinery: a job's *success* is the exit code, so a partially
written output must be cleaned up on the way out, and the output object must only be
promoted from a temporary key to its final key after the process exits 0. This
repository already has that shape — an attempt-specific R2 key, validated, then
committed — and it is the part that transfers cleanly. Everything around it does not.

### What is NOT required by any of this

A GCP account is not needed to adopt this template, to run its tests, or to read this
document. The compute path here runs with a Docker-compatible engine and nothing
else. A second-cloud implementation is deliberately absent and will not be added to
the default profile.

## When managed Cloudflare Stream is the right answer

Stream is a different product and it should replace the container for a lot of real
applications.

**Use Stream when the product is video delivery**: user uploads, transcoding to a
ladder of renditions, playback, thumbnails, captions, signed URLs, analytics. It is a
managed service with its own ingestion and delivery model, and building that on a
container is a project, not a configuration.

Concretely, Stream is the answer when the requirement is any of:

- "a user uploads a video and watches it in a player" — Stream does ingest,
  transcoding, a player and signed tokens;
- "we need several renditions and adaptive bitrate" — that is a ladder, and a ladder
  is the thing one container should not be asked to produce;
- "we need per-view authorisation on playback" — signed URLs with a TTL are a
  managed feature;
- "we need the vendor to handle the codec matrix" — FFmpeg build matrices are a real
  maintenance burden, and Stream's is not yours.

**Keep the container when the work is genuinely custom and genuinely yours**: a
specific transform FFmpeg does not expose, a model inference, a proprietary codec, a
pipeline that is not "encode a video into renditions". The processor in this
repository is the second kind — it exists to show the *path* (admission, fencing,
Workflows, private storage, a real deadline), not to compete with a transcoding
service.

**Do not add Stream alongside the container to multiply examples.** Two video
backends in one template is not a demonstration of either; it is a demonstration that
nobody chose. If your product is video delivery, replace the compute example with
Stream and delete `apps/backend/media`. If it is not, leave the container and do not
add Stream.

The job and media READMEs record which one this repository ships and why.

## Verification, and what is not verified here

| Claim | How to establish it |
|---|---|
| The shipped path works end to end, locally | `bun run test:compute` — real Workflows, real D1 and R2, a real FFmpeg container in Docker |
| The shipped path works on Cloudflare's runtime | Deploy it. **NOT RUN here** — see [capability-matrix.md](capability-matrix.md) |
| A maintenance run genuinely fired | The run record in D1 carrying the cron schedule and its `scheduledTime`. A configured schedule is not a firing. |
| A Cloud Run Job would work | Building items 1–5 above. **NOT RUN, and NOT IMPLEMENTED.** |
| Stream is right for your product | Its own documentation, against your own requirements. Not benchmarked here. |

See [cloudflare.md](cloudflare.md) for the container profiles, pricing dimensions and
scheduling contract this is written against, and [deployment.md](deployment.md) for
the apply order, the rollback limits and the compatibility rules that make an image
change safe.