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

The portable workflow package provides one deferred Playwright browser namespace for
exploratory browsing. It has no project runtime identity and cannot certify a Starter
run. Keep it as the single default local browser driver; enable Bladebro only as an
explicit alternative, not alongside it.

## What is here

| | |
|---|---|
| `.pi/settings.json` | Tool and resource defaults |
| `.pi/extensions/logs.ts` | The `read_logs` tool — entrypoint only |
| `.pi/extensions/repo_task.ts` | Discover and run the repository's own tasks |
| `.pi/extensions/dev_process.ts` | Start, watch and stop owned long-running processes |
| `.pi/extensions/handoff.ts` | Write and resume durable handoff notes |
| `.pi/extensions/herdr.ts` | Isolated worktrees — **optional**, absent by default |
| `.pi/extensions/edit-policy.ts` | Refuses exact-string `edit`; enforces anchored `edit_lines` |
| `.pi/lib/logs_args.ts` | argv construction, no Pi imports, testable without a runtime |
| `.pi/lib/tasks.ts` | Moon task graph discovery and argv |
| `.pi/lib/jobs.ts` | Job handles, bounded logs, owned-child cleanup |
| `.pi/lib/handoff.ts` | Handoff notes and the staleness check |
| `.pi/lib/herdr_cli.ts` | The Herdr boundary, as a capability that can be absent |
| `.pi/lib/process.ts` | Bounded, cancellable subprocess runner — shared by every tool |
| `.pi/lib/tool_namespace.ts` | Registers a family of actions as **one** tool |
| `.pi/tests/` | Tests, including the loader smoke test and the tool-surface budget |
| `.pi/skills/adding-a-feature/` | The conventions, as a skill |
| `.pi/skills/debugging-with-logs/` | How to read logs, and what refusals mean |
| `.pi/skills/herdr-worktrees/` | Isolated worktrees, ports, install, handoff |
| `.pi/skills/reviewing-a-pr/` | CI, review threads, stale findings |
| `.pi/skills/browser-debugging/` | Screenshots, traces, console, network evidence |
| `.pi/skills/handoff/` | Writing and resuming a handoff note |
| `.pi/prompts/review.md` | `/prompt:review` |
| `.pi/prompts/check.md` | `/prompt:check` |

The trusted project profile `.pi/workflow.json` declares only the `describe` command.
Run `bun run agent -- describe --json` to see actual project capability owners and
unavailable operations with their dependencies. `bun run agent -- doctor --profile
built --json` reports the built runtime as unavailable and exits 3 until the owned
runtime lifecycle exists. `bun run agent -- review --run <id> --json` reviews an
existing complete capture manifest through the same reviewer as
`bun run e2e:visual:review -- --run <id>`; it does not start capture services. The
visual review config takes `E2E_VISION_API_KEY` as an optional per-project override,
then reads `OPENROUTER_API_KEY` from the process environment. Keep that shared
credential in your global environment rather than a project mode file. Task,
development runtime, and log operations continue through their local tools.

## `.pi/extensions` is executable input, not a source folder

**Pi loads every module it finds in `.pi/extensions` as an extension.** A helper or
a test placed there is loaded on every start.

This repository once had `.pi/extensions/logs.test.ts` (now `.pi/tests/`). It imported `bun:test`, so
starting the agent produced an extension error every time — and `bun test` passed,
because Bun does not care what Pi can load. A passing suite told you nothing about
whether the agent started.

The layout is now: **entrypoints in `extensions/`, helpers in `lib/`, tests in
`tests/`.**

That is enforced, not documented:

```bash
bun run --cwd .pi loader:smoke
```

`tests/pi_loader.test.ts` drives the real pinned Pi `DefaultResourceLoader` with an
isolated `agentDir` and asserts that `.pi/extensions` loads with **zero** errors and
that each tool is registered exactly once. It also writes a deliberately misplaced
module into a *temporary* extensions directory and asserts the loader **reports**
it — without that negative control, "no errors" could pass merely because nothing
was loaded.

It makes no LLM request and reads no credentials.

Three more suites guard the parts a unit test cannot see:

| Test | Guards |
|---|---|
| `tests/pi_loader.test.ts` | The real loader accepts this layout, with a negative control |
| `tests/optional_capabilities.test.ts` | Every extension loads with `PATH` emptied |
| `tests/tool_surface.test.ts` | The prompt budget, and that no tool re-adds `promptGuidelines` |

