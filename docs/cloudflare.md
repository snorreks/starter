# Cloudflare

This starter deploys to Workers + D1. It provisions **nothing**: no Worker, no
database, no bucket, no domain. A fresh clone reaches a working local state and
refuses, clearly, to deploy anywhere.

That is deliberate. A template that ships resource ids points every new user at
one account.

## Local development needs no account

```bash
bun run db:migrate     # local D1, via wrangler's local state
bun run dev            # the app on :5173, Node, emulated bindings
bun run dev:worker     # the built Worker on :5173, real workerd, real D1
```

Both modes run the Worker in workerd — `dev:worker` literally does, and `dev` runs
the same server code through the adapter's binding emulation — with local D1 backed
by a file under `.wrangler/`. Nothing leaves the machine.

One origin serves the pages, the assets and `/api/*`. There is no API on a second
port and no proxy in between, so a session cookie behaves identically here and in
production. See [architecture.md](architecture.md).

## Provisioning

```bash
bun run deploy:configure -- --account <32-hex>
bun run deploy:configure -- --env staging --worker starter-web-staging
bun run deploy:configure -- --env staging --origin https://<host>
bun run deploy:configure -- --env staging --provision   # create the D1 database
bun run deploy:configure -- --check                     # report; never provisions
bun run deploy:check --env staging                      # the offline plan
```

`--provision` creates the database **for one environment** and records its id in the
gitignored `.starter/deployment.local.json` under `environments.<env>`, which is
what the deployment and migration tooling reads. It also updates
`apps/frontend/client/wrangler.jsonc` when a database entry is present, because
`wrangler` reads that one at deploy time. Keep the committed defaults in
`scripts/src/registry/app_registry.ts` unprovisioned. Provisioning creates no Worker
and deploys nothing.

`--worker` and `--origin` both require `--env`, and both take **one** argument.
`--worker` used to take two — a target and a name — and a caller who wrote
`--worker api` had `api` recorded as the Worker's name, which then deployed to a
Worker called `api` or failed on an account that has no such Worker. Requiring
`--env` as well is what stops the value landing in the single-set fallback that both
environments used to read.

The full sequence, the reasons behind each value, and what is configuration versus
secret are in **[deployment.md](deployment.md)**.

## Credentials

```bash
export CLOUDFLARE_API_TOKEN=…      # the only credential this tooling reads
```

`wrangler login` writes OAuth state into a per-user directory that this repository
deliberately does not read: behaviour that depends on machine state nobody can see
in review is not reviewable, and it does not exist on a CI runner at all. If you have
logged in with `wrangler login`, export the token as well.

**A token is never placed in argv.** `--api-token`, `--var NAME:value` with a
secret-bearing name, and the bare `--var NAME value` spelling are all refused before
a plan is rendered. See `secretInArgvProblem` in `scripts/src/deploy/credentials.ts`
and the tests in `scripts/tests/deployment_target.test.ts`.

## Four separate things

The distinction the source project lacked. Each has different consequences and a
different undo.

| | What it does | Undo |
|---|---|---|
| **Build** | Produces a bundle | `rm` the output |
| **Provision** | Creates a D1 database | `d1 delete` |
| **Migrate** | Applies reviewed SQL to a database | A compensating migration. **Not** a rollback — see below. |
| **Deploy** | Uploads code to a Worker | Redeploy the previous artifact |
| **Publish source** | Pushes a repository or cuts a release | Nothing useful |

`bun run deploy plan` prints the second, third, fourth and fifth without doing any of
them. `bun run deploy apply --yes` runs build, migrate, deploy and verify **in that
order, and only those** — it never runs `git push`, `gh release` or `npm publish`,
and it never provisions. `bun run deploy:configure --provision` is the only command
that creates a remote resource, and it is a separate invocation precisely so a
read-only path cannot grow a side effect.

Ordering matters and is the design: the new code must never meet the old schema, so
migrations run first and the deploy refuses if the migration cannot be planned.

`scripts/tests/deployment_pipeline.test.ts` asserts that argv at the process
boundary: that a plan's migration precedes its deploy, that two environments spawn
two different deployments, and that nothing is spawned at all on any refusal.

Publishing a repository does not deploy it. Creating a database does not deploy
code. A deploy does not publish anything.

## Deploying

