---
description: Verify a UI change in its owned browser/runtime
argument-hint: "[scenario or change]"
---
Discover project capabilities with `agent describe --json` and check the required
profile before starting anything. Start the least powerful supported runtime,
verify its run identity and readiness, then use the project's browser capability
to exercise ${1:-the changed UI} through accessible controls. Inspect matching
browser and runtime logs, capture the current state, and request visual review
only when configured. Run the focused project checks. Report each command's
actual status, run ID, artifact paths and hashes, limitations, and cleanup
handle. Never call screenshots a pass by themselves.
