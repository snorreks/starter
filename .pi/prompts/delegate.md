---
description: Delegate a bounded, read-only QA investigation
argument-hint: "[question]"
---
Discover whether the installed workflow package exposes a reviewed QA role and
the exact browser/runtime capabilities it can receive. Delegate ${1:-the
requested QA check} only with an explicit profile, run identity, allowed tools,
deadline, and result schema. The child may inspect and exercise a synthetic
fixture; it may not publish, deploy, write project source, or recursively
delegate. If no reviewed QA role is available, perform the check locally. Return
the child handle, cancellation status, observed evidence, and limitations.