```bash
bun run deploy:status                     # what is configured, and what was released
bun run deploy:check --env staging         # the offline plan (same command)
bun run deploy plan --env staging --json   # machine-readable
bun run deploy preflight --env staging     # authenticated, read-only
bun run deploy apply --env staging --yes   # build, migrate, deploy, verify, record
bun run deploy verify --env staging        # fetch the release and ask what it is
```

Four phases rather than flags, because they have different authority. `plan` must be
answerable on a fork's pull request where no secret exists, so it cannot reach an
authenticated code path. `preflight` may read the account and must never change it.
Only `apply` mutates, and only with `--yes`.

**The full path — configuration authority, credentials, the pipeline, migrations and
their expand-compatible form, code-rollback-is-not-schema-rollback, concurrency,
health and readiness, and the release record — is in
[deployment.md](deployment.md).** What follows is what is specific to Wrangler.

There is exactly one target. The application deploys as one Worker plus its static
assets, so there is one `wrangler deploy` per environment. The two-target form this
replaced cost something real: a partial deploy in which the Worker succeeded and the
assets did not leaves a live deployment whose pages 404, and nothing in the plan
could express that as a state to avoid.

`plan` and `deploy -- --dry-run` read the **same** plan object, and it is built from
the same functions `apply` executes — `migrationStep` and `deployStep` in
`scripts/src/deploy/apply.ts`. The hand-written copies they replaced had already
drifted: the plan's migration omitted `--remote` and its deploy omitted
`--var RELEASE` and `--meta`. A dry run that renders different argv from the real
run is a dry run that can lie.

`--dry-run` is honoured rather than accepted and ignored, and combining it with an
explicit `apply` is a usage error: `deploy apply --env production --dry-run --yes`
took the apply path and deployed.

The plan also refuses to run at all if `.svelte-kit/cloudflare/_worker.js` is
absent. `wrangler deploy` against a missing build does not fail loudly: it publishes
an empty deployment whose every page 404s, which reads as a successful deploy of a
blank site.

Three rules, each of which was previously a way to change something nobody asked for:

**Every remote step requires `--yes`, always.** Not in CI only, not in an
interactive shell. An interactive terminal is not consent; the old gate refused only
a *non-interactive* session without `--yes`, so a developer at a prompt got a silent
remote deploy.

**`--env local` is refused.** `--env` takes `staging` or `production`. This command
deploys to a remote environment and has no local deployment target. Running the CLI
on your laptop is a *local invocation* and is unrelated; the local **runtime** is
`bun run dev`. Those are different concepts and the old code built a `wrangler
deploy` command for a "non-remote" local step anyway.

**An unrecognised phase or environment is an error.** `bun run deploy plan --env
prod` fails rather than resolving `prod` to production, and `bun run deploy webb`
fails rather than filtering argv down to the words that happened to be valid and
defaulting to *everything* when nothing survived.


### The wrangler that runs

Commands resolve to the pinned workspace copy at
`apps/frontend/client/node_modules/.bin/wrangler`, never to `bunx wrangler`.

`bunx` from the repository root does not find a binary that only one workspace
package depends on, so it downloads whatever the registry serves that day. Observed
here: the lockfile pins 4.142.0 and `bunx wrangler --version` reported 4.144.0. A
deploy tool running a version the project never validated is how "works on my
machine" starts.

The same applies to `drizzle-kit` and `playwright`. `bunx` is for one-off
exploration, not for a command that mutates something. There is deliberately no
`bunx` fallback in `scripts/src/shared/tools.ts`.

### Before any remote-capable process starts

`scripts/tests/deployment_pipeline.test.ts` substitutes the process runner and
asserts the argv that would actually be spawned, and that **nothing** is spawned on
refusal. `scripts/tests/deployment_cli.test.ts` covers the argument surface. Cases
worth naming:

- `wrangler` appears in the command line exactly once. `planDeploy` used to put
  `wrangler` in the step's args *and* `runWrangler` prepended it, so the process
  that ran was `wrangler wrangler deploy`.
- the runner resolves the pinned workspace binary, never `bunx`
- staging and production spawn two different deployments
- an absent artifact stops before the migration touches anything
- a failed migration does not deploy
- a failed deploy reports that the schema is now ahead of the code
- a failed verification still records the release, because that is when the
  deployment id matters most
- without `--yes`, nothing is spawned at all

## Deployment mode on the Worker

The Worker decides whether development defaults are permitted from one explicit
binding, and fails closed:

```jsonc
// apps/frontend/client/wrangler.jsonc
"vars": { "DEPLOYMENT_ENV": "local" }
```

