# Toolchain

Three files decide which Bun this repository runs on, and they have to agree.

| File | Read by | Should it be edited? |
|---|---|---|
| `.bun-version` | `oven-sh/setup-bun` in CI, and `proto` when Moon resolves the `bun` toolchain | Yes — the single source of truth |
| `.github/workflows/ci.yml` → `BUN_VERSION` | CI | Only in step with `.bun-version` |
| `.moon/toolchains.yml` | Moon | **No.** The `version` key is deliberately absent; see below |

```bash
grep -h . .bun-version                      # 1.4.2
grep A 'BUN_VERSION' .github/workflows/ci.yml
```

## Why `.moon/toolchains.yml` does not pin a version

It can, and it used to. Moon delegates toolchain management to `proto`, and proto
treats an explicit `version` as a hard requirement: with one pinned, every task in
every project fails with `missing_tool` unless that exact patch is installed, and
proto will not fall back to a Bun on your `PATH`.

That is right for a CI image you control and wrong for a template. A contributor
on 1.4.3 would be told to downgrade to a version nobody asked them to use, and the
first thing the repository teaches them is that it does not work on their
machine. Without the pin, proto auto-detects, and `.bun-version` still governs CI.

## If Moon reports a missing tool

```
proto::commands::run::missing_tool
```

Either install the version through proto:

```bash
proto install bun "$(cat .bun-version)"
```

or delete `.bun-version` and accept an unpinned CI. Do not do neither — the first
option keeps CI reproducible, the second keeps the repository usable, and skipping
both means `bun run test` fails for a reason that has nothing to do with your
change.

This error is the single most confusing thing a new contributor will hit here, and
it is a consequence of a genuine trade-off rather than a bug.

## The TypeScript compiler: `tsc`, not `tsgo`

Eight of the eleven typecheck tasks run `tsc --noEmit`. The other three run
`svelte-check`, because `tsc` cannot type-check a Svelte component and nothing
else in the toolchain can.

They used to run `tsgo`, from `@typescript/native-preview`, pinned at
`7.0.0-dev.20260707.2`. Three reasons that changed:

1. **It is a prerelease, and the pin had gone stale.** `7.0.0-dev` is not a
   supported release line. Queried on 2026-10-02, the registry's `latest` for
   `@typescript/native-preview` was still the same `7.0.0-dev.20260707.2` — two
   months old, with no newer supported tag. Pinning a template to a
   two-month-old nightly is a liability, not a choice.
2. **The pin contradicted itself.** `.syncpackrc` grouped `typescript` *and*
   `@typescript/native-preview` under one `6.0.3` range. A `6.0.3` range cannot
   hold a `7.0.0-dev` range, so the group documented an impossibility instead of a
   constraint. The group now names only `typescript`.
3. **`tsc` is the authoritative fallback anyway.** `docs/toolchain.md`'s rule for
   an unreleased dependency is: use the supported release until the preview is
   stable *and* its compatibility has been demonstrated. Neither condition held.

What was **not** done: no mass upgrade, no second version manager. Bun remains the
tooling runtime, `.bun-version` remains the only Bun pin, and `typescript` stays
at `6.0.3`. If `@typescript/native-preview` reaches a stable release, switching
back is one dependency and eight script edits — `scripts/tests/` covers the
behaviour that would have to stay true.

### Node is still required

`wrangler dev` and Vite both shell out to Node, so `test:worker`, `dev:worker` and
`e2e` need `node` on `PATH`. `flake.nix` supplies `nodejs_22`. This is the one
place a second runtime is load-bearing, and `bun run setup:doctor` checks it.

## Why Moon is for orchestration, not correctness

Moon orchestrates and caches. Each task delegates to a `package.json` script,
which stays the authority for what that script does. The architecture rules live
elsewhere and do not depend on Moon:

- Biome, for import boundaries and globals — see [lint.md](lint.md)
- `bun run guard`, for layer membership, request state, gitignored source and
  registry self-consistency — see `scripts/src/guards/boundary.ts`

A Moon upgrade therefore cannot silently drop an architectural rule.

## What Moon's cache can and cannot see here

Moon 2.5.5 cannot build a cache key equal to the set of files these commands
read. Both halves were measured on this workspace:

1. **A task cannot name a file outside its project.** `'../../biome.json'` fails
   to parse with `parent directory traversal (..) is not supported`.
   `fileGroups` are project-scope only in 2.5.5, and the workspace `hasher` block
   offers only `ignorePatterns`, `ignoreMissingPatterns`, `optimization` and
   `walkStrategy` — nothing additive. So `bun.lock`, root `package.json`,
   `bunfig.toml`, `biome.json`, `config/toolchain.json` and every
   `config/tsconfig/*.json` is unreachable from any task, and they decide the
   result of every task here.
2. **A task's key does not include its dependencies' keys.** With `utils:test`
   declaring `deps: ['logger:test']`, editing
   `packages/shared/logger/src/index.ts` re-ran `logger:test` under a new hash
   while `utils:test` reported `cached, 2b8e371c` — byte-identical to the run
   before. `dependsOn` orders the graph; it does not propagate content.

So the cache is not disabled globally, because that would be a habit rather than
a decision. Every root script that fans out to Moon goes through:

