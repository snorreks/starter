---
name: browser-debugging
description: Diagnose browser behavior with deterministic checks, an owned visual run, scoped logs, and optional explicit visual review.
---

# Browser debugging

Use the project's browser and visual authorities so captures, logs, and review
results have one run identity. A screenshot or a running server does not prove a
check passed.

## Discover and reproduce

Start with the deterministic lane that matches the change:

```bash
bun run test:browser
bun run e2e
```

Use `bun run agent -- describe --json` to see which project capabilities are
implemented. A capability marked `not-run` or `not-applicable` is not a pass.
Do not hand-connect to a familiar port and assume it belongs to this worktree.

## Capture the current UI state

Run an owned matrix capture through the project facade:

```bash
bun run agent -- visual capture --json
```

The result includes a unique run ID, the manifest and screenshot hashes, and an
exact review command. Captures live under
`.wrangler/runs/<run-id>/artifacts/visual/`. Capture does not contact a vision
provider. To inspect an image, use its artifact path; do not modify the original.

## Review explicitly

When configured review is wanted, run the exact command returned by capture:

```bash
bun run agent -- visual review --run <run-id> --json
```

This operation may send screenshots to the configured provider. It reports
`passed`, `failed`, `needs-human-review`, `not-run`, or `error` with the run and
report provenance. A valid low grade is evidence and must not be retried until it
changes. Provider or schema errors are not grades. A gate is explicit:

```bash
bun run agent -- visual review --run <run-id> --json --gate
```

The `E2E_VISION_MODEL` and provider key come from the local E2E environment. Do
not add credentials to `.pi/workflow.json`, screenshots, or reports.

## Correlate browser and Worker evidence

Read local logs with the same run ID so another run's events cannot be mistaken
for this one:

```bash
bun run logs web --mode local --run <run-id> --source browser
bun run logs web --mode local --run <run-id> --source worker
```

In Pi, `repo_task` exposes `visual_capture` and `visual_review`; `read_logs` accepts
`runId` and source filters. The portable `browser` namespace is deferred and its
standalone URLs are classified as exploratory unless a project runtime identity
is explicitly provided. Never upgrade an exploratory screenshot to verified
project evidence.

## Preserve evidence

- Keep original screenshots and manifests intact; derived review images are
  separate artifacts.
- Report failed deterministic checks even when screenshots look correct.
- Report unavailable provider/runtime prerequisites as `not-run` with the exact
  rerun command. Do not convert them to a green skip.
- Stop only processes whose ownership handle belongs to this run. Never kill by
  a broad process-name pattern.
