---
name: handoff
description: Use when a piece of work is too big for one session, when picking up work another session left, or when you must stop mid-task and leave something usable behind. Covers the written brief, what goes in a handoff note, where notes live, and why resuming means re-deriving state rather than trusting what the note says.
---

# Handoff

A handoff is a short written brief plus a state check. It is not a pipeline.

The repository has a dormant autonomous contract runner under `docs/contracts/`.
This skill is the maintained answer, and it is deliberately the smaller thing: a
note a person can read in a conversation, and a command that tells you whether to
believe it.

## Starting: write the brief first

Before the work, not after. A brief written at the end records what you remember,
which is exactly what is wrong with an end-of-task summary.

```
Objective    one sentence. What is true when this is done.
Base         the commit you started from, with `git rev-parse HEAD`
Branch       what you will call it
Worktree     the checkout path, if it is not the repository root
Done         the specific things that will exist at the end
Not doing    what you are deliberately leaving out
Verify       the commands whose success means done
```

`bun run contract new` produces a longer document with a written design and a
written critique. Use that when a decision genuinely has more than one reasonable
answer. For a change with one obvious implementation, it is paperwork somebody
rubber-stamps.

## The note

```bash
ls .pi/handoffs/
```

Notes are gitignored. That is the point: a handoff is evidence about one moment
in one worktree. Committed, it lands in history, appears in every clone, and goes
stale the moment anyone else pushes.

A note carries:

| Field | Why |
|---|---|
| `objective` | one sentence; an empty one is refused |
| `base`, `head` | so a reader can tell whether the branch moved |
| `branch`, `worktree` | so a reader can find the work, or learn it is gone |
| `completed` | each with the command run and its exit code |
| `failures` | observed and **still outstanding**, each with why |
| `nextStep` | exactly one action — a list of options is not a handoff |

An empty failure list renders as *"None observed. This is not the same as
verified."* — because nobody having recorded a failure is a different claim from
everything having passed, and only the second one is usually false.

## Resuming: old evidence is a claim, not a fact

🔴 **This is the part that matters.** A note says "3 tests passing". Three hours
and six commits later, the code underneath has changed. Reading that line and
reporting a pass you never observed is the single most expensive mistake
available here — it is confidently wrong, and nobody downstream can tell.

So resuming is a fixed sequence:

```bash
git rev-parse HEAD            # compare against the note's `head`
git rev-parse --abbrev-ref HEAD
git status --short            # uncommitted work the note never saw
ls .pi/handoffs/              # which notes exist
```

Then, before believing anything in a note:

1. **Compare the position.** If the head moved, every result the note records was
   observed on different code. Re-run it before repeating it.
2. **If the branch differs**, the checkout may not contain this work at all.
3. **If the worktree is gone**, nothing in it can be resumed — re-create the
   branch from the recorded `base` instead.
4. **Re-derive state anyway**, even when everything matches. A matching position
   means the head agrees; it says nothing about whether the described work is
   still correct.

A matching position is not a clean bill of health. Say what you re-checked.

## Mid-session: long work

`dev_process` is for processes, not notes. Start a dev server with it, and use
its handle; do not infer completion from log silence.

## Before you stop

Whichever you do:

```bash
repo_task { action: "list", params: { query: "test" } }   # real task ids
repo_task { action: "run",   params: { task: "pi:test" } } # a real result
```

Then write the note with what actually happened:

- **A command you ran** and its exit code. Not "should pass".
- **A failure you could not fix**, with why. A blocker that is not written down
  is a blocker the next session rediscovers.
- **The next step**, singular.

## What this skill will not do

It will not run itself later. Nothing here schedules, polls, or resumes on its
own, and nothing here merges or deploys — writing a brief does not authorise
publishing its result.