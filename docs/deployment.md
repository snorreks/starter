# Deployment

One target resolver, one pipeline, one exact destination. The committed Wrangler
files describe runtime/build policy; a fresh clone contains no live resource IDs.
[cloudflare.md](cloudflare.md) explains the platform and
[capability-matrix.md](capability-matrix.md) records verification evidence.

## Authority and phases

```text
plan → preflight → provision → apply → verify + record
```

```bash
bun run deploy:status
bun run deploy:check --env staging       # offline: no credential, network or writes
bun run deploy:preflight --env staging   # authenticated, provider read-only
bun run deploy:provision --env staging --yes
bun run deploy:apply --env staging --yes
bun run deploy verify --env staging
```

No environment means staging. Unknown environments/flags are refused, not guessed.
`apply` and `provision` require `--yes`; an interactive terminal is not consent.
`main` is the development branch. Promote reviewed revisions through `staging` and
`production`, then manually dispatch the Deploy workflow from `main` and select the
target environment. Deployments run only through that dispatch, after a
credential-free offline plan.
Manual recovery dispatch remains available from `main` for either environment.
See [github.md](github.md) for branch protection, environment and notification
setup.

## Resolve the whole environment

`scripts/src/deploy/target.ts` owns the web Worker, public origin, mail sender,
native API origin, jobs profile, jobs Worker, R2 bucket, Workflow identities and
compute destination. With `STARTER_BACKEND_PROFILE=supabase`, that same target also
owns the Supabase project/auth URL and redirect allowlist, Google project/region,
private Cloud Run Job, immutable Artifact Registry image, runner/dispatcher identities,
protocol, bounds and required secret names. When `STARTER_BACKEND_PROFILE` is unset,
Supabase is the default for both target resolution and direct database commands.
Set `STARTER_BACKEND_PROFILE=legacy` explicitly to use the retained D1/container path;
unknown selector values are refused before a provider is reached. With
`jobsProfile: disabled`, Supabase does not require Google configuration or authentication.

Precedence, highest first:

1. Unsuffixed `CLOUDFLARE_*` overrides, **only** for `DEPLOY_ENVIRONMENT`.
2. `STARTER_<ENV>_<FIELD>` overrides and the repository-scoped JSON variable
   `STARTER_DEPLOYMENT_TARGETS`.
3. Gitignored `.starter/deployment.local.json`.
4. Account-neutral defaults in `scripts/src/registry/app_registry.ts`.

The resolver rejects missing required fields, unknown/credential-shaped map keys,
invalid https origins, unsupported profiles/protocols, incomplete compute, and
staging/production sharing a Worker, D1, bucket or Workflow. Shared Dockerfile
inputs are fine; shared pinned image digests are refused. Overrides are also checked
against the other environment's configured destinations. Supabase's public publishable
key is runtime configuration; service-role, mail, dispatcher and provider access tokens
remain separate credentials.

## Supabase and Cloud Run preview

These commands default to Supabase; setting `STARTER_BACKEND_PROFILE=supabase`
explicitly has the same effect. The complete target must
exist for both environments before planning. Plan and preflight never create a
Supabase project; project creation is a separately authorized, potentially billable
operator action. SQL changes follow expand/contract ordering: add schema first,
deploy compatible Workers, and remove old schema in a later release.

```bash
STARTER_BACKEND_PROFILE=supabase bun run deploy:check --env staging
STARTER_BACKEND_PROFILE=supabase bun run deploy:provision --env staging --yes --install
STARTER_BACKEND_PROFILE=supabase bun run deploy:preflight --env staging
STARTER_BACKEND_PROFILE=supabase bun run deploy:apply --env staging --yes
STARTER_BACKEND_PROFILE=supabase bun run deploy verify --env staging
```

Hosted preflight is authenticated and read-only. Provision and apply stop at the
first failed provider operation; the release record contains completed operations
only. Inspect provider state before retrying because API enablement, identity creation,
job changes, migrations or Worker deployment may already have completed. There is no
cross-provider transaction or automatic rollback. A Worker rollback does not reverse
a database migration or Cloud Run Job update. Cloud Run remains private: only the
dispatcher identity receives `roles/run.invoker`; the runner identity is configured
on the Job and receives no persistent storage/admin credential.

