# Agent tooling (Pi)

Pi is the coding agent this repository is set up for. Everything here is a
default, not a requirement — delete anything you do not want and `pi` still works.

```bash
pi                      # start, in this directory
pi config -l            # edit .pi/settings.json interactively
pi list                 # what is loaded
```

## Trust

`.pi/settings.json` and `.pi/extensions/*` are **code that runs**. Pi asks before
loading project-local files, and the answer is to say yes only for repositories you
have looked at.

That prompt is not ceremony. A project extension is arbitrary code executing with
your permissions, and a template that trains you to accept it teaches the wrong
habit. `defaultProjectTrust` is `ask`, not `always`, for that reason.

## What is here

| | |
|---|---|
| `.pi/settings.json` | Tool and resource defaults |
| `.pi/extensions/logs.ts` | The `read_logs` tool |
| `.pi/skills/adding-a-feature/` | The conventions, as a skill |
| `.pi/skills/debugging-with-logs/` | How to read logs, and what refusals mean |
| `.pi/prompts/review.md` | `/prompt:review` |
| `.pi/prompts/check.md` | `/prompt:check` |

## The log tool

```ts
read_logs({ app: "api", mode: "local", level: "ERROR" })
read_logs({ app: "api", mode: "local", traceId: "trace_abc" })
```

It shells out to `bun run logs`, so an agent debugs against the same adapters,
capability rules and redaction a human does. An agent with its own quieter log path
is an agent that debugs against different data, and the two eventually disagree
about what happened.

Two deliberate constraints:

- **Output is capped at 200 lines.** Unbounded output ends the useful part of the
  conversation.
- **`--follow` is never emitted.** A tool call that never returns blocks the agent
  indefinitely.

A non-zero exit is an answer, not a tool failure. The CLI's refusals are phrased to
be relayed — `capability_unsupported` says which adapter and which filter, so the
agent can tell the user what is actually possible rather than retrying.

The argv builder is tested against the CLI's own source, so a renamed flag fails a
test instead of becoming a silently-ignored argument:

```
17 tests, including "the CLI parses every flag this tool can emit"
```

## Skills

A skill is a directory with a `SKILL.md`. Pi advertises its name and description
and loads the instructions only when the task matches, so detailed guidance stays
out of context until it is needed.

```bash
/skill:adding-a-feature
/skill:debugging-with-logs
```

**Write the description to say when it applies**, not just what it is. The
description is the routing signal: "Helps with adding features" gives a model
nothing to route on; "Use when adding an entity, endpoint or screen — anything that
needs a schema, a route, a ViewModel, a service and tests" gives it a boundary.

## Prompts

```
/prompt:review [focus]   # review the diff, prioritised by what breaks
/prompt:check            # run every check and report the first real failure
```

`review` is ordered by consequence: authorization first, then input refusal, then
concurrency, then silent failure, then boundary violations. It is told to state
plainly when it found nothing in a category rather than inventing a finding — an
invented finding costs more than a missed stylistic one.

## One TypeBox exception

`.pi/extensions/logs.ts` imports `typebox` (1.x) while the rest of the repository
uses `@sinclair/typebox` (0.34).

This is forced. Pi's `registerTool` consumes a TypeBox 1.x schema object and
cannot read a 0.34 one, and an extension that does not touch the server has no
reason to depend on Elysia. The two meet only at this boundary, so the exception
stops at `.pi/` and is recorded in `.pi/tsconfig.json`.

## Contracts

For a change where "done" needs saying before the work starts:

```bash
bun run contract new "Add thing export as NDJSON" --mode standard
bun run contract run docs/contracts/C-001-....md
bun run contract status
```

Two templates in `docs/contracts/`:

- `THIN_TEMPLATE.md` (standard) — problem, acceptance criteria, out of scope,
  verification. The default.
- `TEMPLATE.md` (full) — adds a written design and a written **critique** of it
  before implementation.

Use `standard` unless there is a real design decision with more than one reasonable
answer. Full mode costs a document review before any code exists; for a change with
one obvious implementation that becomes paperwork somebody rubber-stamps.

The runner is a bounded, resumable state machine with injectable stages, so the
whole lifecycle can be exercised in CI with no model provider and no credentials.
It has no code path that can merge or deploy: **creating a contract does not
authorise publishing its result.**

## Removing it

`rm -rf .pi && bun run moon run pi:* 2>/dev/null`. Nothing else in the repository
depends on it — the guards enforce the architecture, not the agent config.