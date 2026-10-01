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
on 1.4.3 would be told to downgrade to a version nobody asked them to use, and
the first thing the repository teaches them is that it does not work on their
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

## What Moon is for

Task orchestration and caching only. Each task delegates to a `package.json`
script, which stays the authority for what that script does. The architecture
rules live elsewhere and do not depend on Moon:

- Biome, for import boundaries and globals — see [lint.md](lint.md)
- `bun run guard`, for layer membership, request state, gitignored source and
  registry self-consistency — see `scripts/src/lib/guards/boundary.ts`

A Moon upgrade therefore cannot silently drop an architectural rule.

## Project graph

Moon 2 removed the workspace-level `layers` and `dependencyRules` blocks. The
graph they declared now lives in each project's `moon.yml` as `dependsOn`, next to
the `package.json` that declares the real dependencies — so the two can be
compared rather than trusted:

```
shared/   schemas, logger, utils          (no project dependencies)
backend/  database, auth                  -> shared
frontend/ ui, services                   -> shared
api                                      -> shared, backend
client                                   -> shared, frontend
scripts, .pi, e2e                       -> shared
```