```bash
bun run scripts/src/cli.ts cached -- <targets>
```

It fingerprints exactly the files Moon cannot see — the list above plus every
workspace package's sources and manifests — and picks Moon's own `--cache` mode:

| Fingerprint | Mode | Effect |
|---|---|---|
| no previous value | `--cache off` | records one, caches nothing |
| changed | `--cache off` | every task re-runs |
| unchanged | `--cache read-write` | a cached hit is sound |
| unreadable, or zero files resolved | `--cache off` | fails closed |

An unreadable fingerprint means `off`: `off` costs time, a wrong `read-write`
costs correctness.

No remote cache. No Redis. No experimental shared-worktree cache. A remote cache
server is a service to run, secure, pay for and invalidate correctly before it
saves anyone a single build, and a shared-worktree cache would need the same
invalidation logic this module already has to do locally.

## Formatting: Biome only

Biome is the only formatter, and it handles Svelte. Verified on this repository's
own source, not assumed:

- Biome 2.5.13 formats the `<script lang="ts">` block of a `.svelte` file —
  including `$props()`, `$derived`, `$effect` and TypeScript generics — and leaves
  the markup, `{#if}` blocks and `<style>` untouched.
- `packages/frontend/ui/src/screen_container.svelte` — a Svelte component with a
  `<script lang="ts">` block and a `<style>` block, formerly
  `packages/frontend/ui/src/base/base_view_model_container.svelte` — round-trips
  through `biome format --write` with a byte-identical result.

Biome's Svelte support is partial: the **markup and CSS are not formatted**. That
is a gap, not a reason to add a second formatter. Adding `prettier-plugin-svelte`
would create *overlapping* scope on the same files — two formatters, two
configurations, and a question about which one owns a `.svelte` file. The scopes
here are disjoint by construction instead:

| Tool | Owns |
|---|---|
| Biome | `*.ts`, `*.json`, `*.jsonc`, and the `<script>` block of `*.svelte` |
| Svelte's own compiler | markup, `<style>`, and everything else in a component |

One dependency-update configuration exists, `.github/dependabot.yml`. Not
Renovate, not a second scanner: each of those is a second credential, a second
thing to keep current, and a second opinion about the same manifest.

## Rust

Two first-party crates exist as of PR G (`apps/backend/media` now, the native
shell when PR D restores it). They share **one toolchain policy** and keep
**separate dependency sets**: `rust-toolchain.toml` beside each crate pins the
compiler and its components, and each crate's own `Cargo.toml` and `Cargo.lock`
pin its dependencies.

| Decision | Value | Why |
|---|---|---|
| Compiler | `1.98.1`, in each crate's `rust-toolchain.toml` | A template whose verification depends on whichever patch release the day shipped is not reproducible. |
| Components | `clippy`, `rustfmt`, explicitly | Both are in the task list, so neither may be silently absent on a contributor's machine. |
| `targets` | none | Mobile and desktop triples are added by the native crate, which knows what it builds. A global list would force the container builder image to install mobile SDKs. |
| Dependencies | exact versions (`=1.0.229`) plus a committed `Cargo.lock` | Matches the Bun rule already in this file: one authority, no resolver surprises. |
| Cargo tasks | `cargo-test`, `cargo-lint`, `cargo-format`, `cargo-build`, `cargo-image` in `moon.yml`, **not** `test`/`lint`/`format` | The root scripts select tasks by name. A task named `test` would put Cargo into `bun run test`, and the credential-free web lanes are documented to need no Rust toolchain. See `apps/backend/media/moon.yml`. |
| Moon caching | disabled for `cargo-lint`; other tasks use Moon's default policy | Clippy's declared inputs omit the configuration group, including `rust-toolchain.toml`; see `apps/backend/media/moon.yml`. |
| Formatting | `rustfmt.toml`, `max_width = 100` | The same 100 columns Biome enforces on the TypeScript half. |

Rust is **not** in `config/toolchain.json`. That file is the authority for
versions the *Nix flake* and the web tooling read; Rust is not supplied by the
flake yet, and adding a key nothing reads would create a second place to update.
When `flake.nix` grows a Rust package set, the flake reads this section's number
from `toolchain.json` and the `version-mirrors` guard starts checking it, exactly
as it does for Bun.

FFmpeg is not a Rust dependency at all. It is a system binary, pinned by Debian
package version inside the image and documented in
`apps/backend/media/THIRD_PARTY.md`.

## Workflow and dependency checks

`bun run workflows` parses `.github/workflows/*.yml` and asserts four properties,
each of which corresponds to a way this repository's CI has previously reported
success without checking anything:

| Rule | The defect it prevents |
|---|---|
| `permissions` declared | the repository default is repository-wide, handing write scope to every step |
| every job has `timeout-minutes` | a hang occupies a runner until the platform gives up |
| `uses:` pinned to a 40-character SHA | a tag is a mutable pointer into the thing that runs your code |
| no `secrets.*` in a workflow that runs `pull_request` | a fork cannot provide one, so the step fails there and passes on branches |

`pull_request_target` is refused on its own, because it is neither untrusted nor
safe: it runs with the base repository's privileges against code the pull request
controls.

It is four rules on purpose. A fleet of overlapping scanners is a second thing to
keep current and a second thing that can be wrong.