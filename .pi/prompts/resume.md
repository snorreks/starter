---
description: Resume owned development or QA work safely
argument-hint: "[handle or run id]"
---
Inspect ${1:-the requested handle} through the owning runtime/job authority.
Revalidate the process ownership token, current run identity, readiness and
artifact hashes before using a browser or reporting prior results. Invalidate
stale page handles and reacquire an isolated context. Preserve completed
artifacts, report expired or unavailable owners as such, and never attach to or
stop an unrelated process by guessing from a port or PID.
