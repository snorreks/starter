# Rename checklist

Everything to change to make this yours.

The template is deliberately generic. It contains no name, no identifier, no
domain, no resource id and no key belonging to anyone.

Your identity reaches your users through the **Worker name**, the **D1 database**
and the **account** you provision into — not through a bundle id, because this is
a web starter and there is no installed application to identify. Set those in
step 1.

If you also ship the native client, your identity additionally reaches users through
the **API origin a packaged build targets** (`nativeApiOrigin`), which is compiled
into a signed binary and cannot be corrected afterwards. Set it per environment
alongside the Worker name.

## 1. Provision your resources

```bash
bun run deploy:configure -- --provision
```

This creates the D1 database and records its id in
`.starter/deployment.local.json`, plus the database entry in `wrangler.jsonc`.
It creates no Worker and deploys nothing.

Then set the account, the Worker names and the public origins in the gitignored local
configuration. Every one of these requires `--env`: staging and production are
different Workers, different databases and different buckets, and a value written
without one is the shared fallback both of them used to read.

```bash
bun run deploy:configure -- --account <account-id>
bun run deploy:configure -- --env staging    --worker your-app-web-staging
bun run deploy:configure -- --env production --worker your-app-web
bun run deploy:configure -- --env staging    --origin https://staging.your-domain
bun run deploy:configure -- --env production --origin https://your-domain
bun run deploy:configure -- --env staging    --mail-from no-reply@your-verified-domain
bun run deploy:configure -- --env production --mail-from no-reply@your-verified-domain
bun run deploy:configure -- --env staging    --native-api-origin https://staging.your-domain

# only if this deployment runs compute
bun run deploy:configure -- --env staging --jobs-worker your-app-jobs-staging \
  --media-bucket your-app-media-staging --image-protocol sample-v1 \
  --container-profile basic --jobs-profile encode
```

Keep unprovisioned values in `scripts/src/registry/app_registry.ts` as `null`.
Guard 5 rejects literal resource IDs in that committed template configuration.

**For CI**, put the same nonsecret values in a **repository** variable called
`STARTER_DEPLOYMENT_TARGETS` (a JSON object keyed by environment), and keep every
credential on the protected environment. The credential-free plan job cannot read
environment-scoped configuration at all, which is why the map is repository-scoped.
See [deployment.md](deployment.md).

## 2. Replace the demo entity

Notes is a demo, small on purpose. See
[adding-a-feature.md](adding-a-feature.md) for the order that works:

```bash
bun run contract new "Replace notes with <entity>"
```

The pieces to remove, in dependency order:

1. `packages/shared/schemas/src/notes/`
2. `packages/backend/database/src/supabase/notes_repository.ts` — the notes repository
3. a new SQL migration under `supabase/migrations/`, then `bun run db:migrate`
   and `bun run db:types`; do not rewrite an applied migration
4. `apps/frontend/client/src/lib/server/notes_service.ts`, and its two route adapters
   (`src/routes/api/notes/+server.ts` and `src/routes/api/notes/[id]/+server.ts`)
5. `packages/frontend/features/src/notes/` — the View, ViewModel and service are
   shared, so removing the feature removes them from both the web app and any other
   host
6. `apps/frontend/client/src/routes/notes/`, and its tests
7. `apps/e2e/tests/notes.spec.ts`; keep `auth.spec.ts` and retarget it

Keep `auth.spec.ts`'s cross-account tests. They are about ownership, not about
notes, and they are the most valuable thing in the E2E lane.

## 3. Text and identity

```bash
grep -rn "Starter\|starter" --include=*.ts --include=*.svelte \
  --include=*.json --include=*.md --include=*.jsonc \
  . | grep -v node_modules | grep -v '\.git/'
```

Expect hits in: `README.md`, `AGENTS.md`, `apps/frontend/client/src/routes/+layout.svelte`,
`apps/frontend/client/wrangler.jsonc`, and `supabase/config.toml`.

The `@starter/*` package scope can stay. It is not user-visible, and renaming it
touches every import in the repository for no benefit. If you do rename it, change
`name` in each `packages/**/package.json` and the `paths` in each `tsconfig.json`.

## 4. Domain and origins

If you add a custom domain, put it in both places:

- `DEPLOYMENT_CONFIG.customDomain`
- the `TRUSTED_ORIGINS` Worker binding

They are different things: the first is documentation the deploy tooling reads, the
second is what Better Auth and the origin check actually enforce. Setting only the
first gives a sign-in form that returns 403 in production and works locally.

`TRUSTED_ORIGINS` is the API's complete CORS allowlist. Better Auth also implicitly
trusts the origin from its `baseURL`, in addition to `TRUSTED_ORIGINS`.

## 5. Signing keys

Nothing is signed, because no keys are shipped. When you add them:

- Keep the private half out of the repository — [secrets.md](secrets.md)
- Commit only the public half

## 6. Before you publish

```bash
bun run typecheck && bun run guard && bun run lint && bun run format && bun run test
bun run test:worker
bun run e2e
```

Then:

```bash
# must all print 0
git ls-files | grep -cE '\.env$|\.dev\.vars$|\.pem$|\.key$|\.agekey$'
git grep -cI -E 'ghp_|sk-[A-Za-z0-9]{20,}|sbp_|AKIA|BEGIN.*PRIVATE KEY' || echo 0

# a real scanner, not a grep
gitleaks detect --source . --no-git --redact

# no identifier from the source project survives.
# This line is itself one of the names it searches for, hence the exclusion.
git grep -in 'aikami\|emberwatch\|BearlySleeping' -- . ':!docs/rename-checklist.md' || echo clean
```

The last one should print nothing. Neither the provenance record nor this file
names the source repository: the first records *what* was kept and removed, and
this one records only that there is nothing to find.

## 7. Optional: Moon, CI, direnv

- **Moon** is task orchestration only. Drop `.moon/` and the per-project
  `moon.yml` files, and change the root scripts to call the packages directly.
  Nothing else depends on it — the guards and the linter enforce the
  architecture. See [toolchain.md](toolchain.md).
- **CI** in `.github/workflows/ci.yml` runs credential-free application lanes on
  PRs and on `main`, `staging`, and `production`. Update the Bun version authority
  in `config/toolchain.json` and its mirrors in `.bun-version` and
  `.moon/toolchains.yml`.
- **GitHub**: make `main` the default branch, create `staging` and `production`,
  configure protections and deployment environments, replace the owner and
  security-advisory placeholders, and add an optional `DISCORD_WEBHOOK_URL` to
  deployment environments. See [github.md](github.md).
- **direnv**: `.envrc` is plain bash. `layout dotenv` also manages PATH if you
  want it; `direnv allow` once per clone.

## What you cannot inherit, and should not try to

- Age recipients and identities
- Cloudflare account ids, database ids, bucket names, custom domains
- OAuth client ids and secrets
- The `[owner]` in `package.json`

Every one of these identifies whoever ran the extraction, not you. The tooling
that *uses* them is here; the values are yours.
