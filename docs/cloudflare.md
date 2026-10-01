# Cloudflare

This starter deploys to Workers + D1. It provisions **nothing**: no Worker, no
database, no bucket, no domain. A fresh clone reaches a working local state and
refuses, clearly, to deploy anywhere.

That is deliberate. A template that ships resource ids points every new user at
one account.

## Local development needs no account

```bash
bun run db:migrate     # local D1, via wrangler's local state
bun run dev:api        # Worker on :8787
```

Wrangler runs the Worker in workerd with local D1 backed by a file under
`.wrangler/`. Nothing leaves the machine.

## Provisioning

```bash
bun run deploy:configure -- --provision   # create the D1 database, write its id
bun run deploy:configure -- --check       # what is still missing
bun run deploy:check                      # validate a deploy; changes nothing
```

`--provision` creates the database and records its id in the gitignored
`.starter/deployment.local.json`, which the deployment and migration tooling reads.
It also updates `apps/backend/api/wrangler.jsonc` when a database entry is present.
Record the account and Worker names with `deploy:configure -- --account <account-id>
--worker api <worker-name>` (repeat for `client`). Keep the committed defaults in
`scripts/src/registry/app_registry.ts` unprovisioned. Provisioning creates no Worker
and deploys nothing. The local file can also hold per-environment targets.

## Credentials

```bash
export CLOUDFLARE_API_TOKEN=…      # the only credential this tooling reads
```

`wrangler login` writes OAuth state into a per-user directory that this repository
deliberately does not read: behaviour that depends on machine state nobody can see
in review is not reviewable. If you have logged in with `wrangler login`, export the
token as well.

## Four separate things

The distinction the source project lacked. Each has different consequences and a
different undo.

| | What it does | Undo |
|---|---|---|
| **Build** | Produces a bundle | `rm` the output |
| **Provision** | Creates a D1 database, an R2 bucket | Manual; `d1 delete` |
| **Deploy** | Uploads code to a Worker | Redeploy the previous version |
| **Publish source** | Pushes a repository or cuts a release | Nothing useful |

`bun run deploy` does the third. It never does the others:

- no `git push`, no `gh release`, no `npm publish`
- no `d1 create`, no `r2 bucket create`
- no `d1 execute`, no migrations
- no credentials in any command

There are tests asserting exactly that (`scripts/tests/deploy.test.ts`).
Publishing a repository does not deploy it. Creating a database does not deploy
code. A deploy does not publish anything.

## Deploying

```bash
bun run deploy:check                    # validate; the recommended first command
bun run deploy -- --dry-run             # print every command that would run
bun run deploy -- api --env staging --yes
bun run deploy -- api client --env production --yes
bun run deploy -- api --env staging --json    # machine-readable plan
```

`--dry-run` and `deploy:check` read the **same** plan object that a real run
executes. A dry run that re-derives its commands is a dry run that can lie.

Three rules, each of which was previously a way to change something nobody asked for:

**Every remote step requires `--yes`, always.** Not in CI only, not in an
interactive shell. An interactive terminal is not consent; the old gate refused only
a *non-interactive* session without `--yes`, so a developer at a prompt got a silent
remote deploy.

**`--env local` is refused.** `--env` takes `staging` or `production`. This command
deploys to a remote environment and has no local deployment target. Running the CLI
on your laptop is a *local invocation* and is unrelated; the local **runtime** is
`bun run dev:api` (`wrangler dev`). Those are different concepts and the old code
built a `wrangler deploy` command for a "non-remote" local step anyway.

**An unrecognised target word is an error.** `bun run deploy -- clientt` fails with
`Unknown target "clientt"`. It used to filter argv down to the words that happened
to be valid targets and default to *both* when nothing survived, so a typo widened
a single-target production deploy into a deploy of both apps.

### The wrangler that runs

Commands resolve to the pinned workspace copy at
`apps/backend/api/node_modules/.bin/wrangler`, never to `bunx wrangler`.

`bunx` from the repository root does not find a binary that only one workspace
package depends on, so it downloads whatever the registry serves that day. Observed
here: the lockfile pins 4.142.0 and `bunx wrangler --version` reported 4.144.0. A
deploy tool running a version the project never validated is how "works on my
machine" starts.

The same applies to `drizzle-kit`, `playwright` and `tauri`. `bunx` is for
one-off exploration, not for a command that mutates something.

### Before any remote-capable process starts

`scripts/tests/deploy_process_boundary.test.ts` substitutes the process runner and
asserts the argv that would actually be spawned, and that **nothing** is spawned on
refusal. Four cases, each of which previously either spawned or guessed:

- `wrangler` appears in the command line exactly once. `planDeploy` used to put
  `wrangler` in the step's args *and* `runWrangler` prepended it, so the process
  that ran was `wrangler wrangler deploy`.
- a typo'd target spawns nothing
- `--env local` spawns nothing
- a missing credential or a missing `--yes` spawns nothing

## Deployment mode on the Worker

The Worker decides whether development defaults are permitted from one explicit
binding, and fails closed:

