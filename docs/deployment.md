# Deployment

One configuration authority, one pipeline, one way to run it locally and from GitHub
Actions. This document is that description. [cloudflare.md](cloudflare.md) covers
the platform concepts; this covers the path.

Nothing here has been executed against a real Cloudflare account. Every claim below
is either verified against a fake process/provider boundary in this repository's own
tests, or explicitly marked as operator work. See
[capability-matrix.md](capability-matrix.md).

## The shape of it

```
plan  ──▶ preflight ──▶ apply ──▶ record
 │         │            │           │
 │         │            │           └─ source SHA, artifact digest, destination,
 │         │            │              deployment identity, smoke result
 │         │            └─ build → validate → migrate → deploy → verify
 │         └─ read-only, authenticated: account, database, Worker
 └─ offline: no credential, no network, no mutation
```

Four commands, because they have different authority. `plan` has to be answerable
on a fork's pull request where no secret exists, so it cannot reach an authenticated
code path. `preflight` may read the account and must never change it. Only `apply`
mutates, and only with `--yes`.

```bash
bun run deploy:status                     # what is configured, and what was released
bun run deploy:check --env staging        # the offline plan (same command)
bun run deploy plan --env staging --json  # machine-readable
bun run deploy preflight --env staging    # authenticated, read-only
bun run deploy apply --env staging --yes  # build, migrate, deploy, verify, record
bun run deploy verify --env staging       # fetch the release and ask what it is
```

`bun run deploy -- --env staging --yes` still works and means `apply`. The old
target word (`bun run deploy web`) is gone: this project deploys as one Worker, so
there is one thing to name.

## One authority for what a command would change

`scripts/src/deploy/target.ts` exports `resolveTarget(environment)`. Everything that
can reach a remote resource goes through it, and nothing else resolves a destination
independently.

That is the whole design, and it exists because of a concrete defect: `DEPLOYMENT_CONFIG`
held one Worker name and one D1 id, and per-environment overrides did not exist. So
`--env staging` and `--env production` produced **identical plans** — the flag
changed a notice and nothing else — and a staging release could reach production's
data.

### Three layers, and which one wins

| Layer | Where | Holds |
|---|---|---|
| 1 | `scripts/src/registry/app_registry.ts` | Project identity, required secret *names*, required var names. Resource ids are `null`. |
| 2 | `.starter/deployment.local.json` (gitignored) | Account id, per-environment Worker name, D1 id, public origin. |
| 3 | Environment variables | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKER_NAME`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_PUBLIC_ORIGIN`. |

Read order is 3, then 2, then 1. `describeResolution(field)` names the layer that
answered, so a report never has to guess.

**Account ids, Worker names, database ids and origins are configuration, not
secrets.** They are nonsecret by construction — a public hostname and a resource
identifier are both public — and encrypting them would make "is this configured?" a
question that needs a decryption key. Private keys and tokens stay in the secret
channel and never appear here.

### Per environment, and never shared

```jsonc
// .starter/deployment.local.json
{
  "accountId": "<32-hex>",
  "environments": {
    "staging":    { "workerName": "…-staging",    "d1DatabaseId": "…", "origin": "https://…" },
    "production": { "workerName": "…-production", "d1DatabaseId": "…", "origin": "https://…" }
  }
}
```

`resolveTarget` refuses, **before any mutation**, when:

1. The environment is not one of `staging` / `production`. `--env prod` and
   `--env local` are both errors; `local` is a runtime (`bun run dev`), not a
   destination.
2. A required value is `null`. A template ships nothing provisioned, on purpose.
3. **Two environments name the same Worker or the same D1 database.** A shared
   database makes a staging migration a production migration, and a shared Worker
   name makes the two environments literally the same deployment.
4. The origin is not an absolute `https://` URL with no path, query or fragment.

### Setting it up

```bash
bun run deploy:configure -- --account <32-hex>
bun run deploy:configure -- --env staging --worker starter-web-staging
bun run deploy:configure -- --env staging --origin https://starter-web-staging.<subdomain>.workers.dev
bun run deploy:configure -- --env staging --provision     # creates the D1 database
bun run deploy:configure -- --check                      # report, never provision
```

`--worker` and `--origin` both require `--env`. Writing them without one is refused:
that is how a value ends up in the shared fallback both environments read.

## Credentials

There is exactly **one** supported mode: `CLOUDFLARE_API_TOKEN` in the environment.