Environment-scoped credentials are `CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`,
and a short-lived `GOOGLE_ACCESS_TOKEN` for hosted preflight/apply. Runtime installation
also requires `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, and
`GOOGLE_DISPATCHER_CREDENTIAL`. Values enter provider request bodies or secret stdin,
never argv or release records. GitHub Actions obtains Google tokens through workload
identity federation; configure repository variables `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`
and `GOOGLE_DEPLOYER_SERVICE_ACCOUNT`, restricted to this repository/workflow. The
credential-free plan job reads no environment secrets.

Hosted checks, provider mutation, and hosted migrations were **NOT RUN** during this
implementation. Before running the commands above, create isolated staging/production
Supabase projects, configure the scoped provider credentials and Google federation,
and grant the setup identity only the required project and Job permissions.

```bash
bun run deploy:configure -- --account <32-hex>
bun run deploy:configure -- --env staging --worker <worker-name> \
  --origin https://<worker-name>.<account-subdomain>.workers.dev \
  --mail-from no-reply@<verified-domain> --jobs-profile disabled
bun run deploy:configure -- --env staging --provision
```

Provisioning records the D1 ID **only in the gitignored overlay**. It never rewrites
the committed dev config. Existing resources can be configured through the overlay
or repository map rather than re-created.

### One closed, cached Worker artifact

Build runs Vite and then pinned Wrangler's credential-free `deploy --dry-run` to
close the adapter's transitive SSR graph. The bundle metadata must leave only
platform imports; the build fails before deployment if it still needs a file or
package outside the artifact. Build subprocesses do not receive deploy/runtime
credentials. The OpenTelemetry API is included to resolve Better Auth's optional
import, with no exporter or external telemetry destination.

The generated web config uses `no_bundle: true`: upload the hashed Worker unchanged,
not an entrypoint that borrows intermediate SSR files from another build. Source
maps remain excluded from public assets. The real Worker lane deletes both
intermediate server trees before startup, then proves behavior in workerd and that
private Worker bytes/maps are not publicly served.

### Derived Wrangler configs, not a second source of truth

Authenticated mutations generate `.starter/deploy/<environment>-web.json` (and
`-jobs.json` when enabled) from the resolved target plus committed runtime policy.

- Worker/account/D1 IDs and every compute binding come from the target.
- `DEPLOYMENT_ENV`, `BETTER_AUTH_URL`, `MAIL_FROM` and `JOBS_PROFILE` match it.
- A web-only target contains **no R2 or Workflow binding**.
- Main/assets/migrations/Dockerfile paths are absolute, so moving the generated
  file cannot redirect a path relative to the committed file.
- Jobs have `workers_dev: false`, no routes, and keep the committed Workflow limits,
  Durable Object migration, container cap and schedule.
- Remote commands use the generated config **without `--env`**. The target already
  names the exact environment-specific Worker. Wrangler's legacy secret commands
  otherwise append the environment to `--name` and address a different Worker.

Plan renders the same argv without writing these files. They are disposable derived
artifacts: edit target configuration, not generated JSON. Local dev/build still use
`apps/frontend/client/wrangler.jsonc` with compute disabled.

## Credentials: repo-local, never runtime configuration

CI injects `CLOUDFLARE_API_TOKEN` through its protected environment. Locally:

```bash
cp .env.deploy.example .env.deploy
chmod 600 .env.deploy
# Edit .env.deploy locally; do not paste the value into chat or command arguments.
```

The root `.env.deploy` is gitignored and contains **only** `CLOUDFLARE_API_TOKEN`.
The CLI loads it only around authenticated deploy/configure/remote-db/remote-log
commands, restores the environment afterwards, and never loads it for dev, build,
setup, updates or offline plans. An injected token wins. Tracked/unignored files,
symlinks, oversized files and POSIX files readable by other users are refused.

`wrangler login` OAuth state is not used; no hidden global credential is consulted.
The CLI never reads `~/.config/starter/cloudflare-token`. Do not put the deploy token
in a runtime SOPS file: the Worker needs `BETTER_AUTH_SECRET` and `RESEND_API_KEY`,
not an account-management credential.

Token values never enter argv, reports or release records. `--api-token`, secret
`--var` arguments and value-shaped secret arguments are refused. Secret installation
passes names in argv and values on **stdin**:

```bash
sops exec-env secrets/staging.enc.env \
  'bun run deploy:secrets --env staging --yes --install'