```jsonc
// apps/backend/api/wrangler.jsonc
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
- `BETTER_AUTH_URL` is required in every environment and validated structurally
- it must be `https` outside local
- the development placeholder secret is **rejected remotely even when supplied
  explicitly**, as is any secret under 32 characters
- a configuration failure is a 503 whose body names the binding, not an opaque 500

Every `wrangler dev` caller passes `DEPLOYMENT_ENV` and `BETTER_AUTH_URL`:
`scripts/src/dev-api.ts`, the integration suite, and `dev-worker.sh`.

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
| `local` | local file | yes | yes |
| staging / production (api) | Workers Observability query | yes — **no live call has been made** | yes |
| staging / production (api), live | `wrangler tail` | no | **no** |
| staging / production (client) | none | — | — |

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

The registry lists Logpush for staging and production. No job is created, no filter
is registered, and nothing reads the bucket. Treat it as absent — the Observability
query above is the default source, and Logpush is a separate optional export that
this repository does not provide.

### The live tail cannot filter by user id

`wrangler tail` is a live event stream with no provider-side index, so `--uid` and
`--trace` are refused with `capability_unsupported` *before* wrangler is spawned.
Forwarding them would have the provider ignore the narrowing while the client-side
predicate narrowed — so the answer would look filtered and would not be. The refusal
is a feature.

`--follow` selects the tail adapter by capability rather than taking the first
configured one. It used to take the first, which was the *historical* adapter, so
`bun run logs api --mode staging --follow` was dead in every remote environment while
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
| 1. Committed defaults | `scripts/src/registry/app_registry.ts` | always `null` for resource ids, enforced by the `registry-valid` guard |
| 2. Local overlay | `.starter/deployment.local.json` (gitignored) | the real ids, written by `deploy:configure` |
| 3. Environment | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID` | what CI injects instead of persisting |

Read order is 3, then 2, then 1. `bun run deploy:check` names the layer that
answered, so the next question — *is this id mine, and where did it come from?* —
has an answer.

**This layer did not exist before, and that is why provisioning never worked.**
`deploy:configure --provision` wrote a D1 id into `wrangler.jsonc`, which is one of
two files the tooling reads, so `deploy:check` and `db:migrate` saw `null` forever.
The documented remedy — "add the id by hand" — pointed at `app_registry.ts`, a module
the `registry-valid` guard *fails the build* on when it holds a literal. The one
instruction offered could not be followed.

```bash
bun run deploy:configure -- --account <32-hex>   # the account id, no provisioning
bun run deploy:configure -- --provision          # create D1, record the id and account
bun run deploy:configure -- --worker api <name>  # app, then name — both required
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
    "staging":    { "workerNames": { "api": "starter-api-staging" }, "d1DatabaseIds": { "api": "…" } },
    "production": { "workerNames": { "api": "starter-api-prod" },    "d1DatabaseIds": { "api": "…" } }
  }
}
```

| Overlay state | `deploy --env <that environment>` |
|---|---|
| no `environments` key | uses the single set — a one-environment project keeps working |
| entry present | uses that environment's names |
| **absent from the map** | **refused, not defaulted** |

That last row is the point. Falling back for an unconfigured environment is the one
behaviour that must not happen: a production request served by staging names would
publish staging's Worker while the plan claimed production.

`workerName` is `string | null` rather than `''`, and that is not pedantry. An
empty string satisfies `string` while violating `minLength: 1` — the registry
shipped failing its own schema until this was fixed, and nothing noticed. `null`
fails the type, so the compiler catches it.

## Costs

Workers and D1 on the free tier cover a starter's development. Logpush bills for
volume, and D1 bills for reads and writes beyond the included daily quota.

There is no paid observability, no error-tracking service and no feature-flag
provider wired in. `bun run logs` reads files locally and Logpush remotely, which
is enough to answer "what happened to this request" without an account to manage.

## Troubleshooting

**`credentials_unavailable`** — set `CLOUDFLARE_API_TOKEN`. This tooling does not
read the OAuth state `wrangler login` writes to a per-user directory, so a login on
its own will not satisfy it.

**`Refusing to modify … without --yes`** — expected. Add `--yes`, or use
`--dry-run` to see what would run. It is refused in an interactive shell too.

**`--env local is not a deployment target`** — expected. Use
`bun run dev:api` for local workerd.

**`Unknown target "clientt"`** — expected, and deliberately not "deploy everything".
Valid targets are `api` and `client`.

**`The API is not configured correctly and refused to start`** — a 503 whose body
names the binding. See "Deployment mode on the Worker" above.

**A route 404s in production but works locally** — check the Worker name. A
`''` used to pass the type check and fail the deploy; it is `null` now, and the
deploy plan refuses before it can reach Cloudflare.

**Auth returns `Invalid origin`** — the requesting origin is not in
`TRUSTED_ORIGINS`. Add it as a var: `bun run dev:api` with `TRUSTED_ORIGINS` set in
the environment.

**D1 says no such table** — migrations were not applied. `bun run db:migrate:remote`.

**`env: 'node': No such file or directory`** — `wrangler dev` is a Node program.
Provide `node` on PATH. On Nix: `nix-shell -p nodejs`.

**A leftover `wrangler dev` is holding the port.** Find it with
`ss -lptn 'sport = :8787'` and `kill <pid>`. Not `pkill -f wrangler`: the pattern
is broad enough to match the shell that launched it, which kills the caller.

`bun run dev:api` and the integration suite now tear their worker down by walking
the process tree, so repeated runs do not accumulate servers. A leak here means
something bypassed both — check for a `wrangler dev` started by hand.