`tests/task_graph.test.ts` queries this repository's **real** Moon installation
rather than a fixture, so the JSON shapes the parser handles are the ones Moon
actually emits. It is local, read-only, and needs no credentials.

## The log tool

```ts
read_logs({ app: "web", mode: "local", source: "worker", level: "ERROR" })
read_logs({ app: "web", mode: "local", source: "browser", since: "15m" })
read_logs({ app: "web", mode: "local", runId: "e2e_run_42" })
```

It shells out to `bun run logs`, so an agent debugs against the same adapters,
capability rules and redaction a human does. An agent with its own quieter log path
is an agent that debugs against different data, and the two eventually disagree
about what happened.

Three deliberate bounds:

- **At most 200 lines.** Unbounded output ends the useful part of the conversation.
- **`--follow` is never emitted.** A tool call that never returns blocks the agent
  indefinitely.
- **512 KB of output, a real timeout, and a cancellation signal.** A line limit
  bounds lines, not bytes, and bounds what the CLI chooses to emit — not what the
  process writes. Output past the byte budget is truncated and spilled to a file
  whose path the model is told, because a tool that silently drops the interesting
  part is worse than one that says where to look. A process killed by the timeout
  reports exit 124 rather than 0, so "timed out" never reads as "succeeded".

`.pi/lib/process.ts` is shared, not per-extension, and is exercised against real
processes rather than mocks.

A non-zero exit is an answer, not a tool failure. The CLI's refusals are phrased to
be relayed — `capability_unsupported` says which adapter and which filter, so the
agent can tell the user what is actually possible rather than retrying.

The argv builder is tested against the CLI's own source, so a renamed flag fails a
test instead of becoming a silently-ignored argument:

```
the CLI parses every flag this tool can emit
```

## The other three tools

