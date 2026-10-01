# Testing

Four lanes plus a visual capture. Each answers a different question, and none of
them can answer the question the others exist for.

Every lane runs **without credentials and without a network account**. That is a
constraint, not a convenience: a check that cannot run on a fresh clone is one
nobody runs, and a repository where `bun run test` fails teaches people to skip
the suite rather than to fix it.

```bash
bun run test               # unit, every project
bun run test:browser       # real Svelte in Chromium
bun run test:worker       # build, then real workerd + real D1
bun run e2e                # built client + real Worker + real D1 + real browser
bun run test:all           # all four, in that order, no duplicates
bun run e2e:visual         # screenshots for review
```

`bun run e2e` and `bun run test:e2e` are the same command. Use whichever reads
better where you are.

## Why the lanes are separate tasks

They are separate Moon tasks — `client:test`, `client:test-browser`,
`client:test-worker`, `e2e:e2e` — and not one fan-out, for two reasons.

**They fail independently.** A Chromium that will not launch must not fail the
unit lane, or a broken system library reads as a broken product.

**`test:all` is a nonduplicating composition.** The client's `test` script used to
be `test:unit && test:browser`, so `moon run :test` already ran the browser lane
and the root `test:all` ran it a second time explicitly. The client's `test` is now
unit only, and `test:all` lists each lane exactly once.

## The E2E entrypoint is real, and here is the proof

`bun run e2e` used to reach an `echo`:

```
bun run e2e -> moon run e2e:test -> echo "e2e is not a unit lane; run: bun run e2e"
```

CI applied migrations, installed Chromium, printed that message and went green. The
17 Playwright tests were never executed. `e2e:test` was also reported `cached`,
because its `inputs` were `src/**/*` and `apps/e2e` has no `src/` directory — a
file group that matches nothing hashes to a key that never changes.

Both are fixed, and the fix is verified rather than asserted. The transcript below is
from the round that fixed them; **this round's counts are in
[capability-matrix.md](capability-matrix.md)**, because a number in a document is
worthless without the run that produced it.

```bash
# 1. The suite runs, and reports its own count.
$ bun run e2e
  … passed …

# 2. It runs again immediately, and nothing leaks. This was the other half of the
#    problem: the launcher spawned workerd detached, so each run left a server
#    holding its port and the *next* run refused with "already used".
$ bun run e2e && bun run e2e
  … passed …
  … passed …

# 3. A failing browser assertion fails the public command.
#    (add a bogus expectation to apps/e2e/tests/auth.spec.ts, run, restore)
$ bun run e2e
  1 failed
    [chromium] > tests/auth.spec.ts > a wrong password is refused
  exit 1
```

Step 3 is the one that matters. A green E2E job that ran nothing is worse than no
E2E job at all.

## The E2E and Worker lanes need `node` on PATH

`wrangler dev` is a Node program that spawns `workerd`. On a NixOS host with only
Bun installed, `wrangler dev` exits with `env: 'node': No such file or directory`
and the readiness probe times out after four minutes — a failure that reads like a
hang rather than like a missing prerequisite.

CI's runner image has Node. If you are on Nix, provide one (`nix-shell -p nodejs`)
or the Worker will never start. Chromium's shared libraries are a second such
prerequisite: see `docs/capability-matrix.md`.

## What each lane is for

| Lane | Command | Question it answers |
|---|---|---|
| Unit | `bun run test` | Is this function correct? |
| Browser | `bun run test:browser` | Does this reactivity actually reach the DOM? |
| Worker | `bun run test:worker` | Does the built Worker route, authenticate and authorize correctly in workerd? |
| E2E | `bun run e2e` | Does the whole path work, through a build and a browser? |

Counts are derived by running the lanes, not recorded here except in
[capability-matrix.md](capability-matrix.md), which records what a given round
actually ran:

```bash
bun run test:all          # each lane prints its own count
```

### Unit

Across `packages/shared/*`, `scripts`, the client's Bun lane (which now includes the
deployment-mode resolution tests that used to live in the API app), and the Pi
extensions plus their loader smoke test.

Pure logic, schema refusals, redaction, flag parsing, deploy and migration plans,
process-tree teardown, and the contract state machine.

The shared packages are where this matters most: everything else imports them, so
a bug there surfaces as a confusing failure somewhere unrelated.

### Browser — `src/browser_tests`, Chromium via Vitest

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

### Worker — `apps/frontend/client/tests/worker_integration.test.ts`

Against a real `wrangler dev` with real local D1, on an OS-assigned port.

The only lane that exercises the Worker as a Worker. A unit test of a handler that
needs bindings and D1 tests the mock, not the handler.

Covers routing, auth, cross-user authorization denial, oversized telemetry
refusal, and health.

Two hazards, both handled:

- **A stale `workerd` on the port answers `/api/health` just as readily as a
  correct one.** The suite generates a run id, passes it to the Worker as a var,
  and requires `/api/health` to echo it.
- **Signalling `wrangler` does not stop `workerd`.** Wrangler is a Node shim whose
  `workerd` child is what holds the port, so teardown walks the process tree from
  the recorded pid (`killTree` in `@starter/utils/process`).