It used to infer that from the shape of `BETTER_AUTH_URL` — absent, or containing
the substring `localhost`. A Worker deployed without that binding, which is the
single most likely binding to be missing, was therefore classified local, which
relaxed the auth-secret rule and started it with the shipped development secret. A
hostname merely *containing* `localhost` (`mylocalhostdev.example`) also satisfied
it.

Now:

- a missing or unrecognised `DEPLOYMENT_ENV` is an error, not a local default
- `BETTER_AUTH_URL` is required in every deployed environment and validated
  structurally; it must be `https` outside local
- in a **local** environment `BETTER_AUTH_URL` may be omitted, and the request's own
  origin is used instead — but only for a loopback http origin. Deriving a public
  origin from an inbound request is a development convenience; a deployed
  environment must state its own rather than accept one from a caller.
- the development placeholder secret is **rejected remotely even when supplied
  explicitly**, as is any secret under 32 characters
- a configuration failure is a 503 whose body names the binding, not an opaque 500

Every local-Worker caller passes `DEPLOYMENT_ENV`: `scripts/src/dev-app.ts` (for
`dev:worker`) and the E2E harness. `vite dev` needs no forwarding because the adapter
reads `wrangler.jsonc` itself.

## Migrations are separate, and deliberately so

```bash
bun run db:migrate            # local
bun run db:migrate:remote     # staging or production
```

Separate commands, not a flag on one path, because applying migrations is the most
consequential thing in this repository. It changes the shape of somebody's data,
and it is the one operation a code rollback does not undo. Making the destination a
separate invocation means the local case cannot grow a `--remote` by accident.

Both refuse on a typo'd flag rather than falling back to local — `--remote` with
no value used to migrate local silently.

Migrations are not part of `bun run deploy`. Run them deliberately, in that order:
expand, deploy, migrate, contract.

## What the log CLI can read

| Environment | Adapter | History | Filters by user id |
|---|---|---|---|
| `local` | local file (`.wrangler/logs/app.ndjson`) | yes | yes |
| staging / production | Workers Observability query | yes — **no live call has been made** | yes |
| staging / production, `--follow` | `wrangler tail` | no | **no** |

One app, so one set of adapters. `bun run logs web` is the whole command. The browser
and the Worker are told apart by `--source`, not by the app word: browser events
reach the same deployment by being forwarded to `/api/telemetry` and re-emitted as
`source: browser`. The `client-forward` capability that serves them declares
`historicalQuery: false`, which is the honest statement that they only exist where a
forwarder runs.

### The historical query, and what is actually verified about it

`queryCloudflareHistory` sends a real request to

```
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/observability/telemetry/query
Authorization: Bearer $CLOUDFLARE_API_TOKEN
```

and parses the response. The contract it is written against, recorded here because
it is not guessable:

| | |
|---|---|
| Body | `queryId`, `timeframe: { from, to }` (Unix ms), `view: 'events'`, `limit` (max 2000), `datasets`, `parameters.filters` |
| Filter leaf | `{ key, operation, type, value }` — **not** a filter string |
| Operations | `includes`, `not_includes`, `starts_with`, `ends_with`, `regex`, `exists`, `is_null`, `in`, `not_in`, `eq`, `neq`, `gt`, `gte`, `lt`, `lte` |
| Token scope | `Workers Observability Write` — even for a read |
| Response | `{ result: { data: [...], statistics: { rows_read } } }`, each row carrying the logged object plus a `$metadata` sub-object |

Two things about that contract are easy to get wrong, and this repository got both
wrong until it was rewritten against the documentation:

- **There is no `filter` string field.** The previous translation built
  `timestamp >= "…" AND level >= "ERROR"`, which is *Logpush's* format. It either
  returned a 400, or had its narrowing ignored and returned every event in the
  window while the caller reported a filtered count. Its tests were green because
  they asserted that string.
- **Severity is an `in` set, not a comparison.** The provider orders no levels, so
  `level >= "WARNING"` is not a meaningful expression for it. The levels at or above
  the threshold are enumerated instead.

**Verified:** the request shape, against the documented endpoint; the response
handling, against a recorded fixture in `scripts/tests/fixtures/`. A negative
control reintroduces a `filter` string into the body and fails the test that pins
the contract.

**NOT RUN:** a request against a provisioned account. The first thing to check with
a credential is the token scope, which is a *write* scope.

One provider behaviour worth knowing before you trust an empty result: `rows_read: 0`
has been reported for API-token queries that the Cloudflare dashboard answers with
data. The CLI therefore reports `rows_read` when the provider supplies it and says
plainly when it is zero, rather than treating it as authoritative.

