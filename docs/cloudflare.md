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

`--provision` creates the database and writes its id into
`apps/backend/api/wrangler.jsonc`.

It does **not** update `DEPLOYMENT_CONFIG`, which is what `deploy:check` reads, and
it does not deploy anything or create a Worker. So after provisioning you still have
to put the id in `packages/shared/schemas/src/registry/app_registry.ts` by hand
until the project/environment configuration model replaces the registry. A single
registry with per-environment targets is later-phase work, not something this
phase pretends to have done.

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

There are tests asserting exactly that (`scripts/src/lib/deploy/deploy.test.ts`).
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

`scripts/src/lib/deploy/process_boundary.test.ts` substitutes the process runner and
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
`scripts/dev/api.ts`, the integration suite, and `dev-worker.sh`.

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
| staging / production (api) | Cloudflare Logpush | **claimed, not implemented** | claimed |
| staging / production (api), live | `wrangler tail` | no | **no** |
| staging / production (client) | none | — | — |

**The historical row is a claim, not a capability.** `queryCloudflareHistory` never
sends a provider request: once configuration checks pass it returns
`retrieval_failed`. It also conflates the Workers Logs query API with Logpush, which
are separate things — the Workers Observability REST API should be the default
source, and Logpush an optional export. Do not read this repository as evidence that
Cloudflare log querying works. See [capability-matrix.md](capability-matrix.md).

The `wrangler tail` row is why `--uid` can be `capability_unsupported`. A live event
stream has no provider-side index, so `--uid` cannot be applied by the provider —
but a bounded client-side filter is still possible over what arrives, and where
filtering happens should be stated rather than implied either way. Declaring the
capability in `app_registry.ts` turns a silently-unfiltered dump into a clear
error — see [logs.md](logs.md).

The live tail also assumes each input line is already an application `LogEvent`
rather than validating and extracting events from the provider envelope, and has no
coverage of its process lifecycle or exit reporting.

## Configuration

`packages/shared/schemas/src/registry/app_registry.ts` is the only place an app
maps to a Worker, a bucket or a database. Nothing else is allowed to hold its own
map, because a duplicated map is how a staging query silently reads production.

Everything is `null` in the template:

```ts
export const DEPLOYMENT_CONFIG: DeploymentConfig = {
  workerNames: { client: null, api: null },
  d1DatabaseIds: { api: null },
  r2BucketNames: { uploads: null },
  customDomains: { client: null, api: null },
};
```

`workerName` is `string | null` rather than `''`, and that is not pedantry. An
empty string satisfies `string` while violating `minLength: 1` — the registry
shipped failing its own schema until this was fixed, and nothing noticed. `null`
fails the type, so the compiler catches it.

Guard 5 (`bun run guard`) checks that no registry value is a literal, so a template
cannot acquire somebody else's resource id.

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