`wrangler login` is not supported, deliberately. Reading a developer's global wrangler
state from a script makes behaviour depend on machine state that appears nowhere in
review, and it does not exist on a CI runner at all. An earlier version of this
tooling *claimed* two modes while reading one, so an operator who had run
`wrangler login` was told "no credential". The remedy text now says so rather than
failing opaquely.

**A token is never placed in argv.** `--api-token`, `--var NAME:value` where the name
contains `SECRET`, and the bare `--var NAME value` spelling are all refused before a
plan is rendered — `secretInArgvProblem` in `scripts/src/deploy/credentials.ts`.
`bun run deploy --api-token ...` exits 4 and explains. Secrets go through
`wrangler secret put`, which prompts.

No report anywhere in this path prints a token, its length, its prefix or its hash.
A preflight report gets pasted into tickets and CI summaries.

## The apply pipeline

`apply` runs five steps in a fixed order, stopping at the first failure and naming
which one.

1. **Build.** The artifact is produced from this checkout, not assumed to exist.
2. **Validate.** `_worker.js` present, files present, digest taken. `wrangler deploy`
   against a directory without `_worker.js` publishes a static site whose every route
   404s — and reports success.
3. **Migrate.** To the named database for this environment, before the deploy, so the
   new code never meets the old schema. The plan comes from the same
   `planMigrate` that `bun run db:migrate` uses, given the *already-validated*
   database id — so the migration destination and the deploy destination are the same
   value by construction rather than by two lookups agreeing.
4. **Deploy.** The target resolved by `resolveTarget`, named explicitly with `--name`,
   carrying `--var RELEASE:<sha>` and `--meta source_sha=…,artifact=…`.
5. **Verify.** `GET <origin>/health`, and the release id it reports.

Then the release record is written to `.starter/releases/<environment>.json`.

### Migrations are reviewed or they are not applied

Only files committed under `packages/backend/database/drizzle-d1/` are applied, and
`apply` never generates one. "Reviewed" is enforced structurally: a migration that has
not been reviewed is one that has not been committed, and the fix is to commit it.

For a schema change, write an **expand-compatible** migration:

- Add new columns/tables/indexes. Do not rename or drop in the same release.
- Read paths must tolerate the old shape (a new column is nullable, or has a default).
- Write paths may require the new column, because the new code is only deployed after
  the migration runs.
- The next release removes what is unused.

### Code rollback is not schema rollback

This is stated in the deploy plan, in the failure message, and here, because it is the
mistake with the worst outcome.

A rollback replaces the running Worker with an older one. The database is untouched.
If the older code does not understand the newer schema, it fails at runtime — and
the deploy that "rolled back" made it worse.

**Recovery procedure, in order:**

1. Stop. Do not re-run `apply` on the newer schema.
2. `bun run deploy:status` — read the recorded `sourceSha` and `artifactDigest` for
   the environment. That is the release that was live.
3. Decide what the *older* code needs:
   - **Old code ignores the new columns/tables** (the expand-compatible case):
     deploy the older artifact. Nothing else is required.
   - **Old code requires the new column to exist and be populated**: the column is
     still there. Deploy the older artifact and backfill separately.
   - **Old code cannot read the new schema at all** (a rename, a narrowed type, a
     dropped column): a rollback is not available without a restore. This is why the
     expand-compatible rule above exists — it removes this branch entirely.
4. Redeploy the previous artifact: `bun run deploy apply --env <env> --yes
   --skip-migrations`. `--skip-migrations` is recorded in the release record.
5. Only after the code is stable, write a **forward** migration to undo the schema.
   D1 records applied migrations in its journal and never re-applies one, so a
   compensating migration is a new file, not a deletion.

Never restore a production database as a rollback test. That is data loss, not a
rollback.

## Serialising applies

Two applies to the same environment must never overlap. Overlapping them means two
builds racing to migrate one D1 database, then two deploys racing to publish, and the
loser wins silently.

`.github/workflows/deploy.yml` expresses that with a **job-level** concurrency group
keyed on the destination:

```yaml
concurrency:
  group: deploy-${{ inputs.environment }}
  cancel-in-progress: false
```

`cancel-in-progress: false` is load-bearing. Cancelling a run that is halfway through
`d1 migrations apply` leaves a schema ahead of the code running on it, with no record
that anything was in flight. The `plan` job has no environment and no secrets, and
cancels freely.

