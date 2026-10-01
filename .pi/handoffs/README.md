# Handoff notes

Durable notes for work that spans sessions. Every file here except this one is
gitignored.

## What lives here

One Markdown note per piece of work, written by the `handoff` tool:

```
.pi/handoffs/
  README.md
  pr-f-agent-integration.md
```

A note records the objective, the base and head commits, the branch and worktree,
the completed work with the command and exit code that proved each item, the
failures still outstanding with why, and **exactly one** next step.

## Why it is gitignored

A handoff is evidence about one moment in one worktree. Committed, it lands in the
repository's history, gets picked up by every clone, and goes stale the moment
anyone else pushes. `handoff { action: "write" }` verifies this rule is really in
`.gitignore` with `git check-ignore` and refuses to write otherwise.

## The rule that makes resuming safe

**A note is a claim, not a fact.**

`handoff { action: "read" }` compares the recorded head, branch and worktree
against the live repository and reports every claim that no longer holds. A stale
note is the expensive failure here: an agent reads "3 tests passing" from three
hours ago, the code underneath has changed since, and it reports a pass it never
observed — confidently, and with nothing downstream able to tell.

So resuming always re-derives current state first. Even when the position matches
exactly, the output says so and states that this is **not** evidence the recorded
results still hold.

An empty failure list renders as *"None observed. This is not the same as
verified."* — because nobody having recorded a failure is a different claim from
everything having passed, and only the second one is usually false.

## The workflow

See `.pi/skills/handoff/SKILL.md`. The short version: write a brief before
starting, not after; resume by inspecting repository state before trusting any
recorded result.