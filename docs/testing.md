# Testing

Six lanes. Each answers a different question, and none of them can answer the
question the others exist for.

Every lane runs **without credentials and without a network account**. That is a
constraint, not a convenience: a check that cannot run on a fresh clone is one
nobody runs, and a repository where `bun run test` fails teaches people to skip
the suite rather than to fix it.

```bash
bun run test               # unit, every project
bun run test:browser       # real Svelte in Chromium
bun run test:integration   # real Worker + real D1
bun run e2e                # built client + real Worker + real D1
bun run test:all           # all four
bun run e2e:visual         # screenshots for review
```

## What each lane is for

| Lane | Count | Question it answers |
|---|---|---|
| Unit | 333 | Is this function correct? |
| Browser | 15 | Does this reactivity actually reach the DOM? |
| Integration | 12 | Does the Worker route, authenticate and authorize correctly? |
| E2E | 17 | Does the whole path work, through a build? |

### Unit — 333 tests

Across `packages/shared/*` (171), `scripts` (130), the client's Bun lane (15) and
the agent extension (17).

Pure logic, schema refusals, redaction, flag parsing, deploy and migration plans,
error classification. No DOM, no database, no clock dependency.

The shared packages are where this matters most: everything else imports them, so
a bug there surfaces as a confusing failure somewhere unrelated. Writing them
found four — `redactValue` throwing on a hostile Proxy, the log registry failing
its own schema, `slugify` producing a trailing hyphen, and `createObserver`
silently deduping two registrations.

### Browser — 15 tests

`apps/frontend/client/src/browser_tests`, Chromium via Vitest.

This lane exists because the unit lane **cannot** test reactivity. Bun has no Svelte
compiler, so `$state` and `$derived` are stubbed with identity functions there. A
test that only exercises stubbed runes proves nothing about them.

What this lane covers that nothing else does:

- a `$state` write that does not reach the DOM
- a `$derived` that does not recompute when its dependency changes
- `BaseViewModelContainer` disposing exactly once per mount
- a slow earlier response overwriting a newer one
- accessible names on icon-less buttons

Two things to know when adding tests here:

- **`mount()` needs an explicit `target` in a browser.** Use `mountInDocument`
  from `mount_helper.ts`. Without it the error is `Cannot read properties of
  undefined (reading 'appendChild')`, which says nothing about the component.
- **Effects need a macrotask.** `flushSync()` alone is not always enough after
  mount; `await tick()` is the reliable form.

### Integration — 12 tests

`apps/backend/api/tests/worker_integration.test.ts`, against a real
`wrangler dev` with real local D1.

The only lane that exercises the Worker as a Worker. A unit test of a handler that
needs bindings and D1 tests the mock, not the handler.

Covers routing, auth, cross-user authorization denial, oversized telemetry
refusal, and health.

One hazard, handled: a **stale `workerd` on the port answers `/api/health` just as
readily as a correct one.** The suite generates a run id, passes it to the Worker
as a var, and requires `/api/health` to echo it. A stale process fails the check
rather than silently running the suite against the wrong database.

```bash
ss -lptn 'sport = :8788'     # find it
kill <pid>                    # NOT pkill -f: that pattern matches this shell too
```

### E2E — 17 tests

`apps/e2e/tests`, Playwright against the **built** client — not `vite dev`. A
dev-only success would certify something the deploy does not do, and a build-only
failure is invisible to every other lane.

Two files:

- `notes.spec.ts` — the whole path: sign up, create, edit, delete, and each
  confirmed after a reload so the assertion is about persistence rather than
  optimistic rendering.
- `auth.spec.ts` — the authorization boundary, with **two separate browser
  contexts** so sessions cannot share cookies. One account cannot read, edit or
  delete another's note; each case also asserts the row still exists afterwards,
  so a `403` from a handler that deleted it anyway would fail.

It also caught three setup bugs nothing else could see, each of which presented as
a product bug: `vite preview` had no proxy, so `/api` 404'd and the sign-in form
said "The request failed" against a healthy Worker; the client's preview proxy
pointed at the wrong port because `webServer.env` *replaces* rather than merges;
and the E2E origin was not on the API's allowlist, so Better Auth returned 403.

Preflight runs first and **aborts** if the API is not this run's Worker:

```
The API on port 8788 is a leftover process from an earlier run.
  It reports run id "e2e_…" , not this run's.
```

### Visual — reports as SKIPPED

`bun run e2e:visual` captures four real screens to a local directory and stops.

Image inspection is **not wired up in this round**, and the output says so:

```
SKIPPED: visual inspection did not run — image inspection is not wired up in this
         round; the screenshots are on disk for a human to review.
```

A check that prints green because the step was unavailable is worse than one that
says it did not run. Nothing is uploaded anywhere, ever — screenshots can contain
unreleased UI, and that is not a default the tool gets to choose.

## Rate limits and the clock

**The auth rate limit is raised for tests, not disabled.** A full E2E run makes
about a dozen sign-ups, which exceeds any production-sane per-minute budget.
Disabling it would prove nothing about the path a real user takes, and a
rate-limit bypass is exactly the kind of thing that should not be normal in a test
environment.

```ts
export const AUTH_RATE_LIMIT_MAX = '500';
```

**No test depends on wall-clock time.** `Timer` is tested by asserting that
`end()` freezes the value and that `reset()` restarts it, not by sleeping.

## Writing a test that is not vacuous

A guard that has only ever run clean is unverified. A test that has never failed is
a test that checks nothing.

Two techniques used in this repository:

**Make the failure reachable.** `scripts/src/lib/guards/guards.test.ts` writes
throwaway trees under a temp directory rather than asserting against the
repository — otherwise proving a guard fails would require breaking the repository
to prove it.

**Break it and watch.** Several bugs here were found by deleting the behaviour and
confirming exactly one test failed:

```bash
# Removing --assets-only from the client deploy step
$ bun test src/lib/deploy
(fail) planDeploy: steps > the client step deploys assets only
```

If a change should break a test and does not, the test is not testing that thing.

## Coverage

There is no coverage number, deliberately. Coverage measures which lines ran, and
the interesting failures here are about *what was asserted* — whether a schema
refuses an unknown field, whether an aborted request reports as a failure. A
coverage percentage would be a number to improve rather than a thing to read.

What is measured instead: five guards with no baselines, and assertions written so
that each one names a specific failure someone could observe.