# Background task journal

Machine-local runtime state for long-running processes started by the `dev_process`
tool. Every entry in this directory except this file is gitignored.

One pair of files per job:

| File | Contents |
|---|---|
| `<id>.json` | command, argv, cwd, pid, timestamps, exit code, state |
| `<id>.log` | the job's complete combined output, appended as it arrives |

## Why it is on disk

Pi's `bash` tool returns when the command returns. A dev server does not, so it
has to be backgrounded — and then its completion can only be *inferred* from log
output, which fails in the worst direction: a linking phase that has printed
nothing for thirty seconds is indistinguishable from a finished build.

The journal exists so completion is never inferred. A job is finished when its
process exits, and that fact is recorded in `<id>.json` where the next session
can read it. `dev_process { action: "status" }` reports it.

It also outlives the process that started it. A session that dies mid-build
leaves a journal entry saying the job is still `running`, which is true and
actionable — rather than a process nobody knows about.

## Deleting entries

Safe to delete. Nothing reads this directory at startup; the files are a record,
not a cache. A stale entry for a job that no longer exists reports
`command: (unreadable)` or a pid that fails its ownership check, and both refuse
to be signalled.

Do **not** `pkill -f` to clean up. The pattern broad enough to match a dev server
also matches the shell that launched it. `dev_process { action: "stop" }` signals
the recorded process group after verifying it still belongs to this checkout.