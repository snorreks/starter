# @starter/jobs

Job state on Cloudflare D1: admission, ownership-scoped reads, attempt fencing, the
Workflow dispatch port, and bounded maintenance.

Server-only. Every module here names a database. A browser half imports
`@starter/schemas/jobs` instead, which is the portable contract with no runtime
dependency on this package.

## Purpose

One owned, bounded compute example: a signed-in verified user asks the API to
encode a named synthetic fixture with a named preset, and the database remembers
what happened. This package is the half of that which is provable today — the
state machine, its limits, and its fencing — with no provider call of any kind.

## What this package is responsible for

It owns the answers to four questions, and nothing else:

| Question | Answered by |
|---|---|
| May this user start a job right now? | `createEncodeJob` — one SQL statement |
| Which jobs may this user see? | `getJobForOwner`, `listJobsForOwner` |
| May this attempt write a result? | `claimAttempt`, `completeAttempt`, `failAttempt` |
| What does the periodic sweep delete? | `purgeExpiredSessions`, `purgeIdleRateLimits`, `purgeExpiredArtifacts` |

It does **not** own: starting a Workflow (that is `WorkflowDispatchPort`, which
PR H implements), running FFmpeg (`apps/backend/media`), storing encoded bytes
(private object storage, bound in PR H), or deciding *when* maintenance runs (PR
H's schedule). Those boundaries are deliberate: this package is the part that is
already provable, and a maintenance run can be executed from either Worker
without either importing the other.

## Admission: one statement, four rules

The interesting part of this package is that `createEncodeJob` decides with a
single statement rather than a read followed by a write.

```sql
INSERT INTO jobs (...)
SELECT ?, ?, 'encode', 'pending', …, ?, ?
WHERE (SELECT count(*) FROM jobs WHERE owner_id = ? AND created_at >= ?) < ?   -- hourly
  AND (SELECT count(*) FROM jobs WHERE created_at >= ?) < ?                    -- daily, UTC
ON CONFLICT DO NOTHING                                                         -- active + key
```

The four rules it enforces:

| Rule | Enforced by | Where |
|---|---|---|
| One idempotency key per owner | unique index `jobs_owner_idempotency_key_uq` | the `ON CONFLICT` |
| One active job per user | partial unique index `jobs_owner_active_uq` over `WHERE status IN ('pending','running')` | the `ON CONFLICT` |
| Five new jobs per user per rolling hour | correlated subquery | the `WHERE` |
| Fifty new manual jobs per environment per UTC day | correlated subquery | the `WHERE` |

Why this matters: the obvious implementation counts, then inserts, and two
requests that overlap both see `active = 0` and both insert. The limits would hold
precisely when there is no load. Here, SQLite evaluates the counts as part of the
same write, so they cannot be overtaken.

`changes === 1` means admitted. `changes === 0` means refused, and the refusal is
then *classified* by reading. That order is the point: the decision is atomic and
the reads only explain it.

`src/lib/job_concurrency.test.ts` asserts this structurally — it records every
statement the repository issues and fails if a standalone `SELECT count(*) FROM
jobs` appears before the inserting statement. That is what distinguishes this
implementation from a read-then-write one that happens to agree when nothing else
is running.

### Idempotency keys and the 409

`Idempotency-Key` is required, 1–100 printable ASCII characters, scoped to the
owner. A replay with the same body returns the same job and spends no further
budget. A replay with a *different* body is a conflict.

Worth stating plainly: today's `fixture` and `preset` are each a single frozen
value, so a **schema-valid** request cannot differ from itself, and the 409 branch
is defensive. It is still reachable — a row can have been admitted by an earlier
build of this template that accepted a second preset — and
`job_concurrency.test.ts` reaches it by writing that row directly, so the branch is
tested rather than assumed.

## Attempt fencing

An attempt holds the lease by writing its id into `jobs.active_attempt_id`. Both
terminal writes filter on that value:

```sql
UPDATE jobs SET status = 'succeeded', … 
WHERE id = ? AND active_attempt_id = ? AND status = 'running'
```

Three consequences, each with a test:

* An attempt whose lease expired and was taken over matches no rows. Its late
  success is **fenced**, not applied.
* A committed success cannot be overwritten by a late failure: `status` is no
  longer `running`, so `failAttempt` matches nothing. A demo never shows a failed
  job whose output exists.
* A terminal job cannot be reopened. `claimAttempt` requires
  `status IN ('pending','running')`.

At most `MAX_JOB_ATTEMPTS` (3) attempts, counted in the claim statement itself so
two attempts cannot both see the last one.

## Dispatch: a port, and why it is not a queue

`WorkflowDispatchPort` has one method. It is deliberately not a queue, a worker, a
retry schedule or a dead-letter table: PR H owns all of that, and a second
implementation here would be one more place for the two to disagree about when a
job is recoverable.

What the port does fix is the failure the round-2 review called out: **D1 committed
the admission and then the Workflow call failed.** The job row therefore carries
`workflow_id` (derived from the job id, so a retry addresses the same instance),
`dispatch_state`, `dispatch_attempts` and a frozen `dispatch_error`. A job in
`dispatch_failed` is admitted, visible through the API, and listed by
`listPendingDispatches` for recovery when its error code is retryable and fewer
than `MAX_DISPATCH_ATTEMPTS` (3) dispatch calls have failed.

**The live compute profile is disabled.** Until PR H lands, the wired dispatcher is
`createDisabledDispatchPort()`, which refuses every dispatch with
`compute_profile_disabled` and says the job is recoverable. It does not report
success, because a port that did would let `POST /api/jobs` answer 202 for a job
nothing will ever run — invisible until somebody looks for the video.

The recording dispatcher used by the tests lives in `dispatch_port.test.ts` and is
not exported. A recording dispatcher shipped next to the real one is a second
implementation waiting to be wired up by accident.

## Maintenance: bounded, and honest about what it did

Every service takes a **fixed cutoff** and a batch size, and reports D1's own
`meta.changes`.

* `purgeExpiredSessions` — `DELETE … WHERE id IN (SELECT id … LIMIT n)`. The
  subquery form, not `DELETE … LIMIT n`, because the latter needs a SQLite build
  compiled with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, which D1 is not.
* `purgeIdleRateLimits` — same shape over the auth limiter's millisecond windows.
* `purgeExpiredArtifacts` — queues expired artifacts, then closes out only those
  whose bytes `JobArtifactStorage.isRemoved` confirms are gone. **It does not
  delete bytes**, and `retired` is the only figure here that may claim a deletion.
  A failed byte-deletion leaves a recoverable row rather than a job whose artifact
  vanished from D1 while the object stayed in the bucket forever.

The previous `purgeExpiredSessions` read every expired id into memory, deleted with
a *second* `new Date()` cutoff, and reported the count of the first query. Three
defects in six lines: unbounded, inconsistent, and reporting rows selected rather
than rows deleted. `maintenance.test.ts` fails for that implementation.

`runMaintenance` takes one `cutoffAt` from the injected clock and derives every
window from it, so a run straddling a second boundary cannot delete with one
instant and report another. It also terminalizes exhausted attempts after their
lease expires, and failed dispatches that are non-retryable, have exhausted
retries, or have been idle for one hour (`dispatchRetentionMs` is configurable).
Live attempt leases are preserved; terminalization releases the owner's active slot.

**Not implemented here:** the schedule. PR H owns `17 * * * *` UTC, the durable
run key per scheduled slot, and the Worker that executes it.

## The clock

Every method reads time from an injected `Clock` and never from `Date.now()`.
Budget windows, lease expiry and retention cutoffs are all time-bounded claims, and
a claim proved by sleeping is a claim nobody verifies. The unit suite moves a fixed
clock instead.

Columns are `integer(…, { mode: 'timestamp' })`, which in Drizzle stores
**seconds**. `toEpochSeconds` is the single conversion point; a schema that mixes
seconds and milliseconds produces cutoffs that are wrong in one direction with
nothing to say which.

## Database surface

The repository is typed against `JobsDatabase` — a three-method slice of
`D1Database` — rather than `D1Database` directly. That is so the unit lane can run
the real statements on `bun:sqlite`. `D1Database` satisfies it structurally, so the
web Worker passes its binding unchanged, and
`apps/frontend/client/tests/worker_integration.test.ts` exercises the same
statements against a real D1 binding in real workerd. If the two engines ever
disagree, one of those two suites goes red.

## Setup and prerequisites

Nothing to configure. The package has no bindings, no secrets and no environment
variables; it takes a database handle and a clock as arguments.

Its **only** real prerequisite is the committed migration that creates the tables
it queries. A fresh checkout must have applied `0003_*` before any of this package's
statements can succeed:

```bash
bun run db:migrate          # local D1, applies every committed migration
```

Running it against no database produces `no such table: jobs`, which is the correct
and self-describing failure.

## Commands

Run from the repository root.

```bash
bun run --cwd packages/backend/jobs test        # real SQL on bun:sqlite
bun run --cwd packages/backend/jobs typecheck
bun run --cwd packages/backend/jobs lint

bun run --cwd packages/backend/database db:generate   # after a schema change
bun run db:migrate                                    # local D1, applies 0003_*
```

## Dependencies and boundaries

* Depends on `@starter/schemas/jobs` only. Not on `@starter/database`, not on
  `@starter/auth`, not on any application.
* It does **not** depend on `drizzle-orm`: the admission statements are hand-written
  SQL on purpose, because the correlated subqueries and the conflict-target-less
  `ON CONFLICT` are the design, and expressing them through a query builder would
  obscure exactly the part that has to be right.
* Reached by `apps/frontend/client/src/lib/server/jobs_service.ts` (server plane
  only) and, after PR H, by the jobs Worker.

## What is verified here, and what is not

Verified in this repository, by real statements:

- admission, idempotency and every budget, including under interleaved `Promise.all`
  admissions and structurally (one statement, no pre-count);
- owner-scoped reads, including a guessed id answering identically to a missing one;
- the full fencing matrix: takeover, stale success, stale failure over a committed
  success, terminal jobs never reopened, attempt ceiling;
- dispatch bookkeeping, and that a dispatch failure stays visible and recoverable;
- artifact retention, including that nothing is reported as retired before the bytes
  are confirmed gone;
- bounded maintenance with truthful affected-row counts.

**Not** verified here, and not claimed:

- that a Workflow is ever started — there is no compute profile in this PR;
- that any byte is ever encoded, stored or served — that is `apps/backend/media`
  plus PR H;
- that the live profile's budgets hold under real multi-isolate concurrency — the
  guarantees here are SQLite's, exercised on one engine;
- scheduling: no cron, no scheduler, no run record.

## Related

- `@starter/schemas/jobs` — the public DTOs, the frozen enums and the Rust wire contract.
- `packages/backend/database` — the Drizzle schema and the committed migrations.
- `apps/backend/media` — the Rust/FFmpeg processor this package's metadata describes.
- [docs/architecture.md](../../../docs/architecture.md) — planes and boundaries.
- [docs/testing.md](../../../docs/testing.md) — the four lanes.