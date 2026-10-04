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
| 3 | Environment variables | `CLOUDFLARE_ACCOUNT_ID`; `STARTER_DEPLOYMENT_TARGETS` (the repository map); the per-field `STARTER_<ENV>_<FIELD>` overrides; and the unsuffixed `CLOUDFLARE_*` overrides, which apply only to `DEPLOY_ENVIRONMENT`. |

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
3. **Two environments name the same Worker, jobs Worker, database, R2 bucket or
   Workflow identity.** A shared database makes a staging migration a production
   migration; a shared Worker makes the two environments literally the same
   deployment; a shared bucket means staging's retention sweep deletes production's
   job output. The *image* is deliberately excluded — a Dockerfile is a build input,
   both environments may use one, and what runs differs by digest. Two environments
   pinned to the same **digest** *are* refused.
4. The origin is not an absolute `https://` URL with no path, query or fragment.
5. The compute half contradicts itself, or `MAIL_FROM` is absent. See
   [What is refused before anything is mutated](#what-is-refused-before-anything-is-mutated).

### Setting it up

```bash
bun run deploy:configure -- --account <32-hex>
bun run deploy:configure -- --env staging --worker starter-web-staging
bun run deploy:configure -- --env staging --origin https://starter-web-staging.<subdomain>.workers.dev
bun run deploy:configure -- --env staging --mail-from no-reply@your-verified-domain
bun run deploy:configure -- --env staging --provision     # creates the D1 database

# compute, per environment and all or nothing
bun run deploy:configure -- --env staging --jobs-worker starter-jobs-staging \
  --media-bucket starter-media-staging --image-protocol sample-v1 \
  --container-profile basic --jobs-profile encode

bun run deploy:configure -- --check                      # report, never provision
```

Nothing here takes a secret. Every flag above is configuration: a resource name, a
public hostname, a sender address, a protocol id.

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

## Configuring an environment

Everything a deployment touches is resolved by one function,
`resolveTarget(environment)` in `scripts/src/deploy/target.ts`, and it covers the
whole environment rather than the web Worker alone:

| Field | What it names |
|---|---|
| `workerName` | the public web Worker |
| `jobsWorkerName` | the compute Worker. No public route; reached through a binding |
| `d1DatabaseId` | the environment-isolated database both Workers bind |
| `mediaBucketName` | the **private** R2 bucket: fixture in, job output out |
| `encodeWorkflowName`, `maintenanceWorkflowName` | the two Workflow identities |
| `containerImage`, `imageProtocol`, `containerProfile` | what runs the encode, what it speaks, and on which measured profile |
| `origin` | the absolute https address verification is made against |
| `mailFrom` | the verified sender |
| `nativeApiOrigin` | the https origin a packaged native build is compiled against |
| `jobsProfile` | `disabled` or `encode`. A refusal, not a gap |

Every field is `null` in the committed template. A template cannot know a bucket name
and a committed one would point a fresh clone at somebody else's account.

**Where the values live, in precedence order:**

1. the gitignored overlay `.starter/deployment.local.json`, written by
   `bun run deploy:configure`;
2. repository-scoped environment variables, for CI;
3. the committed module, which is only the floor.

### CI configuration: the repository map

GitHub exposes **environment-scoped** variables only to a job that declares that
environment. The `plan` job in `.github/workflows/deploy.yml` deliberately declares
none, so it can be reviewed by someone with no deploy authority — which also means
it cannot read an environment-scoped *variable*.

So the nonsecret configuration is a **repository** variable, and the credentials stay
environment-scoped:

```
STARTER_DEPLOYMENT_TARGETS   (repository variable, JSON)
  {"staging":  {"workerName": "…", "d1DatabaseId": "…", "origin": "https://…",
                "mailFrom": "…", "jobsProfile": "disabled"},
   "production": {…}}
```

Per-field overrides (`STARTER_STAGING_MEDIA_BUCKET_NAME`, …) are honoured over the
map, and the whole map is validated by `EnvironmentTargetsSchema` before any of it
reaches `resolveTarget`: an unknown key is **refused by name** rather than ignored,
and a key that looks like a credential is refused outright, because this value is
echoed into plans and into the release record.

`scripts/tests/deployment_variables.test.ts` drives GitHub's scoping rule as data and
asserts that a plan job sees the repository map and no secret, while an apply job
sees both.

### The unsuffixed overrides, and why they are scoped

`CLOUDFLARE_WORKER_NAME`, `CLOUDFLARE_D1_DATABASE_ID` and friends describe *the
environment this run is deploying*. They are applied **only** when `DEPLOY_ENVIRONMENT`
names that environment, and only on top of that environment's entry.

This is a fix, and the bug it removes was live. Applying one unsuffixed variable to
both environments and then comparing them made `environmentIsolationProblem` prove
that staging and production shared a Worker — so `deploy plan` **refused on every
CI run**, including correct configurations. `environmentIsolationProblem` now
compares the *configured* topology (`configuredTopologyFor`), never the injected
override.

### What is refused before anything is mutated

- an environment name that is not `staging` or `production` (`local` is a runtime);
- two environments resolving to the same Worker, jobs Worker, database, bucket or
  Workflow identity;
- two environments pinned to the same image **digest** (the same build path is fine —
  it is an input, not a resource);
- a jobs profile of `encode` with no image, bucket or protocol;
- a container profile the platform does not offer;
- a configured image protocol this source does not implement;
- an origin that is not an absolute https URL with no path, query or fragment;
- a `MAIL_FROM` that is absent, and a native API origin that is not an absolute
  https URL.

## Provisioning and secret installation

`bun run deploy provision --env <env> --yes` creates what a first deploy needs, and
is **idempotent**: each step reads first and writes only when the resource is absent.
A second run reports `already` and changes nothing, which is why it is safe before
every apply rather than once by hand.

| Step | Read | Write |
|---|---|---|
| database | `d1 info <id>` | `d1 create` |
| bucket | `r2 bucket list --json` | `r2 bucket create` |
| fixture | file present on disk | `r2 object put …/jobs/fixtures/sample-v1.mp4 --remote` |
| secrets | the environment | `secret put <NAME>` **on stdin** |

Bucket existence is parsed from JSON, not matched as a substring: `grep`-ing a list
for `starter-media` would also match `starter-media-staging-old` and skip the create,
leaving the encode path writing to a bucket that does not exist.

**A secret value never appears in argv, in a log line or in an artifact.** The argv
carries the *name*; the value goes to the child's stdin. `secretInArgvProblem` in
`scripts/src/deploy/provision.ts` refuses any value-shaped argument, and
`scripts/tests/deployment_provision.test.ts` asserts that the rendered report and the
recorded argv contain no value — by construction, since no step holds one.

The Cloudflare API token is **not** a runtime secret. It authorises this tooling and is
never readable by the Worker; `BETTER_AUTH_SECRET` and `RESEND_API_KEY` are read by the
running application. Provisioning refuses rather than substituting one for the other.

`--source sops` is refused, with a remedy, rather than implemented: `bun run
secrets:exec` already decrypts and exports, and installing from the environment
afterwards is the composition that keeps one decrypt path.

### Token scopes, derived from the operations

| Permission | Needed by |
|---|---|
| `Account Settings: Read` | `wrangler whoami` — the account check |
| `Workers Scripts: Edit` | the web and jobs Worker deploys |
| `D1: Edit` | `wrangler d1 migrations apply`, `d1 execute` |
| `R2: Edit` | `wrangler r2 bucket create` and the fixture upload |

Each entry names the call that needs it, so a new step without a scope is a visible
omission rather than a 403 nobody can explain. `bun run deploy plan` prints the table.

## The apply pipeline

`apply` runs its phases in dependency order, stopping at the first failure and naming
which one. **The jobs Worker is deployed before the web Worker**, so the public origin
is never live pointing at a binding that does not resolve.

1. **Build.** The artifact is produced from this checkout, not assumed to exist.
   `bun run deploy apply` runs `bun run build` and `bun run check:bundle` itself;
   deploying whatever `.svelte-kit/` happened to hold would publish a previous run's
   bytes whenever they are newer than the source, and the recorded SHA would then be a
   SHA nothing was built from.
2. **Validate.** `_worker.js` present, files present, digest taken. `wrangler deploy`
   against a directory without `_worker.js` publishes a static site whose every route
   404s — and reports success.
3. **Schema.** Reviewed migrations to the named database for this environment, before
   any deploy, so new code never meets the old schema. The plan comes from the same
   `migrationStep` `plan` renders, and the database id Wrangler would actually reach
   is compared against the validated one first — both commands name the binding `DB`,
   so the argv alone cannot tell two databases apart.
4. **Storage.** An assertion, not a second write: the private bucket is proven
   readable, because a pipeline that skipped provisioning would otherwise admit a job
   whose fixture is missing. `provision` is the only thing that writes the bucket.
5. **Image.** The protocol check that can run offline, before anything is mutated.
   Cloudflare builds the image from the Dockerfile the jobs Worker declares; what runs
   is a digest the provider assigns, recorded per release.
6. **Jobs.** The jobs Worker, its Workflows and its schedule, carrying the **same**
   `--var RELEASE:<sha>` as the web Worker. Two SHAs for one deployment would make
   "which code is live" unanswerable.
7. **Web.** The target resolved by `resolveTarget`, named explicitly with `--name`,
   carrying `--var RELEASE:<sha>` and `--meta source_sha=…,artifact=…`.
8. **Verify.** Three questions, each capable of failing the release:
   - `GET <origin>/health`, and the `release` it reports compared against **this run's
     own SHA**. A `200` is not enough: the previous release still serving while a new
     one propagates is exactly the state in which a deploy reports done and the site
     is still wrong.
   - `GET <origin>/health/ready`, which must answer 200 **and** report `ok: true`.
     Liveness reads configuration and cannot fail on its own, so a release whose D1
     binding is unusable answers the first probe perfectly and fails every real
     request. A 200 liveness plus a 503 readiness is a **failed** release record,
     recorded rather than swallowed.

   Each probe is bounded by its own timeout, so an origin that accepts the connection
   and never answers cannot hold the job open, and a slow readiness probe cannot
   consume the liveness budget.

   - **One real encode and one real download**, when the compute profile is on and a
     verification token is available: `POST /api/jobs`, poll to a terminal state
     within a bounded budget, then `GET /api/jobs/:id/output`. A job that reports
     `succeeded` while its output answers non-2xx is a **failed** release.

   A release verification normally has a Cloudflare token and no user session, so the
   tiny-job probe reports **which half it established** rather than pretending the
   whole thing passed: "the compute profile is on, so a real encode is expected, but
   no verification token is available". With the profile off there is no job at all,
   and the record says so instead of reporting a skip as a pass.
9. **Record.** Source SHA, artifact digest, destination, provider identity, smoke
   result, whether migrations were skipped, and **every mutated component** — phase,
   identity, source SHA and, for the compute half, the image protocol — in
   `.starter/releases/<environment>.json`.

### Partial state is recorded, not summarised away

A failure at any phase records every component this run had already changed. "What
did the last half-successful deploy actually do?" is the question an operator has at
that moment, and a record that only exists on success answers it with silence.

The pipeline is resumable by re-running it: migrations are journalled by D1,
provisioning is idempotent, and `--only schema,jobs,web` runs a subset. `--only jobs`
is the supported way to introduce compute into a live environment — the image and the
Workflows must exist and be speaking the same protocol *before* the web Worker is
pointed at them.

### Schedule configured is not schedule fired

The release record carries `compute.scheduleConfigured`, which is read from the
committed jobs configuration. It is **not** evidence that maintenance ran. Genuine
scheduler evidence is a maintenance run record in D1 carrying its cron slot and
`scheduledTime`, and this repository has none — see
[capability-matrix.md](capability-matrix.md).

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

A **Worker rollback does not undo R2 output** either. Encoded media written by the
newer release stays, and anything that reads it — a download link, a retention
sweep, a second user's copy — is unaffected by which Worker answers. Expiring it is a
forward operation, not a rollback.

And a Worker rollback does not roll back the **image**. `apps/backend/media` is
versioned by Cloudflare alongside the Worker, separately. See
[Compute, rollback and what a release is not transactional with](#rollback-image-retention-and-active-workflows).

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

### This is a repository guarantee, not a provider lock

Workflow serialisation, image retention and rollback each need saying plainly,
because "the apply job held a concurrency group" is easy to over-read.

`workflowSerializationNote()` in `scripts/src/deploy/compatibility.ts` carries the
same statement in code, and `scripts/tests/deployment_compatibility.test.ts` asserts
that it names all three ways around the guarantee: an operator's laptop, another
repository pointed at the same account, and a second account holder deploying by
hand. None of them takes the concurrency group.

## Rollback, image retention and active Workflows

A Cloudflare deployment versions **code** and leaves everything else alone. Three
things a deploy changed are not part of a Worker version: the **schema**, the
**stored media**, and any **running Workflow instance**. So "roll back" restores
exactly one of the four things that changed.

### The compatibility rule

Before the image phase, and offline, `deploy` compares the configured image protocol
against the one this source implements and against the one the last release recorded:

| Situation | What happens |
|---|---|
| No previous release | nothing is running; nothing to refuse |
| Recorded protocol matches | proceed |
| Recorded protocol differs | **refused**, with `--only jobs` as the phased remedy |
| Previous release recorded none | **refused** as unproven, not treated as compatible |

The last row is the important one. "The image was built from this repository" is an
assumption for a release predating the recorded identity, and it is the assumption
that lets a protocol change reach production unnoticed. The refusal says to deploy
once with the profile on so the release records its identity, then re-apply.

### Why the mismatch is refused rather than warned

A protocol change reaches running instances, not only new ones. A Workflow instance
started by the previous release holds the image reference it was started with; a
submit job during the deploy window would send an encode the new image rejects. That
failure appears **inside a job that was accepted before the deploy started**, which
is the worst place to discover it — it looks like a scheduler or retry bug.

### Retention

`RETAINED_PREVIOUS_IMAGES = 2`: the current image plus two previous ones stay
available for a supported rollback. One is the common mistake — publishing image
N+1 then garbage-collecting N-1 means the documented rollback stops being available
exactly when somebody needs it. "All" is unbounded cost on a path this template
demonstrates rather than operates.

`rollbackImagePlan(releases)` reports the current digest, the retained ones, and
whether the history has outgrown the retention, from the recorded release history
rather than a provider query — so `plan` can print it offline.

### What a rollback does not do

- **It does not undo a migration.** See
  [Code rollback is not schema rollback](#code-rollback-is-not-schema-rollback); the
  remedy is always a forward migration.
- **It does not delete R2 output.** The bytes stay. Expiring them is a forward
  operation, and the maintenance sweep is what does it.
- **It does not restore the previous image.** Rolling back the web Worker leaves the
  jobs Worker, its Workflows and the image where they are. Rolling *those* back is a
  separate, explicit deploy.

## Secret-bearing jobs publish a reviewed revision

`.github/workflows/deploy.yml` holds the only job with a Cloudflare token and a
database. The restrictions are structural:

- `workflow_dispatch` only, and the workflow does not trigger on `pull_request` at
  all — a fork's code gets no credential of any kind;
- the `apply` job refuses unless `github.ref` is `refs/heads/main`, so an
  environment that requires reviewers cannot be tricked into reviewing something
  other than the default branch's head;
- the revision is recorded once and carried into the release record, so the record
  names the commit this run actually built;
- `environment:` supplies both the secrets **and** the environment's protection
  rules — reviewers, wait timers, branch restrictions — which live in repository
  settings, not in the YAML.

The `plan` job has no `environment:` and therefore no secrets. That is why the
nonsecret configuration is repository-scoped; see
[CI configuration: the repository map](#ci-configuration-the-repository-map).

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

In CI the per-environment values arrive as environment variables (layer 3), which
override the gitignored overlay. A developer's stale local file therefore cannot
redirect a deployment — it is outranked, not ignored.

They are read from **GitHub environment variables** (`vars`), not secrets, because
they are all configuration. Only `CLOUDFLARE_API_TOKEN` is a secret.

| Variable | GitHub | Scope |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | `vars` | account |
| `CLOUDFLARE_WORKER_NAME` | `vars` | the environment being deployed |
| `CLOUDFLARE_D1_DATABASE_ID` | `vars` | the environment being deployed |
| `CLOUDFLARE_PUBLIC_ORIGIN` | `vars` | the environment being deployed |
| `CLOUDFLARE_API_TOKEN` | `secrets` | the environment being deployed |

The four nonsecret ones are declared once at workflow level, so they reach every
step of both jobs: `plan`, `Credential` (preflight), `Apply` and `Summarise the
release`. `plan` uses only the nonsecret four; `Apply` additionally receives the
token.

**They describe one environment, not all of them.** Copying them into every
environment entry was a live production-safety defect: a
`CLOUDFLARE_D1_DATABASE_ID` present in both `staging` and `production` means the two
environments are the same database, and a staging migration is then a production
migration. Injected values are now held separately and overlaid onto the environment
being deployed only.

`environmentIsolationProblem` then compares the *resolved* topology of both
environments and refuses when they name one Worker or one database — which also
catches a project with no `environments` map, where both environments would resolve
to the single set.

### Where Wrangler reads the database from

Wrangler resolves a D1 database by binding name and `--env`. With no
`env.staging` / `env.production` block in `wrangler.jsonc`, an `--env staging` run
inherits the **top-level** `d1_databases` entry — so one provisioned database serves
both environments, and nothing in the argv reveals it, because both commands name
the binding `DB`.

`wranglerDatabaseId` reads exactly what Wrangler would read, and `migrationStep`
refuses when that id differs from the one the project resolved. To deploy both
environments to separate databases, give each an `env.<name>.d1_databases` block in
`wrangler.jsonc`; `deploy:configure --provision` writes the id into the matching
block when one exists, and into the top-level entry otherwise — which is what
Wrangler itself resolves for `--env <name>`.

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

**Verification asks both.** `bun run deploy verify` and the pipeline's own verify
step fetch `/health` and then `/health/ready`; a failure at either fails the
verification, and a failed verification is still recorded — the deployment id in that
record is what a rollback needs. A 200 from `/health/ready` whose body reports
`ok: false` is a failure too: the contract is the report, not the status line.

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
  "skipMigrations": false,
  "components": [
    { "phase": "schema", "identity": "<d1 uuid>",   "source": "<sha>" },
    { "phase": "storage", "identity": "starter-media-staging", "source": "<sha>" },
    { "phase": "image",   "identity": "../media/Dockerfile",   "source": "<sha>", "protocol": "sample-v1" },
    { "phase": "jobs",    "identity": "starter-jobs-staging",  "source": "<sha>", "protocol": "sample-v1" },
    { "phase": "web",     "identity": "starter-web-staging",   "source": "<sha>" }
  ],
  "compute": {
    "enabled": true,
    "jobsWorkerName": "…", "mediaBucketName": "…",
    "encodeWorkflowName": "…", "maintenanceWorkflowName": "…",
    "imageProtocol": "sample-v1", "containerProfile": "basic",
    "scheduleConfigured": true
  },
  "nativeApiOrigin": "https://…",
  "smoke": {
    "ok": true, "path": "/health", "status": 200, "reportedRelease": "…", "problem": null,
    "readiness": { "path": "/health/ready", "ok": true, "status": 200, "problem": null }
  }
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

`components` is the answer to "what did the last half-successful deploy actually
change?", and it is written on failure as well as on success. `compute` is `null` for
a web-only release rather than an empty object, because an empty object reads as a
compute environment whose image was not recorded. `scheduleConfigured` says a cron
expression is committed — it is **not** evidence that maintenance ever ran.

`smoke` keeps the status and the reported release id, plus the readiness answer as
`readiness: { path, ok, status, problem }`. `readiness` is `null` when liveness failed
first and readiness was therefore never asked: a record claiming readiness was checked
would be a claim nobody made. `path` is whichever probe decided the outcome.

Neither probe's body is kept — the record outlives the deployment and gets pasted into
tickets, and a body is whatever the origin chose to return. That applies to the
readiness report too, whose `detail` fields name database internals.

## R2 — two buckets, only one of them exists

There are two distinct R2 uses in this repository and they must not be confused.

**The private media bucket is implemented.** It is `mediaBucketName` on the resolved
target, bound as `MEDIA` by the jobs Worker, created by
`bun run deploy provision --env <env> --yes` and uploaded to with the generated
sample fixture. It is private: no `preview_bucket_name`, no public access, and **no
key ever reaches the container** — bytes leave through the Durable Object port and
come back through the Worker. `apps/backend/jobs/README.md` and
[compute.md](compute.md) describe it.

**User uploads are not implemented.** `DEPLOYMENT_CONFIG.r2BucketNames.uploads` is
`null`, there is no route and no binding, and `deploy:configure` cannot create one.

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

## Queues are not chosen; Workflows are

**Workflows are used.** `apps/backend/jobs` exports `EncodeWorkflow` and
`MaintenanceWorkflow`, and the web Worker reaches the encode one through a binding.
See [compute.md](compute.md) for what that example does and does not demonstrate.

**Workers Queues are not used, and not planned for this workload.** A queue is the
right tool when a unit of work is *worth queueing*: minutes long, retried,
rate-limited against an external system, or needing many concurrent identical jobs.
The job path has that shape; nothing else in this application does. Registration and
sign-in are interactive and must answer within a request, and sending a verification
mail is one HTTP call to Resend — putting either behind a queue would add a failure
mode (a verification mail that arrives in four minutes) without removing one.

If a second background workload appears, Queues is the first choice (D1-backed, no
new account resource) and Workflows is for multi-step durable orchestration. Adding
either means writing down which workload justifies it.

## Verifying a deployment worked

```bash
bun run deploy verify --env staging           # /health identity + /health/ready
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
| Scoped Cloudflare API token per environment | GitHub **environment secrets** (`CLOUDFLARE_API_TOKEN`) |
| Nonsecret per-environment configuration in CI | GitHub **environment variables**: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKER_NAME`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_PUBLIC_ORIGIN` |
| A verified Resend sender domain | Resend dashboard; `MAIL_FROM` must match it |
| Per-environment `d1_databases` blocks in `wrangler.jsonc` | only when deploying both environments to separate databases — see "Where Wrangler reads the database from" |