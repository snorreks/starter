# Supabase and Cloud Run compute preview

Prompt 06 keeps the legacy compute path as the default. The explicit preview uses the web Worker's Supabase identity, Postgres job RPCs and internal grant route, the jobs Worker's Cloudflare Workflow, a Google Cloud Run Job, and the same private R2 bucket. The Workflow is the durable orchestrator; Postgres owns admission and attempt fencing; the runner only receives object/method/expiry grants.

## Frozen configuration names

| Name | Owner | Value/use |
|---|---|---|
| `STARTER_BACKEND_PROFILE` | web and jobs Workers | `legacy` by default; `supabase` selects the preview |
| `JOBS_PROFILE` | web and jobs Workers | `disabled` by default; `encode` requests compute |
| `COMPUTE_PROTOCOL` | jobs Worker | `sample-v1` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Workers | Preview Postgres/Auth; service key is a Worker secret |
| `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_REGION`, `GOOGLE_CLOUD_RUN_JOB` | jobs Worker | Explicit dispatch target |
| `GOOGLE_RUNNER_SERVICE_ACCOUNT`, `GOOGLE_RUNNER_SUBJECT`, `GOOGLE_RUNNER_AUDIENCE` | web Worker | Expected Google token email, numeric `sub`, and audience |
| `GOOGLE_DISPATCHER_CREDENTIAL` | jobs Worker secret | Service-account JSON key exchanged for short-lived OAuth tokens; never a variable or process argument |
| `RUNNER_GRANT_SECRET` | web Worker secret | HMAC signing key for method/object grants |
| `STARTER_GRANT_ORIGIN`, `STARTER_GRANT_AUDIENCE` | Cloud Run Job | Worker origin and audience requested from metadata server |
| `CLOUD_RUN_EXECUTION` | Cloud Run platform | Injected execution resource name; matched to the execution recorded for the active attempt |

The dispatcher service account needs `run.jobs.runWithOverrides` on this job and permission to read executions for reconciliation. It is separate from the runner service account. The runner requires no database, administrator, or persistent R2 credential. OAuth currently uses an injected dispatcher key stored as a Worker secret. Workload identity federation is a future credential-provider substitution and is not configured or claimed here.

Cloud Run receives exactly the opaque job and attempt ids as arguments. It returns to the Worker for a grant, receives a signed input GET and output PUT grant scoped to the recorded Cloud Run execution, active attempt, object key and lease expiry, then invokes `/usr/local/bin/starter-media encode`. The Worker checks the Google issuer, configured audience, service-account email and subject, then checks the active Postgres lease. Transfers are bounded, hash checked and written through the Worker to R2. The Workflow checks object metadata and size before the fenced completion RPC.

Configure the Cloud Run Job for one task, zero platform retries, and a 15 minute task timeout. The Workflow owns the three attempt budget; each database lease is 20 minutes and each grant expires at the earlier of the lease or 18 minutes after issuance. The runner reports the finite processor's exit code through the same authenticated Worker boundary: codes 2–6 are terminal, while 7–9 are retryable under the existing attempt cap. A failure to deliver that report remains retryable and does not trust stderr text.

## Local verification

```sh
bun run test:compute -- --backend supabase --processor cloud-run-local
```

This builds `apps/backend/media/Dockerfile.job`, starts local authenticated metadata/grant/API fixtures, executes the actual non-root Rust FFmpeg binary in Docker, and verifies uploaded bytes. The fixture API stores output in its bounded in-memory sink; the runner lane does not yet connect that callback to Supabase and Miniflare R2 in one journey. The `test:database` lane separately replays and tests the migrations against real local Postgres. These lanes exercise their local boundaries, but do not claim a combined Postgres/R2 runner journey. They do not verify Google's hosted IAM, Cloud Run metadata, Supabase hosted operation, cross-cloud cost, or a deployed job. The local Supabase database lane runs:

```sh
bun run test:database
bun run db:types:check
```

Missing Docker is a nonzero prerequisite failure. Enabled preview compute without required bindings, Worker secrets, target configuration, or the current protocol refuses explicitly.
