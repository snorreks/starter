# Starter extraction — working record

The keep / refactor / delete record for turning a private game project into a
generic starter. This is a working document, not a framework, and nothing else in
the repository depends on it.

## Provenance

The source was a private monorepo: a game project with roughly 5,000 files, of
which about 12 projects survived this extraction. The original repository, its
remotes, its credentials and its deployments were never modified.

- **Isolation:** `starter/` was a plain file copy containing **no** `.git`
  directory, sharing no Git metadata with the source, with no hardlinked files
  outside `node_modules/` and no symlink pointing outside the tree. Inodes were
  confirmed distinct for `package.json`, `bun.lock`, `biome.json`.
  A fresh `git init` on an unborn `main` with zero remotes was created only after
  that was proven.
- **Recoverability:** the untouched source checkout is the checkpoint. Nothing
  destructive was done to its Git metadata.
- **Git history:** twelve commits, all created in this repository. No commit from
  the source appears in it, and no object alternates file to it.
- **Copy context:** the working tree sat on a feature branch with 9 uncommitted
  WIP files. All 9 were game-specific (NPC dialogue and a guard baseline) and are
  removed by this extraction.

## Publication target

`snorreks/starter` — fresh `main` history, no remote until publication.

The name was previously used by a private repository that has since been deleted.
Verified read-only immediately before publishing: `gh api repos/snorreks/starter`
returns 404 with no redirect, and the former target's id is not reusable. A new
repository's id will differ, which the publication step checks.

## What was removed

Everything specific to the source project, by category:

- **The game.** Rendering engine, entity-component library, LPC content, the
  NPC, combat, campaign and quest systems.
- **Asset pipelines.** Around 40 generator scripts and the assets they produced.
- **Other products.** A marketing site, a documentation app, a community hub, a
  Discord bot, a GCP worker VM.
- **Local AI sidecars.** Model servers and the tooling around them.
- **Contract documents.** 442 of them, describing the source project's own work.
- **Guard baselines and waivers.** Replaced with five invariants that have no
  baseline and no waiver mechanism.
- **Inherited identifiers.** D1 ids, R2 buckets, custom domains, OAuth clients,
  Tauri updater signing keys, SOPS recipients and age identities. All of these
  identify the source project, not the template.

## What was kept and rebuilt

Almost nothing was carried across unchanged. The conventions were worth keeping;
the implementations mostly were not.

| Kept | Change |
|---|---|
| The layered architecture | Boundaries made explicit and enforced by a guard and the linter |
| Structured logging | Redaction moved into the package so `utils` no longer depends on a cycle |
| Schema-per-domain | One TypeBox, `@sinclair/typebox`, matching Elysia 1.4 |
| Ownership in the query | Kept as the rule, with a test that a cross-account read is refused |
| A ViewModel/service/page split | Kept; `status` became a tagged union |
| The log CLI family | Rebuilt; ~60 tests, capability declarations made explicit |

## Deliberate differences

- **No Nix flake, no task-runner plugin.** The inherited one bundled a terminal
  multiplexer, a DevTools download and a project-specific transport. Plain bash
  and `moon` cover what a starter needs.
- **No multi-tenancy, no plugin framework, no server actions.** Each would be a
  second way to do something this repository already does once.
- **No paid observability.** Local files plus Cloudflare Logpush answer "what
  happened to this request" without an account to manage.
- **New history, not a filter-branch.** Filtering a large history would carry
  every inherited blob, including files no longer referenced. A fresh repository
  cannot.

## Phase 5–12

- [x] Tauri shell (capabilities, CSP, no sidecars, mobile path documented)
      — `cargo check` passes against real GTK/WebKitGTK. Mobile *builds* need the
      Android NDK and Xcode, neither present here, so the desktop path is the one
      verified. `cargo clippy` is not installed.
- [x] Scripts: setup, db, logs family, deploy dry-run, guards, contract runner
      — 130 unit tests. Note the log CLI was silently gitignored until Rule 4
      existed; see the guard's docstring.
- [x] `.pi`: settings, skills, extensions (incl. log tool), prompts
      — 17 tests over the log tool's argv builder.
- [x] Tests: unit, real Svelte browser, Worker/D1 integration, Playwright E2E
      — 333 unit / 15 browser / 12 integration / 17 e2e.
- [x] Visual fixtures + honest vision-review status
      — four real screens captured; vision inspection reports as SKIPPED with a
      reason, never as a pass.
- [x] CI workflow — three jobs, no secrets.
- [x] Documentation set — architecture, adding-a-feature, testing, logs, lint,
      toolchain, cloudflare, native, secrets, agent, rename-checklist.
- [x] Verification sweep + publication audit
      — zero credential-shaped values, zero private keys, zero provisioned
      resource ids, no inherited identifiers outside this file.

## Config that had never run

Three configurations were invalid on arrival and had therefore never executed.
Each is worth recording, because a config that fails to parse reports nothing —
which reads exactly like "no problems".

| File | Was | Symptom |
|---|---|---|
| `biome.json` | Six keys absent from Biome 2.5 | `bun run lint` produced no result, ever |
| `.moon/workspace.yml` | `layers`, `dependencyRules`, `vcs.manager` removed in Moon 2 | Every root script failed |
| `.gitignore` | `logs/` unanchored | Silently excluded `scripts/src/lib/logs/` — the whole log CLI, 8 files, whose 31 tests passed locally while absent from git |

The third is why `source-is-tracked` exists as a guard. An ignored source file
cannot be reviewed, reverted, or cloned, which makes it worse than a known bug.

## Lint and format

`biome.json` migrated; `bun run lint` and `bun run format` are both clean on 181
files. Two rules are off because they cannot be satisfied honestly — see
[lint.md](lint.md), which records why and what to watch.