A staging apply and a production apply do not block each other: different Workers,
different databases.

### There is no lock file

A lock in a checkout serialises one developer's machines and nothing else. Two CI
runs, or a CI run and an operator laptop, would both take it and both proceed. The
GitHub environment concurrency group is the only serialisation here that is actually
global, and it is the only one that is claimed.

### Direct `wrangler deploy` is an escape hatch, outside that guarantee

Running wrangler by hand works and publishes. It is **not** a second supported path:

- it does not take the concurrency group,
- it does not validate the artifact,
- it does not migrate,
- it does not verify, and
- it does not write a release record.

It is for recovering a specific Worker when the pipeline itself is what is broken.
If you use it, write the release record by hand afterwards, because the absence of one
is what makes the next incident harder.

## Deployment is manual

The workflow triggers on `workflow_dispatch` only. A push to `main` does not deploy.
An unconfigured template must not publish itself when a commit lands, and "the checks
passed" and "this was published" are different decisions with different authority.

What this relies on, and what you must create:

- **GitHub environments** named `staging` and `production`. Add required reviewers to
  `production` — that is how "production needs approval" is expressed without any
  logic in the workflow. This repository does not change your repository settings for
  you; create them once.
- **Environment secrets** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` on each
  environment. Environment secrets are invisible to a fork's pull request, and
  staging's token is not readable while selecting production.
- **A scoped Cloudflare API token** per environment, limited to the account and the
  Worker/D1 permissions the pipeline uses. This is the least-privilege mechanism
  available; a global API key is not needed.

This PR deliberately does **not** alter remote repository settings. The workflow
declares what it needs; creating it is an operator step.

### CI injects rather than persists

In CI the per-environment values arrive as `CLOUDFLARE_*` environment variables
(layer 3), which override the gitignored overlay. A developer's stale local file
therefore cannot redirect a deployment — it is outranked, not ignored.

The apply job in `deploy.yml` passes `--env staging` (or `production`), and
`resolveTarget` refuses a shared Worker or database before anything runs.

## Health and readiness

| Endpoint | Touches | Answers |
|---|---|---|
| `GET /health` | nothing | `status`, `release`, `environment`, `deployed`. Public, `no-store`. |
| `GET /health/ready` | the `DB` binding | The above, plus one `SELECT 1` per check. 200 or 503. |

They are separate on purpose. A Worker with a deleted database answers `200 ok` to
`/health` forever, because nothing in a configuration read can fail. And liveness
must not touch the database: a load balancer polling a database-backed probe couples
routing health to database latency and pulls every Worker out of rotation while the
application still serves.

The readiness probe is `SELECT 1`, which D1 answers without touching a table — it
measures the binding, not the data. Auth and mail are validated in `getContainer`,
which throws before a request is ever served, so a Worker with a missing
`BETTER_AUTH_SECRET` does not start at all.

`/health` is public, so everything in it is published. It contains no secret, no
binding value, no account id and no database id. `release` is the git SHA, which is
the commit under review and public by construction.

### Cache policy

Applied in `hooks.server.ts` (`cachePolicyFor`), not per route:

- **Any `/api/*` response** — `private, no-store, max-age=0`.
- **Any page behind a sign-in** — same.
- **Anonymous HTML** — deliberately left alone. Whether a page is anonymous depends on
  the session, not on the URL, so a blanket `public` would be a correctness claim this
  code cannot verify.

A `public` directive on a page rendered with a session user is one CDN configuration
change away from serving one user's notes to another.

## `/api/*` failures never become HTML

An unmatched `/api/*` path is answered with the same `{ error, message }` JSON as
every other API response, from `hooks.server.ts`. SvelteKit's own fallback is an HTML
error page, and a client that received one has to guess between "wrong URL" and
"broken deploy" — both expensive.

Source maps are built with `sourcemap: 'hidden'`: they are uploaded for error
reporting and are **not** served as public assets. `check:bundle` fails the build if
server code reaches a client chunk.

## What a release record contains

```jsonc
{
  "project": "starter",
  "environment": "staging",
  "accountId": "…", "workerName": "…", "origin": "https://…",
  "sourceSha": "…", "artifactDigest": "sha256:…",
  "deploymentId": "…", "versionId": "…",
  "recordedAt": "2026-…",
  "smoke": { "ok": true, "path": "/health", "status": 200, "reportedRelease": "…", "problem": null }
}
```

Written to `.starter/releases/<environment>.json`, which is gitignored — a record
never lands in a diff.

`artifactDigest` is a plain content hash over the built directory: every file, sorted
by relative path, hashed as `path\0contents`. The path is inside the hash, so a
renamed asset is a different artifact even when the bytes match.

**There is no skip-deployment engine and no fingerprint cache.** The digest records
what shipped; it does not decide whether to deploy. Deciding that is `--yes`. A cache
whose invalidation is a correctness problem eventually decides wrongly, and a cache
that concludes "nothing changed" publishes nothing at all.

`smoke` keeps the status and the reported release id. It does **not** keep the response
body — the record outlives the deployment and gets pasted into tickets, and a body is
whatever the origin chose to return.

## R2 — the future private-upload choice

**Not implemented.** Nothing in this repository reads or writes an R2 bucket.
`DEPLOYMENT_CONFIG.r2BucketNames.uploads` is `null` and `deploy:configure` cannot
create a bucket; there is no command, no route and no binding.

If you add uploads, R2 is the right bucket, and it needs these four things:

- **Authorization.** A signed URL is issued by a server route that checks ownership
  first — the same ownership rule the notes service enforces, not a new one. The
  browser never holds a bucket credential. Write scope is per-request and per-object;
  a signed URL that can write anywhere in the bucket is not a permission, it is a
  capability handed to whoever receives it.
- **Size and content validation.** Enforced at the route that issues the URL *and*
  enforced by the bucket's own limits. A limit declared in the UI is a limit the
  caller can ignore; `Content-Length` is a claim, and a body over the limit must be
  abandoned while streaming rather than read and then rejected.
- **Private delivery.** Never a public bucket URL. Serve through the Worker, which
  re-checks ownership on every read. A private bucket with a guessable key is not
  private.
- **Deletion and retention.** Uploading user data without a documented deletion path
  is a data-retention policy you have not chosen.

Until all four exist, the field stays `null`.

## Queues and Workflows — not chosen

**Not implemented, and not planned for this workload.**

They are the right tool when a unit of work is *worth queueing*: minutes long,
retried, rate-limited against an external system, or needing many concurrent
identical jobs. Nothing in this application has that shape. Registration and sign-in
are interactive and must answer within a request; sending a verification mail is one
HTTP call to Resend. Putting either behind a queue would add a failure mode — a
verification mail that arrives in four minutes — without removing one.

If a background workload appears, Workers Queues is the first choice (D1-backed, no
new account resource) and Workflows is for multi-step durable orchestration. Adding
either means writing down which workload justifies it.

## Verifying a deployment worked

```bash
bun run deploy verify --env staging           # fetches /health, reports the release id
bun run deploy:status                         # recorded SHA + digest per environment
bun run logs web --mode staging               # historical query
bun run logs web --mode staging --follow      # live tail
```

Cloudflare Workers Observability provides history and tail; both are already wired
through `bun run logs`. **Logpush is not.** An earlier version of the capability
matrix listed it as a claim with no implementation; that entry is removed rather than
carried forward. There is no second log platform here.

Release, environment and request identity are bound from the running request. Redaction,
bounds and real error propagation are unchanged — see [logs.md](logs.md).

## Operator inputs still required

Nothing in this repository can supply these. They are the list to work through before
the first real deployment.

| Input | Where |
|---|---|
| Cloudflare account id | `bun run deploy:configure -- --account <32-hex>` |
| Per-environment Worker names | `bun run deploy:configure -- --env <env> --worker <name>` |
| Per-environment public origins | `bun run deploy:configure -- --env <env> --origin https://…` |
| D1 databases | `bun run deploy:configure -- --env <env> --provision` |
| `BETTER_AUTH_SECRET`, `RESEND_API_KEY` per environment | `wrangler secret put <NAME>` — via SOPS where you keep the values ([secrets.md](secrets.md)) |
| `DEPLOYMENT_ENV`, `BETTER_AUTH_URL`, `MAIL_FROM`, `RELEASE` per environment | `wrangler.jsonc` environment vars |
| GitHub environments `staging` / `production` | repository settings — **not** changed by this PR |
| Production required reviewers | repository settings — **not** changed by this PR |
| Scoped `CLOUDFLARE_API_TOKEN` per environment | GitHub environment secrets |
| A verified Resend sender domain | Resend dashboard; `MAIL_FROM` must match it |