# {{ID}} — {{TITLE}}

<!--
  A written brief.

  A brief is a statement of intent that a change is finished when specific,
  checkable things are true. It is not a task list and not a plan: it says what
  "done" means before anyone starts, so that "done" is not renegotiated
  afterwards by whoever is tiredest.

  Nothing executes this document. A person or an agent carries it out with the
  commands its Verification section names, and the result is a pull request. See
  docs/contracts/README.md for that workflow.

  Placeholders: {{ID}}, {{TITLE}}. Both are substituted by `bun run contract new`.
-->

**Status:** draft

## Problem

<!--
  One or two sentences. What is broken or missing, in terms a user would
  recognise?

  If you cannot state the problem without naming a file, the problem is
  probably "this file is wrong" rather than something a user experiences. That
  is a real reason to do the work — it just needs saying honestly.
-->

## Acceptance criteria

<!--
  Each line is checkable by someone who did not write it, without asking you a
  question. That is the whole test.

  Bad:  "the logs are better"
  Good: "`bun run logs web --mode production --uid <id>` returns only that user's
        events, or reports `capability_unsupported` if the adapter cannot filter"

  Bad:  "add tests"
  Good: "a test asserts the request is refused when a second account asks for
        another account's row"
-->

- [ ] 
- [ ] 

## Out of scope

<!--
  The most useful section, and the one most often skipped.

  Anything a reasonable person might reasonably assume is included. Naming it
  here is how it becomes a follow-up instead of a disagreement at review.
-->

## Verification

<!--
  How you will know. Name the command, not the intention.

  Be honest about what is not covered. A brief whose verification section is
  aspirational teaches everyone reading it that verification sections are
  aspirational.
-->

```bash
# e.g.
bun run typecheck && bun run guard && bun run test
```

**Not covered by this brief:**

- <!-- e.g. mobile builds: needs the Android NDK and Xcode, neither available here -->

## Risks

<!--
  What could go wrong, and what you would do about it. "None" is a valid answer
  if it is true; an empty section that means "I did not think about it" is not.
-->

## Notes

<!--
  Anything a reviewer would otherwise ask you in a meeting. Reference commits,
  decisions already made, dead ends worth not repeating.
-->