Every run also passes `DEPLOYMENT_ENV`. The Worker fails closed without it, so a
harness that omitted it would wait four minutes for a server refusing every request
with a 503 that names the binding. `BETTER_AUTH_URL` is deliberately *not* passed:
in a local environment the Worker derives it from the request's own origin, and
deriving it in the harness would re-test the configured path rather than the
derived one that a developer actually runs.

### E2E — `apps/e2e/tests`, Playwright against the **built** client and the **built** Worker

Not `vite dev`. A dev-only success would certify something the deploy does not do,
and a build-only failure is invisible to every other lane.

One `webServer` entry runs `bun run build && bun run --cwd ../.. dev:worker`, so the
browser talks to the compiled `_worker.js` in workerd on one origin — the same
artifact the deploy ships. There is no API on a second port and no proxy, which is
what makes the deep-link, cookie and 404 cases meaningful here rather than only in
production.

Three files:

- `notes.spec.ts` — the whole path: sign up, create, edit, delete, and each
  confirmed after a reload so the assertion is about persistence rather than
  optimistic rendering.
- `auth.spec.ts` — the authorization boundary, with **two separate browser
  contexts** so sessions cannot share cookies. One account cannot read, edit or
  delete another's note; each case also asserts the row still exists afterwards,
  so a `403` from a handler that deleted it anyway would fail. The same file also
  covers the public landing page, a deep link after sign-in, and the difference
  between a JSON 404 under `/api/*` and an HTML 404 for a page — the distinction
  `hooks.server.ts` exists to make.
- `preflight.ts` — the identity check below, which runs before any browser starts.

Preflight runs first and **aborts** if the app on the port is not this run's Worker:

```
The app on port 5173 is a leftover process from an earlier run.
  It reports run id "e2e_..." , not this run's.
```

One detail the direct-API calls need: Playwright's `APIRequestContext` does not send
an `Origin` header, and SvelteKit's CSRF check requires one for a content-type-less
or form mutating request. Every direct `POST`/`PATCH`/`DELETE` in these specs carries
it explicitly. That is a property of the client, not a workaround: a browser always
sends it, and the E2E suite is asserting the same thing a browser would do.

### Visual — reports as SKIPPED

`bun run e2e:visual` captures four real screens to a local directory and stops.

Image inspection is **not wired up in this round**, and the output says so:

```
SKIPPED: visual inspection did not run - image inspection is not wired up in this
         round; the screenshots are on disk for a human to review.
```

A check that prints green because the step was unavailable is worse than one that
says it did not run. Nothing is uploaded anywhere, ever — screenshots can contain
unreleased UI, and that is not a default the tool gets to choose.

## Not run here

Stated plainly rather than left to discover. See `docs/capability-matrix.md`.

- **Live Cloudflare.** No deployment, provisioning, remote migration or log query
  was executed against a real account.
- **The browser lane.** See `docs/capability-matrix.md` for whether the Chromium
  on this host can launch; a lane that cannot start must be reported, not skipped
  quietly.
- **Live Cloudflare.** A deployment or a provisioned resource id was never used.

## Rate limits and the clock

**The auth rate limit is raised for tests, not disabled.** A full E2E run makes
about a dozen sign-ups, which exceeds any production-sane per-minute budget.
Disabling it would prove nothing about the path a real user takes, and a
rate-limit bypass is exactly the kind of thing that should not be normal in a test
environment.

```ts
export const AUTH_RATE_LIMIT_MAX = '500';
```

**No test depends on wall-clock time.** `Timer` is tested by asserting that `end()`
freezes the value and that `reset()` restarts it, not by sleeping. Where a budget
must be *proved* — the contract runner's per-stage deadline — it is injected rather
than waited out, so the test asserts the mechanism instead of sleeping for ten
minutes.

## Writing a test that is not vacuous

A guard that has only ever run clean is unverified. A test that has never failed is
a test that checks nothing.

Three techniques used in this repository:

**Make the failure reachable.** `scripts/tests/guards.test.ts` writes
throwaway trees under a temp directory rather than asserting against the
repository. The Pi loader smoke test does the same: it writes a deliberately
misplaced module into a *temporary* extensions directory and asserts the loader
reports it, so "no errors" cannot pass merely because nothing was loaded.

**Break it and watch.** Bugs here were found by restoring the old behaviour and
confirming exactly which tests failed:

```bash
# Restoring the old locality heuristic in container.ts
$ bun run --cwd apps/frontend/client test:unit
(fail) resolveDeploymentEnvironment > a deployed-looking env with no
       DEPLOYMENT_ENV is refused, not treated as local
```

**Reproduce the recorded bug beside the fix.** `contract/reproduction.test.ts`
states the old inference — "an attempt count means done" — as a local function, and
asserts what it would have done, right next to an assertion about what the current
code does. The regression is demonstrated, not remembered.

If a change should break a test and does not, the test is not testing that thing.

## Coverage

There is no coverage number, deliberately. Coverage measures which lines ran, and
the interesting failures here are about *what was asserted* — whether a schema
refuses an unknown field, whether an aborted request reports as a failure. A
coverage percentage would be a number to improve rather than a thing to read.

What is measured instead: guards with no baselines, and assertions written so that
each one names a specific failure someone could observe.