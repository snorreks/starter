# .pi

Pi agent configuration for this repository: the settings, the extension
entrypoints, the helpers behind them, the tests, the skills and the prompts.

## Purpose and runtime

Node and Bun, outside both application planes — the same plane as `scripts/`. Pi
loads every module in `extensions/` at start-up, so this is code that runs with
your permissions; `defaultProjectTrust` is `ask` for that reason.

One directory rule is load-bearing and is not stylistic: **`extensions/` holds
entrypoints only.** A helper placed there is loaded as an extension on every
start, and a test placed there fails every start. Helpers go in `lib/`, tests in
`tests/`. `.pi/tests/pi_loader.test.ts` enforces this against Pi's real resource
loader, and `bun run --cwd .pi loader:smoke` runs it in CI, because `bun test`
passes on files Pi cannot load.

| | |
|---|---|
| `settings.json` | Tool and resource defaults |
| `extensions/` | Entrypoints: one file per tool, plus `edit-policy.ts`, which registers none |
| `lib/` | Helpers. No Pi imports, testable without a runtime |
| `tests/` | Tests, including the loader smoke test |
| `skills/` | The conventions, as skills |
| `prompts/` | `/prompt:review`, `/prompt:check` |
| `background-tasks/`, `handoffs/` | Their own READMEs; not hand-written run state |

## Setup and configuration

```bash
bun run --cwd .pi test           # the suite
bun run --cwd .pi loader:smoke   # does Pi's real loader accept this layout?
bun run --cwd .pi typecheck
```

`herdr` is optional. `extensions/herdr.ts` reports a named unavailable capability
when it is absent, and nothing here blocks on it.

## Commands

Tools are not shell commands, so the commands that exercise this project are its
own scripts, from `scripts/`'s point of view:

```bash
# From the repository root
bun run --cwd .pi test
bun run --cwd .pi loader:smoke
bun run --cwd .pi typecheck

# From .pi/
bun test tests
```

Each tool shells out to the real project command — `repo_task` runs Moon tasks,
`logs` runs `bun run logs` — so a green agent run and a green CI lane cannot
disagree about what the repository does.

## Tests and artifacts

`.pi/tests/` covers argv construction without a Pi runtime (herdr absent, no
child process), the owned-child guarantee (a job's pid is planted and verified
before any signal), the tool-surface budget, and the loader layout above.

Artifacts: none. Hand-off notes in `.pi/handoffs/` are written by the tool and are
git-ignored on purpose — a note is a claim about a moment, not source.

## Boundaries and documentation

May import `@starter/*` packages only. May not import from `apps/`, and may not
import `scripts/` source by relative path: the two packages are built together
and expose their shared code through `@starter/utils` and friends, so a relative
path across that boundary is exactly what the guard now refuses.

- [docs/agent.md](../docs/agent.md) — the canonical write-up: trust, the tool surface, why `extensions/` is entrypoints only
- [docs/logs.md](../docs/logs.md) — the log CLI behind the `read_logs` tool, and its refusals
- [docs/testing.md](../docs/testing.md) — how the tests here avoid depending on a real agent