```

Use `sops exec-env` for the dotenv store; `secrets:exec --env KEY=<ciphertext>` is
for individual encrypted JSON documents, not a dotenv file. [secrets.md](secrets.md)
owns decryption; deployment has no second decrypt implementation. Gitignore is not encryption: protect local disk/backups, use mode
600, and rotate an exposed token.

Token permissions, derived from operations: Account Settings Read (account check),
Workers Scripts Edit (deploy/secrets), D1 Edit (migrations), and R2 Edit **only when
compute provisioning is enabled**. Do not replace runtime credentials with this token.

## Provision and apply

Initial D1 creation is `deploy:configure --provision`, which records the new UUID.
`deploy:provision` checks that exact configured ID and refuses an absent one rather
than creating an unbound replacement. It reads before creating the optional private
R2 bucket.
Compute fixture bytes are generated by the media crate at
`apps/backend/media/fixtures/media/sample-v1.mp4` and uploaded to
`media/v1/fixtures/sample-v1.mp4`; provisioning and the runtime share the key function.
Runtime secrets install only with `--install`. A missing secret or fixture is a
failure with a remedy, not an advertised pass.

Apply stops at the first failure, in dependency order:

1. Build from this checkout and check the bundle boundary.
2. Validate `_worker.js`, nonempty assets and artifact digest.
3. Apply migrations to the generated config's exact D1 binding.
4. Assert private storage readiness, if compute is enabled.
5. Check processor protocol compatibility before compute mutation.
6. Deploy jobs/Workflows/image **before** the web Worker.
7. Deploy web/assets, carrying `RELEASE` and supported Wrangler `--message`
   provenance (not the unsupported `--meta` flag).
8. Verify release identity at `/health` and readiness at `/health/ready` with bounded
   fetches. A 200 with the wrong release or readiness `ok: false` fails.
9. Write `.starter/releases/<environment>.json`, including partial mutations on
   failure: source revision, artifact digest, destinations, provider identity,
   phases changed, compute protocol and smoke results. No response bodies/secrets.

A source SHA describes a commit, not uncommitted edits. Commit the reviewed source
before a release whose provenance must be reproducible. The artifact digest records
exactly the built bytes; it does not skip deployments or decide consent.

`--only schema,jobs,web` selects phases; `--skip-migrations` is recorded explicitly.
Re-running resumes forward: D1 journals migrations; provisioning is idempotent.
There is no cross-resource transaction or automatic rollback.

A compute verification needs a real user-session token, not a Cloudflare token.
`verifyTinyJob` sends a schema-valid idempotency key, polls to completion and downloads
nonempty output. Without a session, the record says the encode proof was **NOT RUN**.
Schedule configured is not schedule fired: actual evidence is a D1 maintenance run
with the cron slot and `scheduledTime`.

## Safety and recovery

CI serializes apply per environment with `cancel-in-progress: false`. Cancelling a
migration midway is unsafe. This is **not** a provider lock: an operator laptop,
another repository or another account holder can still deploy concurrently.

Schema changes must expand compatibly; remove/rename in a later release. A Worker
rollback does **not** undo D1 migrations, R2 output, an image deployment or an active
Workflow. Inspect the release record, redeploy compatible older code with
`--skip-migrations`, then write a forward compensating migration if needed. Never
restore production data merely to rehearse rollback.

The processor protocol must match this source and the previous recorded compute
release. A mismatch is refused with a phased-deploy remedy. Retention planning keeps
the current image plus two previous images; a plan is not proof of provider retention.

Direct Wrangler deploy is an emergency escape hatch outside validation, serialization,
migration and recording guarantees. Record what happened if you use it.

## CI and operator prerequisites

- GitHub environments `staging` and `production`; add production reviewers/branch
  protections in repository settings.
- **Repository variables**: nonsecret `CLOUDFLARE_ACCOUNT_ID` and
  `STARTER_DEPLOYMENT_TARGETS`. Plan has no environment and cannot see
  environment-scoped variables.
- **Environment secrets**: `CLOUDFLARE_API_TOKEN`, plus runtime secret inputs only for
  runs explicitly installing them. SOPS identities stay in the secret channel.
- Verified Resend domain/sender, and distinct runtime credentials per environment.
- Compute additionally needs the account's paid capabilities and Docker to build
  the container. A web-only deployment makes no paid compute changes.

## Runtime checks

`/health` is public liveness: release/environment only, no database or credential.
`/health/ready` also asks D1 `SELECT 1` and answers 200 or 503. Verification asks both.
`/api/*` and signed-in HTML are private/no-store; unmatched API paths stay JSON.

```bash
bun run logs web --mode staging
bun run logs web --mode staging --follow
```

User uploads are not implemented. Future uploads need per-object authorization,
streaming size/content enforcement, private delivery and deletion/retention policy.
The compute example uses Workflows, not a second public API or an extra queue.
