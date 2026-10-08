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

It does **not** own: running FFmpeg (`apps/backend/media`), holding bytes (private
object storage, bound in `apps/backend/jobs`), or deciding *when* maintenance runs
(that schedule lives in the jobs Worker's `wrangler.jsonc`). Those boundaries are
deliberate: a maintenance run can be executed from either Worker without either
importing the other.

It now owns two things PR F left as seams:

| Seam | Implementation | Verified by |
|---|---|---|
| `WorkflowDispatchPort` | `createWorkflowDispatchPort(binding)` — binds a real Workflow binding, derives nothing it can avoid, and classifies `instance.already_exists` as **success** so a retried dispatch is not an outage | `dispatch_port.test.ts`, and the compute lane |
| "when maintenance runs" | `createMaintenanceRunRepository` — one row per run, keyed by its trigger, claimed with `INSERT … ON CONFLICT DO NOTHING` | `maintenance_run.test.ts`, and the compute lane |

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
retry schedule or a dead-letter table. The jobs Worker owns encode retries and
maintenance recovery; the port only starts or checks a Workflow instance.

What the port does fix is the failure the round-2 review called out: **D1 committed
the admission and then the Workflow call failed.** The job row therefore carries
`workflow_id` (derived from the job id, so a retry addresses the same instance),
`dispatch_state`, `dispatch_attempts` and a frozen `dispatch_error`. A job in
`dispatch_failed` is admitted, visible through the API, and listed by
`listPendingDispatches` for recovery when its error code is retryable and fewer
than `MAX_DISPATCH_ATTEMPTS` (3) dispatch calls have failed.

`JOBS_PROFILE=encode` selects `createWorkflowDispatchPort()` through the web
Worker's encode binding. The default disabled profile selects
`createDisabledDispatchPort()`, which refuses with `compute_profile_disabled`.
The jobs Worker's maintenance workflow recovers pending dispatches when encoding
is enabled.

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

The jobs Worker declares `17 * * * *` UTC for staging and production in
`apps/backend/jobs/wrangler.jsonc`. This package implements the durable run key
and run repository; `MaintenanceWorkflow` performs the sweep and recovery.

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
bun run db:migrate                                    # local D1, applies every committed migration
```

## Dependencies and boundaries

* Depends on `@starter/schemas/jobs` only. Not on `@starter/database`, not on
  `@starter/auth`, not on any application.
* It does **not** depend on `drizzle-orm`: the admission statements are hand-written
  SQL on purpose, because the correlated subqueries and the conflict-target-less
  `ON CONFLICT` are the design, and expressing them through a query builder would
  obscure exactly the part that has to be right.
* The web server uses `apps/frontend/client/src/lib/server/supabase_context.ts`
  and the Supabase jobs repository. The retained D1 repository is reached by
  `apps/backend/jobs` pending the compute cutover, not by the web request path.
* `workflowIdFor` lives in its own module (`job_identity.ts`) because both the
  repository and the dispatch port need it, and a value import between those two
  would be a cycle.

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

### Verified only against the local runtime

- Existing-instance dispatch is tested against the local runtime's
  `instance.already_exists` response and a status lookup. Hosted-provider
  idempotency has not been verified.
- The manual maintenance path runs in the compute lane and trigger selection is
  unit-tested. The local runtime cannot deliver a natural cron event, so natural
  cron delivery has not been verified.

**Not** verified anywhere in this repository, and not claimed:

- that the live profile's budgets hold under real multi-isolate concurrency — the
  guarantees here are SQLite's, exercised on one engine;
- that Cloudflare's managed container runtime starts and stops an instance;
- any deployed behaviour at all: nothing here deploys.

## Related

- `@starter/schemas/jobs` — the public DTOs, the frozen enums and the Rust wire contract.
- `packages/backend/database` — the Drizzle schema and the committed migrations.
- `apps/backend/media` — the Rust/FFmpeg processor this package's metadata describes.
- `apps/backend/jobs` — the Worker that runs the Workflows and the schedule.
- [docs/architecture.md](../../../docs/architecture.md) — planes and boundaries.
- [docs/testing.md](../../../docs/testing.md) — the four lanes.