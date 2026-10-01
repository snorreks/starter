# Rename checklist

Everything to change to make this yours.

The template is deliberately generic. It contains no name, no identifier, no
domain, no resource id and no key belonging to anyone.

Your identity reaches your users through the **Worker name**, the **D1 database**
and the **account** you provision into — not through a bundle id, because this is
a web starter and there is no installed application to identify. Set those in
step 2.

## 1. Provision your resources

```bash
bun run deploy:configure -- --provision
```

This creates the D1 database and records its id in
`.starter/deployment.local.json`, plus the database entry in `wrangler.jsonc`.
It creates no Worker and deploys nothing.

Then set the account and Worker names in the gitignored local configuration:

```bash
bun run deploy:configure -- --account <account-id> --worker api your-app-api
bun run deploy:configure -- --account <account-id> --worker client your-app-client
```

Keep unprovisioned values in `scripts/src/registry/app_registry.ts` as `null`.
Guard 5 rejects literal resource IDs in that committed template configuration.

## 2. Replace the demo entity

Notes is a demo, small on purpose. See
[adding-a-feature.md](adding-a-feature.md) for the order that works:

```bash
bun run contract new "Replace notes with <entity>" --mode standard
```

The pieces to remove, in dependency order:

1. `packages/shared/schemas/src/notes/`
2. `packages/backend/database/src/lib/schema.ts` — the `notes` table
3. a migration: `bun run db:generate && bun run db:migrate`
4. `apps/backend/api/src/lib/notes.ts`, and its line in `index.ts`
5. `apps/frontend/client/src/lib/features/notes/`, `services/notes_service*`
6. the client routes and their tests
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
`apps/backend/api/wrangler.jsonc`, and `packages/backend/database/drizzle.config.ts`.

The `@starter/*` package scope can stay. It is not user-visible, and renaming it
touches every import in the repository for no benefit. If you do rename it, change
`name` in each `packages/**/package.json` and the `paths` in each `tsconfig.json`.

## 4. Domain and origins

If you add a custom domain, put it in both places:

- `DEPLOYMENT_CONFIG.customDomains`
- the `TRUSTED_ORIGINS` Worker binding

They are different things: the first is documentation the deploy tooling reads, the
second is what Better Auth and the origin check actually enforce. Setting only the
first gives a sign-in form that returns 403 in production and works locally.

Nothing is pre-trusted: `TRUSTED_ORIGINS` is the entire allowlist, in both Better
Auth's origin check and the API's CORS layer.

## 5. Signing keys

Nothing is signed, because no keys are shipped. When you add them:

- Keep the private half out of the repository — [secrets.md](secrets.md)
- Commit only the public half

## 6. Before you publish

```bash
bun run typecheck && bun run guard && bun run lint && bun run format && bun run test
bun run test:integration
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
- **CI** in `.github/workflows/ci.yml` is three jobs and no secrets. Adjust the
  Bun version pin alongside `.bun-version` and `.moon/toolchains.yml`.
- **direnv**: `.envrc` is plain bash. `layout dotenv` also manages PATH if you
  want it; `direnv allow` once per clone.

## What you cannot inherit, and should not try to

- Updater signing keys, if you ever add a native client
- Age recipients and identities
- Cloudflare account ids, database ids, bucket names, custom domains
- OAuth client ids and secrets
- The `[owner]` in `package.json`

Every one of these identifies whoever ran the extraction, not you. The tooling
that *uses* them is here; the values are yours.