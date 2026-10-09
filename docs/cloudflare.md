# Cloudflare runtime

Cloudflare Workers host the SvelteKit web application and the private jobs orchestrator. Supabase is the only application identity and relational data provider. Cloudflare owns request routing, static assets, Workflows and optional R2 object storage.

## Workers

The web Worker owns the public origin, request authentication, application operations and RLS user clients. A server load calls its application service directly. The jobs Worker has no public route; the web Worker starts its Workflows through a binding. Both receive an explicit `DEPLOYMENT_ENV` and `JOBS_PROFILE`.

The committed Wrangler configs are neutral templates. Remote configs are generated under `.starter/deploy` from the validated deployment target; local configs are not rewritten with hosted identifiers. No D1 application binding or Cloudflare Container binding is used.

## Secrets and resources

Cloudflare API credentials authorize deployment tooling only. Runtime secrets are installed separately and sent on stdin: `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, and `GOOGLE_DISPATCHER_CREDENTIAL` only when compute is enabled. Publishable Supabase configuration is nonsecret. Secrets and admin keys are excluded from browser/native artifacts.

R2 is optional when compute is disabled. Enabling encode requires a private per-environment bucket and Cloud Run target. The Worker issues narrow, expiring signed grants; the runner never receives a persistent R2 key.

## Operations

```bash
bun run deploy:check --env staging
bun run deploy:preflight --env staging
bun run deploy:provision --env staging --yes
bun run deploy:apply --env staging --yes
bun run deploy verify --env staging
```

Planning is offline; preflight is authenticated and read only; provisioning and apply are explicit mutations. Do not retire the old live deployment until an operator separately validates and authorizes its replacement. See [docs/deployment.md](deployment.md), [docs/compute.md](compute.md), and [docs/secrets.md](secrets.md).
