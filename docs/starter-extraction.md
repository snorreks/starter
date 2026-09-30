# Starter extraction — working record

Extracted from `BearlySleeping/aikami` into a generic starter. This file is the
durable progress checklist and the keep/refactor/delete record. It is a working
document, not a framework.

## Provenance

- **Source:** `BearlySleeping/aikami` (remote `git@github.com:BearlySleeping/aikami.git`)
- **Source SHA:** `6d62500c294da402991801d26988f2f88db8f514`
  (= `origin/main`; `perf(ai): instrument the #382 production critical path (measurement only) (#413)`)
- **Copy context:** the working tree sat on local branch
  `perf/382-envelope-extraction` with 9 uncommitted WIP files. All 9 are
  game-specific (`npc_dialogue*` + a guard baseline) and are removed by this
  extraction, so the starter is content-equivalent to `6d62500c` minus them.
- **Isolation:** `starter/` was a plain file copy containing **no** `.git`
  directory, sharing no Git metadata with the original, with no hardlinked files
  outside `node_modules/` and no symlink pointing outside the tree. Inodes were
  confirmed distinct for `package.json`, `bun.lock`, `AGENTS.md`, `biome.json`.
  A fresh `git init` on an unborn `main` with zero remotes was created only after
  that was proven.
- **Recoverability:** the untouched original at `../aikami` is the checkpoint.
  Nothing destructive was done to Git metadata.
- **Target:** new public repo `snorreks/starter`, fresh `main` history.
- **Original left untouched:** re-verified at the end of the run
  (`git status` still the same 9 pre-existing WIP files, HEAD unchanged).

## Publication-target finding (blocks only step 14)

`gh api repos/snorreks/starter` (authenticated) follows a **rename redirect** to
the private repo `snorreks/starter-firebase` (id `1011417273`, branches `master`
and `aikami`, 198 MB, last pushed 2026-04-26). The anonymous web URL returns 404
because the redirect target is private. So the name `snorreks/starter` was used
previously and renamed away; that repository must not be touched, moved, or
repurposed.

Guard for the publish step: the newly created repository's id must not be
`1011417273`, and its remote HEAD must equal the local commit SHA.

## Toolchain facts discovered (each changed the implementation)

1. **SvelteKit 3 removed `$lib`.** The replacement is a subpath import.
2. **TypeScript 6.0.3 does not resolve package.json `imports`** in any
   `moduleResolution` mode (verified with a minimal repro using both `tsc` and
   `tsgo`). The working mechanism is SvelteKit's `alias`, which generates the
   tsconfig `paths` — so TypeScript and the bundler agree by construction.
3. **Elysia 1.4.30 imports `@sinclair/typebox`, not `typebox@1.3.34`.** Two
   module identities, so shared schemas could not be used in route definitions.
   The project now standardises on `@sinclair/typebox@0.34.52` (Elysia's own
   dependency), which removed the cast the inherited code needed.
4. **Elysia 1.4's `resolve` type injection does not survive this context shape**;
   handlers reported the injected property as absent with no useful diagnostic.
   Routes therefore call `buildRequestContext(request)` explicitly, which also
   makes the "no shared mutable request state" property readable in the code.
5. **Elysia 1.4's in-process `app.handle`/`app.fetch` return 404** unless the app
   is actually listening. Verified: a real listener returns 200. This is why the
   Worker integration test drives a real `wrangler dev` server.
6. **Drizzle query builders are thenable *and* async-iterable**, so `.then()`
   widens the result type. Handlers use `await`.
7. A `tsconfig` `paths`/`types` block **replaces** rather than merges with the
   extended config, which silently removed `$lib`. The base configs no longer
   carry them.

## Progress

### Phase 0 — Isolation and provenance — DONE
- [x] Working directory and Git metadata resolved
- [x] No shared Git dir / worktree linkage
- [x] No hardlinks or outbound symlinks into the original
- [x] Source SHA + local WIP delta recorded
- [x] Fresh independent repo, `main`, zero remotes