All three are **one tool each, with an `action` discriminator** — not one tool per
action. See [The tool surface budget](#the-tool-surface-budget) for why that
matters more than it sounds.

### `repo_task` — the repository's own tasks

```ts
repo_task { action: "list", params: { query: "test" } }
repo_task { action: "run",  params: { task: "pi:test" } }
```

It reads the real task graph through `moon query tasks` rather than guessing a
`bun run` script, because several root scripts are aggregates over that graph
(`bun run test` is `moon run :test`) and only the task ids know which project edge
carries the inputs and the caching. An unknown id is refused **before anything is
spawned**, with the nearest real ids — Moon's own error for an unknown task does
not say what you probably meant.

`moon query tasks` writes its `$ …` banner to **stderr** and JSON to **stdout**.
Merging the two streams, which is the obvious thing to do, makes `JSON.parse`
throw on a valid response.

### `dev_process` — owned long-running processes

```ts
dev_process { action: "start", params: { args: ["bun", "run", "dev"] } }
dev_process { action: "status", params: { job: "job-…" } }
dev_process { action: "logs",   params: { job: "job-…" } }
dev_process { action: "stop",   params: { job: "job-…" } }
```

Pi's `bash` returns when the command returns, so a dev server has to be
backgrounded and then *inferred* from its log — which fails in the worst
direction, because a linking phase that has printed nothing for thirty seconds is
indistinguishable from a finished build.

So `start` returns a **handle and a log path** immediately, and completion is only
ever the process's own exit status. Quiet output is reported as an observation and
never as a state transition; every status line for a running job says so outright.

State lives in `.pi/background-tasks/` (gitignored, with a `README.md` kept), so a
session that dies mid-build leaves a record rather than an orphan process.

Three details that are load-bearing:

- **A stop signals the whole process group.** Signalling only the direct child
  leaves a grandchild holding the inherited stdout pipe, so the job never reports
  as stopped.
- **A stop checks ownership first.** Each child gets a random token in its own
  environment; before signalling, the token is read back from
  `/proc/<pid>/environ`. A recycled pid therefore gets **refused** rather than
  killed — that is somebody else's process. Where `/proc` is unavailable the
  verdict reports `verified: false` instead of pretending it passed.
- **A killed job reports exit 124**, not 0. "Timed out" and "stopped" must not
  read as a pass, and neither is a failure of the process itself.

### `handoff` — notes outside tracked source

```ts
handoff { action: "write", params: { name: "pr-f-…", objective: "…", nextStep: "…" } }
handoff { action: "read",  params: { name: "pr-f-…" } }
```

Notes live in `.pi/handoffs/`, gitignored. Committed, a handoff lands in history,
appears in every clone, and goes stale the moment anyone else pushes. `write`
verifies the rule is actually in `.gitignore` via `git check-ignore` and refuses
otherwise.

**A note is a claim, not a fact.** `read` compares its recorded head, branch and
worktree against the live repository and reports every claim that no longer
holds. Even when nothing contradicts it, the output says the position matches and
that this is *not* evidence the described results still hold. An empty failure
list renders as *"None observed. This is not the same as verified."* — because
nobody having recorded a failure is a different claim from everything having
passed, and only the second is usually false.

The `handoff` skill is the workflow; this is the mechanism.

### `herdr` — an optional capability

```ts
herdr { action: "status" }
herdr { action: "worktree_list", params: { cwd: "<repo root>" } }
herdr { action: "worktree_create", params: { cwd: "<repo root>", branch: "pr-f-…", base: "main" } }
herdr { action: "help", params: { group: "worktree create" } }
```

**`cwd` is required for `list`, `create` and `open`.** Herdr picks a repository
itself when `--cwd` is absent, and the one it picks is not this project: creating a
worktree from this extension with no `cwd` produced a checkout of an unrelated
dotfiles repository and reported success, with a real path and a real workspace id.
Every later call then ran against the wrong project, and nothing looked wrong until
something was pushed somewhere it should not have been. `worktree_remove` is exempt —
it acts on a workspace id, which already names its checkout.

Pass the directory that contains `.git`. A path without one is refused too:
presence is not validity, and Herdr resolves the target from whatever it is given.

See [Optional capabilities](#optional-capabilities) below.

## The editing policy

Exact-string `edit` is **disabled in this repository**: removed from the tool surface at `session_start` and refused at call time, with no retry allowance. The only way to change an existing file is `edit_lines`, anchored to the line numbers and 3-character hashes that `read` printed.

**Why an enforcement rather than a rule in `AGENTS.md`.** `edit` requires every `oldText` to match a unique region of the file byte-for-byte, which makes its correctness depend on the caller reproducing file text exactly. That is the one thing a model does badly, and context compaction, offloading and summarisation all degrade it further. The result was the most common error in this repository:

```
Could not find the exact text in scripts/src/deploy/remote_config.ts.
```

**What it is not.** The formatter hypothesis was tested and eliminated, not assumed: no extension in `~/.pi/agent` rewrites files, an 80-second idle watch over 714 files in two repositories found zero content changes, and Zed's `format_on_save` only runs when Zed saves a buffer, which an external write never causes. The two files named in those errors were already Biome-clean, so a format pass had nothing to change in them.

**Two halves, because one is not enough.** Hiding a tool is a convenience: `tool_search`, a command, or another extension can activate it again mid-session. Only the `tool_call` refusal is the guarantee, and the test drives that half separately so neither can regress unnoticed.

**It fails open, deliberately.** `edit_lines` is not a Pi built-in — it arrives with a package. Refusing `edit` while no anchored editor is registered would leave no way to modify an existing file at all, which is worse than the error being prevented. So the refusal is conditional on the anchored editor being present, and both branches are tested.

**It is not a sandbox.** `bash` can still rewrite files. This governs tool selection, not the filesystem, and the one-writer-per-checkout rule still applies.

```bash
bun run --cwd .pi test        # tests/edit_policy.test.ts
```

That suite loads the real pinned loader, supplies the anchored editor as a throwaway stub so the result does not depend on the developer's `~/.pi`, and refuses an `edit` whose payload would otherwise have matched — so it cannot pass on a guard that blocked everything, nor on a payload that was merely invalid.

**Changing it means changing two files.** The policy exists as a project extension here and as a byte-identical global twin in `~/.pi/agent/extensions/edit-policy.ts`, which covers every other repository. Edit one, edit both; `tests/edit_policy.test.ts` fails when the two have diverged.

## The tool surface budget

Every registered tool pins its name, label, description, `promptSnippet`,
`promptGuidelines` and full JSON Schema into the system prompt on **every turn of
every session**, whether or not the session ever calls it. The cost is invisible in
normal use and only grows.

So the surface is **measured and bounded**, not estimated:

```bash
bun run --cwd .pi test        # tool_surface.test.ts prints the number
```

```
tool surface: 5 tool(s), 8429 bytes (~2107 tokens)
  herdr            2175 bytes
  dev_process      1778 bytes
  read_logs        1601 bytes
  handoff          1550 bytes
  repo_task        1325 bytes
```

`tests/tool_surface.test.ts` loads the real pinned Pi loader, sums the real
registrations, and fails above **12 000 bytes**. It also has a floor, so a bug
that registers nothing cannot pass by being small, and asserts no tool carries
`promptGuidelines` — those are always-on cost that duplicates the description.
That is why `read_logs` folded its two guidelines into its description rather than
keeping both.

**Grouping is judged by what reaches the prompt**, not by how many actions exist.
Five tools cover 13 actions; a tool per action would cost 13 schemas on every
turn for the same capability.

The number is printed on every run on purpose. A budget nobody can see the current
value of only bites when it is already too late.

## Optional capabilities

Herdr is optional. A machine without it — and a session not inside a
Herdr-managed pane — is the normal case for anyone who cloned this template.

**Nothing in `herdr.ts` runs at module load**, so Pi starts either way. The tool
registers unconditionally and reports a **named unavailable capability** when the
capability is absent, because a tool that vanishes when its dependency is missing
is indistinguishable from a broken install — the model gets no way to ask *why*.

The distinction the whole thing turns on: an **absent** capability is not a
**failed** command. Only the second is worth retrying.

| State | Reported as | Retry? |
|---|---|---|
| Not installed / not inside a pane | named unavailable capability | no |
| Installed, command refused | that command's error and exit status | maybe |
| Ran, returned something unreadable | state is unknown | after reading it |

Two rules that protect the user, and are asserted on the argv the CLI actually
received rather than on the tool's own flags:

- **`--no-focus` is the default.** An agent that creates a focused workspace
  interrupts whatever the user was typing.
- **`--force` is never defaulted on**, and `remove` requires an explicit workspace
  id read from a response. Ids are opaque handles the server allocates; a
  predicted `w1` is how an agent ends up operating on the wrong workspace.

No action touches `herdr session`. Closing or restarting a persistent session
destroys whatever state the user has in it.

`tests/optional_capabilities.test.ts` loads every extension with `PATH` emptied
and asserts zero errors and that all five tools still register.

## Skills

A skill is a directory with a `SKILL.md`. Pi advertises its name and description
and loads the instructions only when the task matches, so detailed guidance stays
out of context until it is needed.

```bash
/skill:adding-a-feature
/skill:debugging-with-logs
/skill:herdr-worktrees
/skill:reviewing-a-pr
/skill:browser-debugging
/skill:handoff
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

## One TypeBox

The extensions and the rest of the repository both import `typebox` (1.x).
Pi's `registerTool` consumes a TypeBox 1.x schema object, so the whole
repository uses one version.

`typebox/value` is used for the dispatch-time validation in
`lib/tool_namespace.ts`, so `params` are checked against each action's own schema
even though the tool registers one `{ action, params }` envelope.

## Briefs

`bun run contract` creates and lists written briefs under `docs/contracts/`. It
is not wired to any of the tools here, and it is not supposed to be: it writes a
document, and the work happens through the repository's own commands.

For work that spans sessions, the maintained answer is the `handoff` skill and the
`handoff` tool: a short written brief, plus a state check on resume. That is
deliberately the smaller thing — a note a person can read in a conversation, and a
command that says whether to believe it.

The runner that used to sit behind `contract run` has been removed rather than
left dormant. A command that cannot execute is not a runner with a missing
adapter, and `docs/contracts/README.md` documents the human workflow that replaced
it.

## Removing it

```bash
rm -rf .pi
bun run moon run pi:* 2>/dev/null
```

Two edits to finish the job:

1. Remove `"pi": ".pi"` from the `projects:` block in `.moon/workspace.yml`.
2. Remove `".pi"` from the `workspaces` array in the root `package.json`.

Nothing else in the repository depends on `.pi` — the guards enforce the
architecture, not the agent config. `AGENTS.md` mentions `.pi` once, in its layout
section; that line can go with it.
