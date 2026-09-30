---
description: Verify the repository passes every check
---
Run these in order and report the first failure with the output that explains it:

```bash
bun run typecheck
bun run guard
bun run test
```

Then, if the project has the E2E app configured:

```bash
bun run e2e
```

The guards have no baselines and no waivers, so any failure is a real violation —
do not suggest accepting it.

For a test failure, report the assertion and what the value actually was. For a
type error, report the file and the specific mismatch. If everything passes, say
so plainly and list what was run; do not add caveats that were not observed.
