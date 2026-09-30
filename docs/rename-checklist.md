# Rename checklist

Everything to change to make this yours. In order — the first three are the ones
that are hard to change later.

The template is deliberately generic. It contains no name, no identifier, no
domain, no resource id and no key belonging to anyone.

## 1. Identity, before anything ships

These appear in your bundle id, your install path and your signing identity.
Changing them after a first release is not free.

**`apps/frontend/client/src-tauri/tauri.conf.json`**

```json
"productName": "Your App",
"identifier": "com.yourcompany.yourapp",
"version": "0.1.0"
```

**`apps/frontend/client/src-tauri/Cargo.toml`** — match it:

```toml
name = "your-app"

[lib]
name = "your_app_lib"
```

The `crate-type` must stay `["staticlib", "cdylib", "rlib"]`. It is what lets the
same code build as a mobile library as well as a desktop binary, and dropping
`staticlib` breaks mobile builds with an error that does not explain itself.

**`apps/frontend/client/src-tauri/src/lib.rs`** — `starter_lib::run()` in
`main.rs` must match the `[lib] name`.

## 2. Provision your resources

```bash
bun run deploy:configure -- --provision
```

This creates the D1 database and writes its id into `wrangler.jsonc` and
`DEPLOYMENT_CONFIG`. It creates no Worker and deploys nothing.

Then set Worker names:

**`packages/shared/schemas/src/registry/app_registry.ts`**

```ts
export const DEPLOYMENT_CONFIG: DeploymentConfig = {
  workerNames: { client: 'your-app-client', api: 'your-app-api' },
  d1DatabaseIds: { api: '<provisioned id>' },
  r2BucketNames: { uploads: null },
  customDomains: { client: null, api: null },
};
```

Use `null`, never `''`, for anything unprovisioned. Guard 5 fails the build on a
literal resource id, and it is there because a template that ships an id points
every new user at one account.

## 3. Replace the demo entity

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
5. `apps/frontend/client/src/lib/views/notes/`, `services/notes_service*`
6. the client routes and their tests
7. `apps/e2e/tests/notes.spec.ts`; keep `auth.spec.ts` and retarget it

Keep `auth.spec.ts`'s cross-account tests. They are about ownership, not about
notes, and they are the most valuable thing in the E2E lane.

## 4. Text and identity

```bash
grep -rn "Starter\|starter" --include=*.ts --include=*.svelte \
  --include=*.json --include=*.rs --include=*.md --include=*.jsonc \
  . | grep -v node_modules | grep -v '\.git/'
```

Expect hits in: `README.md`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
`src-tauri/icons/icon.svg`, `apps/frontend/client/src/routes/+layout.svelte`,
`apps/backend/api/wrangler.jsonc`, and `apps/backend/database/drizzle.config.ts`.

The `@starter/*` package scope can stay. It is not user-visible, and renaming it
touches every import in the repository for no benefit. If you do rename it, change
`name` in each `packages/**/package.json` and the `paths` in each `tsconfig.json`.

## 5. Domain and origins

If you add a custom domain, put it in both places:

- `DEPLOYMENT_CONFIG.customDomains`
- the `TRUSTED_ORIGINS` Worker binding

They are different things: the first is documentation the deploy tooling reads, the
second is what Better Auth and the origin check actually enforce. Setting only the
first gives a sign-in form that returns 403 in production and works locally.

## 6. Signing keys

Nothing is signed, because no keys are shipped. When you add them:

- Keep the private half out of the repository — [secrets.md](secrets.md)
- Commit only the public half
- Pin a Tauri updater keypair in your own secret store when you add an updater;
  see [native.md](native.md)

## 7. Before you publish

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

# nothing inherited remains
git grep -in 'aikami\|emberwatch' -- . ':!docs/starter-extraction.md' || echo clean
```

The last one has one expected hit by design: `docs/starter-extraction.md` records
where this came from. That is provenance, and it belongs in the repository — but it
is the one place the original project's name appears, so it is the one place to
review if you would rather it did not.

## 8. Optional: Moon, CI, direnv

- **Moon** is task orchestration only. Drop `.moon/` and the per-project
  `moon.yml` files, and change the root scripts to call the packages directly.
  Nothing else depends on it — the guards and the linter enforce the
  architecture. See [toolchain.md](toolchain.md).
- **CI** in `.github/workflows/ci.yml` is three jobs and no secrets. Adjust the
  Bun version pin alongside `.bun-version` and `.moon/toolchains.yml`.
- **direnv**: `.envrc` is plain bash. `layout dotenv` also manages PATH if you
  want it; `direnv allow` once per clone.

## What you cannot inherit, and should not try to

- Updater signing keys
- Age recipients and identities
- Cloudflare account ids, database ids, bucket names, custom domains
- OAuth client ids and secrets
- The `[owner]` in `package.json`

Every one of these identifies whoever ran the extraction, not you. The tooling
that *uses* them is here; the values are yours.