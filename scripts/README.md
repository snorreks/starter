# scripts

The tooling workspace: every `bun run …` command in this repository is implemented
here, and nothing else is a second implementation of one. It runs outside both
application planes, so it may import shared packages and may not import from `apps/`
code.

## Purpose and layout

The table below is the whole surface: one entrypoint, one module per subcommand, and
the shared modules every command resolves its paths and its pinned tools through.

| Path | Responsibility |
|---|---|
| `src/cli.ts` | The single entrypoint. `bun run scripts/src/cli.ts <command> …`. |
| `src/commands/` | One module per command: `dev`, `deploy`, `logs`, `db`, `secrets`, `guard`, `setup`, `ci`. |
| `src/shared/paths.ts` | Repository paths, in one place, with a test — the wrong `../` depth is silent. |
| `src/shared/tools.ts` | Resolves a pinned tool through the workspace package that declares it. Never `bunx`. |
| `src/deploy/` | The deployment pipeline and its one target resolver. |
| `src/guards/` | The resolved dependency graph and the whole-repository invariants. |
| `src/logs/` | The log CLI: adapters, filters, redaction, capability rules. |
| `tests/` | Tests for all of the above, including the negative controls. |

## Setup

Nothing to install beyond the workspace itself. `wrangler`, `drizzle-kit` and
`playwright` are declared by the single package that uses them and are resolved
through it; `bunx` from the root downloads whatever the registry serves, which is how
a lockfile pinned at 4.142.0 ends up running 4.144.0.

## Commands

Run from the repository root (the root scripts delegate here).

```bash
bun run setup && bun run setup:doctor     # install prerequisites, prove the browser launches
bun run dev | dev:worker                  # run the app
bun run test | test:browser | test:worker | e2e
bun run typecheck | lint | format | fix
bun run guard | guard:whole-repo          # repository invariants
bun run workflows                        # CI workflow policy
bun run db:generate | db:migrate | db:status | db:seed
bun run deploy:status | deploy:check | deploy:preflight | deploy:apply | deploy verify
bun run logs web --mode local
bun run smoke                            # fresh-checkout rehearsal, no credentials
```

## Validation and artifacts

`bun run test` runs the unit suite and prints a nonzero count that the CI lane
asserts; `tests/browser_launch.test.ts` is a separate lane because it spawns real
Chromium processes. The guards are proved against disposable fixture trees, so a rule
can be shown to fail without breaking this repository. `bun run smoke` rehearses a
fresh checkout end to end.

Artifacts: none. This project produces no build output, and `tests/fixtures` holds
data rather than directories — a nested `package.json` inside a workspace member is
something `bun install` has opinions about.

## Boundaries

- One authority decides what a command would change: `src/deploy/target.ts` exports
  `resolveTarget(environment)`, and nothing else resolves a destination.
- A subprocess is always bounded: bytes, time, cancellation, exit status.
- A command that cannot do its work exits nonzero and says why. It never prints
  advice and exits 0.
- `secrets:edit` exits 4 on purpose; `sops <file>` is the editor.

## Canonical docs

[architecture](../docs/architecture.md) · [deployment](../docs/deployment.md) ·
[logs](../docs/logs.md) · [secrets](../docs/secrets.md) ·
[testing](../docs/testing.md) · [agent](../docs/agent.md) ·
[lint](../docs/lint.md) · [toolchain](../docs/toolchain.md)