### Phase 1 — Inventory — DONE
- [x] Sensitive-file inventory (secrets, age recipients, `.dev.vars`, DBs, caches)
- [x] Aikami/Emberwatch identifier inventory (D1 ids, R2 buckets, custom
      domains, Tauri identifier + updater pubkeys, OAuth/Discord/GCP references)
- [x] Workspace / Moon graph / dependency inventory (44 projects -> 12)
- [x] CI, deploy, Tauri, auth/data, Pi extension inventory

### Phase 2 — Plan — DONE (this file)

### Phase 3 — Sanitize — DONE
- [x] Secrets, SOPS ciphertext, age recipients, transcripts, caches, evidence removed
- [x] Identity replaced: scope `@aikami` -> `@starter`, app ids, bundle ids
- [x] Bundled game assets and their licence ledger removed

### Phase 4 — Target architecture — DONE
- [x] `apps/frontend/client` (SvelteKit SPA + Tauri shell)
- [x] `apps/backend/api` (Elysia + TypeBox + D1 + Better Auth)
- [x] `packages/shared/{schemas,logger,utils}`
- [x] `packages/frontend/{ui,services}`
- [x] `packages/backend/{database,auth}`
- [x] `apps/e2e`, `scripts`, `.pi` — scaffolding present, contents in progress
- [x] Whole-workspace typecheck green

### Phase 5–12 — Remaining
- [ ] Tauri shell (capabilities, CSP, no sidecars, mobile path documented)
- [ ] Scripts: setup, db, logs family, deploy dry-run, guards, contract runner
- [ ] `.pi`: settings, skills, extensions (incl. log tool), prompts
- [ ] Tests: unit, real Svelte browser, Worker/D1 integration, Playwright E2E
- [ ] Visual fixtures + honest vision-review status
- [ ] CI workflow
- [ ] Documentation set
- [ ] Verification sweep + publication audit
- [ ] Publish `snorreks/starter`

## Keep / refactor / delete

### Kept and adapted
- **Structured logger** (spam dedup, loop throttle, sinks) — redaction moved into
  the package so `utils` no longer depends on it (removes a cycle).
- **`BaseClass`** — prototype shadowing instead of `Proxy`, with the Svelte 5
  rationale kept in the source.
- **`BaseViewModel` / `BaseFormViewModel` / `BaseViewModelContainer`** — the
  lifecycle and teardown logic is subtle and correct; preserved nearly verbatim.
- **Elysia + TypeBox + Drizzle/Better Auth** stack, re-pointed at `@starter/*`.
- **Moon task templates**, Biome boundary overrides, tsconfig presets.
- **Playwright-based real Svelte browser tests** and the Bun unit lane.

### Refactored
- `@aikami/*` scope -> `@starter/*`; import subpaths kept narrow on purpose.
- TypeBox `typebox@1.3.34` -> `@sinclair/typebox@0.34.52` (see fact 3).
- `$lib` -> `#lib` via SvelteKit `alias` (see facts 1–2).
- Guards: the Aikami ratchet/waiver ledger replaced with a small set of
  hard-invariant boundary checks. Architecture changed, so those policies were
  rewritten rather than baselined.

### Deleted
- All game code: PixiJS, bitECS, LPC, Emberwatch, NPCs, combat, campaigns, quests.
- All local AI sidecars: `text`, `image`, `voice`, `audio`, `local-stack`, and
  their model manifests and Docker topology.
- Community hub, marketing site, Astro docs app, Discord bot, always-on worker VM.
- Asset-generation pipelines and the ~40 `emberwatch_*` generator scripts.
- Discord, GCP/GCLOUD, Firebase, Stripe, OpenRouter runtime integrations.
- 442 contract documents, generated `PROGRESS.md`/`INDEX.md`/`llms.txt`.
- Aikami-specific guard baselines and waivers.

## Deliberate differences from Aikami
- **No Nix flake.** The inherited one bundled herdr, a PixiJS DevTools download and
  a Playwright browser farm — not maintainable for a generic template. `.envrc`
  is plain bash and requires only direnv, if that.
- **No `herdr`.** Optional transport convenience only; nothing in the ordinary
  workflow requires it.
- **One TypeBox, one subpath convention, one router.**
- **No offline sync engine.** Round 1 is honest about backend availability.
