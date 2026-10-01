---
name: herdr-worktrees
description: Use when a piece of work needs its own checkout, branch and terminal workspace — parallel agents, a review that must not disturb the session in progress, or work that may need to be abandoned without touching anything else. Covers isolated worktree setup, per-worktree install, ports, state and task handoff. Herdr is optional; every step here has a plain-git equivalent.
---

# Isolated worktrees

Give a piece of work its own checkout, branch and workspace, so it cannot
disturb the session already in progress.

**Herdr is optional.** This repository's tooling never requires it. If
`herdr { action: "status" }` reports the capability unavailable, follow
[Without Herdr](#without-herdr) instead — same isolation, plain git.

## The rules that protect the user

| Rule | Why |
|---|---|
| Never close, stop, detach or reload a session that is not yours. | It is somebody's terminal. A workspace you did not create is a workspace you do not own. |
| Pass `--no-focus` (the default in the tool). | Creating a focused workspace steals the keyboard mid-sentence. |
| Read ids from a response; never invent one. | Workspace ids are opaque handles. `w1` in a doc is not `w1` on this server. |
| Never `--force` on remove unless asked. | It deletes a checkout. |
| Record the base ref and the worktree path. | A handoff without them cannot be resumed — see the `handoff` skill. |

## 1. Check the capability

```
herdr { action: "status" }
```

Reports available/unavailable and this session's own workspace, tab and pane
ids. Those three are **read-only context** — useful in a handoff note, never a
target.

If it is unavailable, the reason says which of the two it is:

- **not running inside a Herdr-managed pane** — you are outside Herdr. Use
  [Without Herdr](#without-herdr). Do not try to inspect or control the focused
  session from outside; Herdr deliberately does not support that.
- **`herdr` is not on PATH** — install it or work without it.

An absent capability is not a failure. Do not retry it, and do not treat the
repository as broken.

## 2. Learn the real CLI

The installed binary is the authority. Flags get renamed between releases, and a
guessed flag is an error the model has to interpret:

```
herdr { action: "help", params: { group: "worktree create" } }
```

Always `worktree create`-shaped help, never `herdr workspace create` with
arguments omitted — bare mutating commands run with defaults.

## 3. See what already exists

```
herdr { action: "worktree_list", params: { cwd: "<repo root>" } }
```

Read the real paths and workspace ids from the response. A worktree that is
already open is not a worktree to recreate.

## 4. Create one

```
herdr {
  action: "worktree_create",
  params: {
    cwd: "<repo root>",
    branch: "pr-<letter>-<slug>",
    base: "main",
    label: "starter PR-F agent integration"
  }
}
```

Take `checkout` and `workspace id` **from the response**. They are the only
correct values.

## 5. Install — a fresh worktree has no dependencies

```bash
cd <checkout path>
bun install
```

This is not optional and not skippable. A worktree shares the repository's
`.git` but not its `node_modules`, so every task fails with a module-not-found
error that reads like a broken checkout.

## 6. Per-worktree ports and state

Worktrees are independent, and the defaults are **not** derived per worktree, so
override them explicitly when two worktrees will run at once:

| Variable | Default | Set it when |
|---|---|---|
| `PORT` | 5173 | a second client dev server is needed |
| `API_PORT` | 8787 | a second Worker is needed |
| `E2E_CLIENT_PORT` | 4183 | a second e2e run is needed |
| `E2E_API_PORT` | 8788 | a second e2e run is needed |

Bad values are not corrected for you: `apps/frontend/client/dev_ports.ts` throws
on a non-numeric or out-of-range port rather than substituting one nobody asked
for. An unset or empty value means "use the default"; `PORT=` is an absence, not
a request for port 0.

State is already per-checkout — `.wrangler/`, `.svelte-kit/`, the local D1 and
`/tmp/starter-evidence`. Two worktrees do not share a database. What they *do*
share is anything outside the checkout, so give each worktree its own
`STARTER_LOG_DIR` when you need to tell their logs apart.

## 7. Run work in it, and hand it off

```
dev_process { action: "context" }
```

Reports the cwd and this session's ids. Record them, plus the base ref, head,
branch and checkout path, in a handoff note before you stop — see the `handoff`
skill. A note without a checkout path cannot be resumed.

## 8. Clean up

```
herdr { action: "worktree_remove", params: { workspace: "<id from a response>" } }
```

Only ever with an id you read. If the branch still holds work that was not
merged or pushed, say so and stop — this deletes the checkout, not the branch.

## Without Herdr

```bash
git worktree add ../starter-<slug> -b pr-<letter>-<slug> main
cd ../starter-<slug> && bun install
```

Then run everything through `dev_process` and `repo_task` as usual. The
difference is only the terminal layout: without Herdr, start a long-running
process with `dev_process { action: "start" }` rather than opening a pane.

```bash
git worktree remove ../starter-<slug>   # only once the work is merged or pushed
```

## What this skill will not do

It does not manage the **session** you are running in. Herdr's `session` group
controls persistent sessions, and closing or restarting one destroys whatever
state the user has in it. If the task seems to need that, ask rather than act.