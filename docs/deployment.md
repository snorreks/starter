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

## Safety and compatibility

This change does not migrate existing accounts or data and does not delete the old hosted Workers, databases, buckets or provider resources. Preserve the old live deployment until its replacement has been separately validated and an operator authorizes retirement. Hosted Supabase, Resend delivery and Cloud Run actions are NOT RUN unless recorded from an authorized live operation.

The former Better Auth/D1 deployment path and native device flow are removed. Existing users must sign in through the new Supabase project; no automatic identity mapping is provided. See [docs/auth.md](auth.md), [docs/compute.md](compute.md), and [docs/secrets.md](secrets.md).
