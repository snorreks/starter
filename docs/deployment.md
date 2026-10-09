# Deployment

`resolveTarget(environment)` in `scripts/src/deploy/target.ts` is the single authority for every destination. It resolves one Supabase project/API/Auth origin, web and jobs Worker names, Workflow identities, R2 bucket, optional Cloud Run project/job/runner/dispatcher identities, artifact image/protocol, mail sender and native callback/API configuration. Staging and production must be distinct. A fresh template has no inherited cloud resource identifiers.

Supabase is the only application backend. There is no backend selector and no D1 target. `JOBS_PROFILE=disabled` is explicit; enabled compute is accepted only with every required provider setting present.

## Phases

```bash
bun run deploy:check --env staging
bun run deploy:preflight --env staging
bun run deploy:provision --env staging --yes
bun run deploy:apply --env staging --yes
bun run deploy verify --env staging
```

The offline plan needs no credentials. Authenticated preflight is read only. Provisioning creates the configured Cloudflare resources, and — when that environment's compute is enabled — it also enables the required Google APIs, creates the runner and dispatcher service accounts, creates or patches the Cloud Run Job, and writes that job's IAM policy. An operator approving a provision for an enabled environment is approving those Google changes too. Secrets are installed only with the explicit install option. Apply is an explicit migration and release operation. Supabase migration push uses the resolved project and never carries a password in argv. The local seed remains synthetic and is not a hosted migration path.

The repository environment map is nonsecret and visible to credential free CI planning. API tokens, Supabase access/service keys, Resend keys and Google dispatcher credentials are secrets. Secret values travel on stdin, never argv, logs or artifacts. Supabase project configuration is not a substitute for a hosted migration authorization.

## Optional compute

With compute disabled, the plan and rendered Worker config omit the jobs Worker and Cloud Run bindings. If encode is requested, the resolver names missing Google Cloud, Workflow, R2, image and service identity prerequisites and refuses to plan an incomplete destination. Cloud Run Jobs run the finite media runner; Workflows retain orchestration and Postgres retains fenced job state.

The job template supplies only nonsecret `STARTER_GRANT_ORIGIN` (the resolved web origin) and `STARTER_CLOUD_RUN_JOB_RESOURCE` (`projects/{project}/locations/{region}/jobs/{job}`). The runner uses the latter to qualify the platform's short execution name. Reserved `CLOUD_RUN_*` variables are supplied by Google, never configured here. The job retains one task, zero retries, its pinned image, resource limits and timeout, and a runner identity separate from the dispatcher.

The dispatcher receives `roles/run.jobsExecutorWithOverrides` and `roles/run.viewer` **on that job only**, not on the project; the runner receives no dispatcher grant. Dispatch needs `run.jobs.runWithOverrides` to apply the per-attempt argument overrides and `run.executions.get`/`run.executions.list`/`run.operations.get` to reconcile an ambiguous dispatch, so a single predefined role does not cover it: `roles/run.invoker` is execute-only, and `roles/run.jobsExecutorWithOverrides` lacks the reads. `roles/run.developer` also covers both, but it additionally grants `run.jobs.update` and `run.jobs.delete`, which would let a compromised dispatcher rewrite or delete the image its own runner identity then executes — so it is not used. Sources: Google's [Cloud Run role permission catalog](https://docs.cloud.google.com/iam/docs/roles-permissions/run#run.jobsExecutorWithOverrides), [job execution requirements](https://docs.cloud.google.com/run/docs/execute/jobs#required_roles), and [per-resource access](https://docs.cloud.google.com/run/docs/securing/managing-access#control_access_on_an_individual_cloud_run_resource). Request bodies and job-scoped IAM bindings are fixture-verified; hosted IAM, OAuth and Cloud Run execution are **NOT RUN** (no credentials available or deploy authorization).

## Safety and compatibility

This change does not migrate existing accounts or data and does not delete the old hosted Workers, databases, buckets or provider resources. Preserve the old live deployment until its replacement has been separately validated and an operator authorizes retirement. Hosted Supabase, Resend delivery and Cloud Run actions are NOT RUN unless recorded from an authorized live operation.

The former Better Auth/D1 deployment path and native device flow are removed. Existing users must sign in through the new Supabase project; no automatic identity mapping is provided. See [docs/auth.md](auth.md), [docs/compute.md](compute.md), and [docs/secrets.md](secrets.md).

## Recovery order

Apply runs ordered phases, and a failure leaves the environment between them. The
rule is **schema ahead of code, then the jobs Worker last**: the database accepts
every migration in this repository, so a rollback that reverts the Worker without
reverting the schema leaves code that expects columns the database still has.
Roll back in the reverse of the phase list, one environment at a time.

1. **Schema.** Check what actually applied before reverting anything:
   `select version, name from supabase_migrations.schema_migrations order by version desc`.
   A migration that applied but whose feature was never enabled can stay; the code
   that ignores an extra column is not the problem.
2. **Web Worker.** Redeploy the previous Worker revision only after the schema
   question is settled. `bun run deploy:apply --env <env> --yes --only web` is the
   narrowest phase.
3. **Jobs Worker and compute.** Stop admitting new jobs before reverting it: set
   `jobsProfile` to `disabled` for that environment and apply, so in-flight
   Workflows finish against the code that owns their state. Then, and only then,
   revert the jobs Worker or the Cloud Run Job.
4. **Image retention.** The pinned digest in the resolved target is what every
   rollback restores. Keep the previous digest configured until the environment
   has run green; deleting it leaves nothing to roll back to.

Never roll back a hosted database by dropping objects to "undo" a migration. The
old deployment stays up for exactly this reason.
