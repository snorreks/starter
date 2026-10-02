# Written briefs

A brief is a short document that says what "done" means before the work starts.
It is the piece of this feature that kept its value after the runner was removed.

```bash
bun run contract new "Replace notes with <entity>"   # writes C-004-….md from TEMPLATE.md
bun run contract status                              # list briefs and their status
```

## The workflow it fits into

1. Write the brief. Fill in the acceptance criteria and name the verification
   commands — `bun run typecheck`, `bun run guard`, `bun run test`, `bun run e2e`
   are the ones that mean something in this repository.
2. Do the work in a branch, in an isolated worktree if the change is large.
3. Run the verification commands the brief names. Paste their real output into
   the pull request, including what you did not run and why.
4. Open the pull request. Mark each acceptance criterion as met or say which one
   is not.
5. Change `**Status:**` in the brief as the work lands. That line is the only
   state this feature keeps.

## What is deliberately not here

There is no executor. This repository does not run a brief: no stage machine, no
resume protocol, no autonomous agent loop, no "accepted" state that anything
verifies on its own.

That is not a missing feature — it is a decision. A command that reports success
without doing the work is worse than no command, and the runner this replaced had
exactly that shape: `contract run` without `--dry-run` refused with exit 3, and
`--dry-run` ran an adapter that performed no work and printed the stages it would
have run. Shipping that as "an execution engine pending its adapter" would have
been a claim the code could not keep. See
[docs/first-round-review.md](../first-round-review.md) for the recorded defects.

If an autonomous executor is ever wanted, it needs a real adapter that performs
work, its own tests, and its own PR. Add it then; do not re-advertise the
surface before it exists.