The account id is required and has no default — the endpoint is account-scoped, so
`wrangler` cannot infer it the way it does for its own subcommands. Set it with
`bun run deploy:configure -- --account <hex>`, or export `CLOUDFLARE_ACCOUNT_ID`.

### Logpush is not implemented

There is no Logpush job in this repository: none is created, no filter is
registered, and nothing reads a bucket. Treat it as absent.

The registry used to *list* Logpush for staging and production while nothing
implemented it, which is the exact class of claim this repository keeps removing: a
capability the docs name but the code does not provide. The entry is deleted, and
`bun run logs` names only what it can do — Workers Observability for history,
`wrangler tail` for live. See [deployment.md](deployment.md).

### The live tail cannot filter by user id

`wrangler tail` is a live event stream with no provider-side index, so `--uid` and
`--trace` are refused with `capability_unsupported` *before* wrangler is spawned.
Forwarding them would have the provider ignore the narrowing while the client-side
predicate narrowed — so the answer would look filtered and would not be. The refusal
is a feature.

`--follow` selects the tail adapter by capability rather than taking the first
configured one. It used to take the first, which was the *historical* adapter, so
`bun run logs web --mode staging --follow` was dead in every remote environment while
the registry listed a working tail adapter two entries further down the same array.

Each line the tail receives is a provider *envelope*, not an application event, and
an unparseable line is dropped rather than printed as one — wrangler prints banners
and diagnostics on stdout, and passing those downstream is what produced
plausible-looking nonsense before. A session that reaches its bound reports failure,
so a `--follow` that hit `--duration` does not read as a clean finish. See
[logs.md](logs.md).

## Configuration

A resource id belongs to a person, not to a project. There are therefore **three
layers**, and the order is the feature — a value that exists in more than one place
is a value nobody can tell is in effect.

| Layer | Where | Holds |
|---|---|---|
| 1. Committed defaults | `scripts/src/registry/app_registry.ts` | project name, required secret *names*, required var names; always `null` for resource ids, enforced by the `registry-valid` guard |
| 2. Local overlay | `.starter/deployment.local.json` (gitignored) | the account id and each environment's Worker name, D1 id and public origin, written by `deploy:configure` |
| 3. Environment | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKER_NAME`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_PUBLIC_ORIGIN` | what CI injects instead of persisting |

Read order is 3, then 2, then 1. `bun run deploy:status` names the layer that
answered, so the next question — *is this id mine, and where did it come from?* —
has an answer.

**Account ids, Worker names, database ids and public origins are configuration, not
secrets.** They are nonsecret by construction, and encrypting them would make "is
this configured?" a question that requires a decryption key. Tokens and private keys
stay in the secret channel and never appear in this file.

**This layer did not exist before, and that is why provisioning never worked.**
`deploy:configure --provision` wrote a D1 id into `wrangler.jsonc`, which is one of
two files the tooling reads, so `deploy:check` and `db:migrate` saw `null` forever.
The documented remedy — "add the id by hand" — pointed at `app_registry.ts`, a module
the `registry-valid` guard *fails the build* on when it holds a literal. The one
instruction offered could not be followed.

```bash
bun run deploy:configure -- --account <32-hex>          # the account id, no provisioning
bun run deploy:configure -- --env staging --worker <name>
bun run deploy:configure -- --env staging --origin https://<host>
bun run deploy:configure -- --env staging --provision   # create D1, record the id and account
```

### Staging and production are different deployments

A Worker is named once per account, so staging and production are two Workers and
two databases. Before this was expressed, `--env staging` and `--env production`
produced *identical plans* — the flag changed a notice and nothing else, which is
the worst kind of no-op because the plan looked environment-specific.

The overlay takes an optional `environments` map:

```json
{
  "accountId": "…",
  "environments": {
    "staging":    { "workerName": "starter-web-staging", "d1DatabaseId": "…", "origin": "https://…" },
    "production": { "workerName": "starter-web-prod",    "d1DatabaseId": "…", "origin": "https://…" }
  }
}
```

| Overlay state | `deploy apply --env <that environment>` |
|---|---|
| no `environments` key | uses the single set — a one-environment project keeps working |
| entry present | uses that environment's names |
| **absent from the map** | **refused, not defaulted** |

That last row is the point. Falling back for an unconfigured environment is the one
behaviour that must not happen: a production request served by staging names would
publish staging's Worker while the plan claimed production.

