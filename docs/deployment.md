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

The offline plan needs no credentials. Authenticated preflight is read only. Provisioning creates only the configured Cloudflare resources and installs secrets only with the explicit install option. Apply is an explicit migration and release operation. Supabase migration push uses the resolved project and never carries a password in argv. The local seed remains synthetic and is not a hosted migration path.

The repository environment map is nonsecret and visible to credential free CI planning. API tokens, Supabase access/service keys, Resend keys and Google dispatcher credentials are secrets. Secret values travel on stdin, never argv, logs or artifacts. Supabase project configuration is not a substitute for a hosted migration authorization.

## Optional compute

With compute disabled, the plan and rendered Worker config omit the jobs Worker and Cloud Run bindings. If encode is requested, the resolver names missing Google Cloud, Workflow, R2, image and service identity prerequisites and refuses to plan an incomplete destination. Cloud Run Jobs run the finite media runner; Workflows retain orchestration and Postgres retains fenced job state.

The job template supplies only nonsecret `STARTER_GRANT_ORIGIN` (the resolved web origin) and `STARTER_CLOUD_RUN_JOB_RESOURCE` (`projects/{project}/locations/{region}/jobs/{job}`). The runner uses the latter to qualify the platform's short execution name. Reserved `CLOUD_RUN_*` variables are supplied by Google, never configured here. The job retains one task, zero retries, its pinned image, resource limits and timeout, and a runner identity separate from the dispatcher.

The dispatcher receives `roles/run.jobsExecutorWithOverrides` and `roles/run.viewer` **on that job only**, not on the project; the runner receives no dispatcher grant. Dispatch needs `run.jobs.runWithOverrides` to apply the per-attempt argument overrides and `run.executions.get`/`run.executions.list`/`run.operations.get` to reconcile an ambiguous dispatch, so a single predefined role does not cover it: `roles/run.invoker` is execute-only, and `roles/run.jobsExecutorWithOverrides` lacks the reads. `roles/run.developer` also covers both, but it additionally grants `run.jobs.update` and `run.jobs.delete`, which would let a compromised dispatcher rewrite or delete the image its own runner identity then executes — so it is not used. Sources: Google's [Cloud Run role permission catalog](https://docs.cloud.google.com/iam/docs/roles-permissions/run#run.jobsExecutorWithOverrides), [job execution requirements](https://docs.cloud.google.com/run/docs/execute/jobs#required_roles), and [per-resource access](https://docs.cloud.google.com/run/docs/securing/managing-access#control_access_on_an_individual_cloud_run_resource). Request bodies and job-scoped IAM bindings are fixture-verified; hosted IAM, OAuth and Cloud Run execution are **NOT RUN** (no credentials available or deploy authorization).

## Safety and compatibility

This change does not migrate existing accounts or data and does not delete the old hosted Workers, databases, buckets or provider resources. Preserve the old live deployment until its replacement has been separately validated and an operator authorizes retirement. Hosted Supabase, Resend delivery and Cloud Run actions are NOT RUN unless recorded from an authorized live operation.

The former Better Auth/D1 deployment path and native device flow are removed. Existing users must sign in through the new Supabase project; no automatic identity mapping is provided. See [docs/auth.md](auth.md), [docs/compute.md](compute.md), and [docs/secrets.md](secrets.md).
