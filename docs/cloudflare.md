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
`apps/backend/api/wrangler.jsonc` and `DEPLOYMENT_CONFIG`. It does not deploy
anything and does not create a Worker.

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
bun run deploy -- --env staging --yes
```

`--dry-run` and `deploy:check` read the **same** plan. A dry run that re-derives
its commands is a dry run that can lie.

Every remote step requires `--yes`, and a production deploy prints a live-traffic
warning in the plan itself.

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
| staging / production (api) | Cloudflare Logpush | yes | yes |
| staging / production (api), live | `wrangler tail` | no | **no** |
| staging / production (client) | none | — | — |

The `wrangler tail` row is why `--uid` can be `capability_unsupported`. A live
event stream has no index to filter against. Declaring that in
`app_registry.ts` turns a silently-unfiltered dump into a clear error — see
[logs.md](logs.md).

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

**`credentials_unavailable`** — set `CLOUDFLARE_API_TOKEN`, or run
`wrangler login`.

**A route 404s in production but works locally** — check the Worker name. A
`''` used to pass the type check and fail the deploy; it is `null` now, and the
deploy plan refuses before it can reach Cloudflare.

**Auth returns `Invalid origin`** — the requesting origin is not in
`TRUSTED_ORIGINS`. Add it as a var: `wrangler dev --var TRUSTED_ORIGINS:https://...`

**D1 says no such table** — migrations were not applied. `bun run db:migrate:remote`.

**A leftover `wrangler dev` is holding the port.** Find it with
`ss -lptn 'sport = :8787'` and `kill <pid>`. Not `pkill -f wrangler`: the pattern
is broad enough to match the shell that launched it, which kills the caller.