**And the two may not share a resource.** `resolveTarget` refuses, before any
mutation, when both environments name the same Worker or the same D1 database — a
shared database is what makes a staging migration a production migration. The check
covers every configured environment, not just the requested one, because the defect
is symmetric: if production already points at the database staging is about to
migrate, then the *staging* deploy is the dangerous one.

An `origin` is required because it is the only address a post-deploy verification
can be made against, and it cannot be derived: the `workers.dev` subdomain belongs
to the account, not to the Worker.

`workerName` is `string | null` rather than `''`, and that is not pedantry. An
empty string satisfies `string` while violating `minLength: 1` — the registry
shipped failing its own schema until this was fixed, and nothing noticed. `null`
fails the type, so the compiler catches it.

## Costs

Workers and D1 on the free tier cover a starter's development. D1 bills for reads
and writes beyond the included daily quota, and Workers bill on the paid plan for
requests beyond the free allowance.

There is no paid observability, no error-tracking service and no feature-flag
provider wired in. `bun run logs` reads files locally and queries Cloudflare Workers
Observability remotely — history and tail, both of which the provider supports on
this account type. That is enough to answer "what happened to this request" without
an account to manage.

**Logpush is not implemented and is not billed for.** An earlier version of this
document described Logpush as a remote log source; no Logpush job is created
anywhere in this repository. The entry has been removed rather than carried forward
as advice, because a cost claim for a capability that does not exist is worse than
no claim at all.

## Troubleshooting

**`credentials_unavailable`** — set `CLOUDFLARE_API_TOKEN`. This tooling does not
read the OAuth state `wrangler login` writes to a per-user directory, so a login on
its own will not satisfy it.

**`Refusing to modify … without --yes`** — expected. Add `--yes`, or use
`bun run deploy plan` to see exactly what would run. It is refused in an interactive
shell too.

**`--env local is not a deployment target`** — expected. Use `bun run dev` for
local workerd.

**`"prod" is not a deployable environment`** — expected, and deliberately not
resolved to production. The valid values are `staging` and `production`.

**`This project has no topology for the "production" environment`** — the overlay
has an `environments` map without that entry. Refused rather than defaulted, because
serving a production request with staging names would publish the wrong Worker while
the plan claimed production. Add the entry, or remove `environments` entirely if the
project genuinely has one environment.

**`staging and production both use the D1 database …`** — the two environments
share a resource. Give each its own Worker name and D1 id:
`bun run deploy:configure -- --env <env> --provision`.

**`this credential can act on account(s) X, but this project is configured for Y`**
— the token and the configuration disagree. Nothing has been changed. Set the right
account id, or use a token for the configured one. `bun run deploy preflight` is the
command that says this.

**`The D1 database … is not readable in this account`** — it does not exist, belongs
to another account, or the token cannot read it. `bun run deploy:configure -- --env
<env> --provision`.

**`No public origin is configured for <env>`** — a deploy could not be verified
without it, so it is refused. `bun run deploy:configure -- --env <env> --origin
https://<host>`.

**`The API is not configured correctly and refused to start`** — a 503 whose body
names the binding. See "Deployment mode on the Worker" above.

**A route 404s in production but works locally** — check the Worker name. A
`''` used to pass the type check and fail the deploy; it is `null` now, and
`bun run deploy plan` refuses before it can reach Cloudflare.

**Auth returns `Invalid origin`** — the requesting origin is not in
`TRUSTED_ORIGINS`. Set it in the environment before `bun run dev`, or as a Worker
var.

**D1 says no such table** — migrations were not applied. `bun run
db:migrate:remote -- <env>`, or let `bun run deploy apply` do it in the correct order.

**`env: 'node': No such file or directory`** — `wrangler dev` is a Node program.
Provide `node` on PATH. On Nix: `nix-shell -p nodejs`.

**A leftover dev server is holding the port.** Find it with
`ss -lptn 'sport = :5173'` and `kill <pid>`. Not `pkill -f wrangler`: the pattern
is broad enough to match the shell that launched it, which kills the caller.

`scripts/src/dev-app.ts` and the integration suite tear their Worker down by walking
the process tree, so repeated runs do not accumulate servers. A leak here means
something bypassed both — check for a `wrangler dev` started by hand. The launcher
also records the pid it started in `.wrangler/local/dev.pid` and clears a stale one
on the next run, per checkout, so two worktrees on one machine do not kill each
other's server.