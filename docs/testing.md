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
bun run workflows          # CI workflow policy: pins, permissions, bounds, secrets
bun run smoke              # fresh checkout of this template, no credentials
bun run e2e:visual         # screenshots for review
```

`bun run e2e` and `bun run test:e2e` are the same command. Use whichever reads
better where you are.

Every script that fans out to Moon goes through `scripts/src/cli.ts cached --`,
which decides Moon's cache mode from a fingerprint over the files Moon cannot put
in a key. See [toolchain.md](toolchain.md) for why that indirection exists and
what it measures.

## The browser lane's executable selection, and how it was broken

This lane could not start on NixOS, and the reported cause was wrong.

```
Error: browserType.launch: Executable doesn't exist at
  /nix/store/…-chromium-154.0.8037.57/bin/chromium_headless_shell-1243/
    chrome-headless-shell-linux64/chrome-headless-shell
```

The previous note blamed a missing `chromium_headless_shell` store path and
suggested installing another Chromium or switching `channel`. Neither can help,
and the config said so without having run it.

The real cause: `vitest.config.ts` selected its executable with an **instance**
property.

```ts
// What it was. `BrowserInstanceOption` has no `launch` member.
instances: [{ browser: 'chromium', launch: { executablePath } }]

// What it is. `resolveLaunchOptions` in the provider spreads only this.
provider: playwright(vitestProviderOptions())
```

`BrowserInstanceOption` in Vitest 5 is
`Omit<ProjectConfig, UnsupportedProperties>` plus `browser`, `name`, `provider`
and six picked option names. `launch` is not among them, so the selected
executable never reached `playwright.launch()`, nothing reported it as dropped,
and Playwright fell back to its own resolution — which builds a headless-shell
path from `PLAYWRIGHT_BROWSERS_PATH`, a *directory*. The Nix dev shell pointed
that at the store's `bin`, so the path it computed named a file the store does not
contain.

### Proving it, rather than asserting it

`scripts/tests/browser_launch.test.ts` puts an **instrumented executable** where
the resolver's answer goes, launches a real Vitest browser project through the
real provider, and asserts the marker file names the executable that ran:

| Test | Asserts |
|---|---|
| the selected executable is the process Playwright started | the harness passes *and* the marker names the selected path |
| a selected executable that refuses fails the launch | the marker names the refusing path *and* the run fails |
| `PLAYWRIGHT_BROWSERS_PATH` alone does not choose the executable | the marker is empty |

The second test is the negative control for the first: if the selection were
dropped, Playwright would resolve a browser of its own and that run would pass.

### Two variables, not one

`flake.nix` exports both, and they are not interchangeable:

| Variable | Meaning |
|---|---|
| `CHROMIUM_PATH` | the executable to launch. Read by `scripts/src/shared/browser_path.ts` and published to **both** browser lanes |
| `PLAYWRIGHT_BROWSERS_PATH` | a directory Playwright treats as its download root. It is set so `bun run setup` skips a download that cannot work on NixOS. It does **not** select a browser |

`setup`'s decision to skip the download used to be
`PLAYWRIGHT_BROWSERS_PATH.startsWith('/nix/store')` — a check on the *name* of a
directory rather than on whether a browser exists. It is now `resolveBrowser()`:
the same capability decision the lanes make.

### Both lanes read one resolver

`apps/frontend/client/vitest.config.ts` and `apps/e2e/playwright.config.ts` both
import `scripts/src/shared/browser_path.ts`. The E2E config used to read
`process.env.CHROMIUM_PATH` inline, which is not equivalent: the shared resolver
also finds a browser in a Playwright cache when nothing is set — the normal case
on a non-Nix host — and names the missing prerequisite when there is none. Two
answers to one question is how the browser lane failed while E2E passed.

Verified inside the Nix shell, which is the host the failure was reported on:

```bash
nix develop -c bun run test:browser     # 15 passed
nix develop -c bun run e2e             # 20 passed
```

## Ports are per worktree, and a busy one is a refusal

`worktreePort()` derives the port from the **checkout path**, so two checkouts —
a Herdr worktree, a second clone, a CI matrix leg — never fight over 4183, and
the same checkout always gets the same port, which is what makes a stale listener
recognisable instead of a random collision.

`allocatePort()` binds and releases to find a candidate and **throws
`PortUnavailable`** rather than returning a busy one. Every caller here wants a
port nobody else has: a collision means a stale process, and proceeding would make
the run assert against the wrong thing.

One value, one home: `playwright.config.ts` computes `APP_PORT` and `preflight.ts`
re-exports it. It used to compute `4183` independently, and when the config moved
to a per-worktree port the two drifted — the Worker came up on 4267, the preflight
kept polling 4183, and the run failed with

```
The app did not become ready within 60s. Last error: fetch failed
```

while the server under test was answering `GET / 200` the whole time.

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

## The task graph, and what a cached hit is allowed to mean

`scripts/tests/task_graph.test.ts` reads the **resolved** graph out of Moon —
`moon query tasks`, which reports the inputs and options Moon actually computed —
and asserts four properties. Reading the resolved graph rather than the YAML is
the difference between "the config says so" and "Moon agrees".

| Property | The defect it prevents |
|---|---|
| every `fileGroup` is referenced by some task | 14 groups were declared and referenced by nothing; a group nothing references is a promise nothing checks |
| no task runs `echo` | `moon run :build` resolved to an `echo` and reported success while having done nothing |
| a resolved input glob is never empty | `apps/e2e`'s `sources` was `src/**/*` in a project with no `src/`, so `e2e:test` hashed to nothing, reported `cached`, and ran an `echo` |
| tasks that run tests hash the files their runner discovers | `scripts/tests/**`, `apps/frontend/client/tests/**` and `apps/frontend/client/scripts/**` were executed by every run and hashed by none |

That last row had a demonstrated consequence. With `scripts:test` warm at
`cached, 53ee8135`, editing `scripts/tests/paths.test.ts` produced the **same hash
again** — a suite that did not run, certified as having run. After the fix, the
same edit is a miss.

### The cache is bounded by what Moon can see

Moon 2.5.5 cannot build a key equal to the files these commands read — `..` is
rejected in a task input, `fileGroups` are project-scope only, and a dependency
task's hash does not propagate to its dependents. Both were measured; the numbers
are in [toolchain.md](toolchain.md).

So the cache is neither trusted nor disabled. `scripts/src/ci/cache_scope.ts`
fingerprints exactly those files and picks Moon's own `--cache` mode:

| Fingerprint | Mode | Observed |
|---|---|---|
| no previous value | `off` | records one, caches nothing |
| changed | `off` | `moon --cache off: 82 files outside every Moon project changed` |
| unchanged | `read-write` | `moon --cache read-write: … unchanged` |
| unreadable, or zero files | `off` | fails closed |

`off` costs time; a wrong `read-write` costs correctness.

### Cold, warm, and the misses between them

Measured on this branch, from a cold `.moon/cache`:

| | Result |
|---|---|
| cold | `bun run test:browser` → `client:test-browser (7s 137ms, 94db999a)` |
| warm, nothing changed | `client:test-browser (cached, 94db999a)`, 52 ms |
| test changed outside `src/` | `moon --cache off` → miss |
| project `moon.yml` changed | miss |
| transitive source changed in a dependency | `moon --cache off: 82 files … changed` → miss |
| `bun.lock` changed | `moon --cache off` → miss |
| `README.md` changed | `read-write` → hit, because it decides no task's result |

### What is deliberately never cached

Guards, the workflow policy, the template smoke, `db-generate`, `check-bundle`,
`test-worker` and `e2e:e2e`. Each asserts against a running process or writes to
the tree, and a restored "pass" would certify a server, a database or a browser
this run never started. That is worse than a failure, because it is believed.

## CI, and what a green run has to have proved

`.github/workflows/ci.yml` has four lanes and one gate. The gate is the only thing
a branch protection rule needs to name.

```yaml
gate:
  needs: [static, unit, worker, e2e]
  if: always() && !cancelled()
  permissions: {}
```

`always()` so a skipped or cancelled lane is a failure rather than a success: with
`if: success()` on the dependents, a lane that never started leaves nothing to
wait for and the gate passes. `!cancelled()` keeps a cancelled run cancelled, which
is neither a pass nor a fail.

Each lane then asserts a **nonzero test count** from the runner's own output. Four
projects declare `bun test --pass-with-no-tests`, so a green run can legitimately
contain no tests; the lane as a whole may not.

Also load-bearing, and each one is a way CI has previously been green for free:

- **Browser prerequisites are installed before the lane.** Installing afterwards
  fails with "Executable doesn't exist" and reads as a broken test rather than a
  broken ordering.
- **Actions are pinned to 40-character commit SHAs.** All three were resolved from
  the GitHub API and verified, not typed from memory — an invented SHA is a
  workflow that cannot run. `bun run workflows` fails on a tag reference and on a
  *truncated* pin, which is the case a "does it contain a hash" check would pass.
- **`permissions: read` at the top, `{}` on the gate.** The default is
  repository-wide, and every job in this file runs repository code.
- **No `secrets.*` anywhere.** `bun run workflows` enforces it for any workflow that
  also triggers on `pull_request`, which is what keeps a fork's run honest.
- **`pull_request_target` is refused.** It runs with the base repository's
  privileges against code the pull request controls.
- **Read-only checks and deployment are different workflows.** "The checks passed"
  and "this was published" are different decisions with different authority.

### Negative controls

Every one of these used the **public** command, on this branch, and the injected
fault was restored afterwards.

| Control | Command | Observed |
|---|---|---|
| an intentionally failing browser assertion | `bun run test:browser` | `1 failed`, **exit 1**, naming the test |
| a broken Worker API assertion | `bun run test:worker` | `18 pass, 1 fail`, **exit 1**, `Expected "negative-control-not-web" / Received "web"` |
| a changed external test invalidates the cache | `cached -- scripts:test` | miss, new hash |
| absent test discovery fails | `bun test` in an empty project | **exit 1**; `vitest run` likewise **exit 1** |
| absent discovery *with* `--pass-with-no-tests` | same project | **exit 0** — which is why CI asserts an aggregate count |
| cleanup leaves no owned process after a failure | `ps`, `ss` after the failed worker run | no `workerd`, no `wrangler`, no listener in the port range |

The `--pass-with-no-tests` row is the reason the CI job greps for a passing count
rather than trusting an exit code. Four projects — `ui`, `database`, `auth`,
`frontend-services` — declare it, so a green run can legitimately contain no tests;
the lane as a whole may not.

### Cache evidence, measured

From a cold `.moon/cache`:

| | Mode | Result |
|---|---|---|
| cold | `read-write` | miss, `ee515f19` |
| warm, nothing changed | `read-write` | **`cached, ee515f19`** |
| test changed outside `src/` | `read-write` | **miss**, `5a863852` — Moon sees it now |
| this project's `moon.yml` changed | `read-write` | **miss**, `55282a6d` |
| transitive dependency source changed | **`off`** | miss — Moon cannot see it, so the gate disables the cache |
| `bun.lock` changed | **`off`** | miss |
| unchanged again | `read-write` | **`cached, ee515f19`** |

The third row is the one that was broken before this change: with
`scripts/tests/paths.test.ts` edited, `scripts:test` reported `cached, 53ee8135` —
the same hash as the run before. The sixth row shows the gate failing closed on a
change it cannot attribute: `bun.lock` moved and was then restored, so the next run
saw a different fingerprint and cached nothing until the tree settled.

## The fresh-template rehearsal

Every other lane runs against this checkout, with `bun` on `PATH`, a warm
`.moon/cache` and a `.wrangler/` holding the last run's state. `bun run smoke`
answers the narrower question: **starting from the committed tree alone, do the
documented commands work?**

```bash
bun run smoke            # temporary checkout, removed afterwards
bun run smoke --keep     # leave it on disk and print the path
bun run smoke --steps 1  # only the first step
```

It copies the tree into a temporary directory with **no `.git`, no `node_modules`,
no build output and no local state**; gives it a synthetic project identity; sets
`HOME` to a directory inside that checkout; and then installs with
`--frozen-lockfile`, runs `setup`, migrates and seeds local D1, builds, checks the
bundle, and runs `doctor`. A credential is not supplied, because none is needed and
supplying one would prove nothing.

Two things it found by running rather than by reading:

- **`.moon/cache` is gitignored; `.moon/workspace.yml` and `.moon/toolchains.yml`
  are committed.** Excluding the `.moon` directory by name produced a checkout
  where `bun run build` failed with `Unable to locate .moon/workspace.{yml,yaml,…}`.
  Only the `cache` subdirectory is excluded now.
- **`setup`'s download skip was a string check, not a capability check.** See the
  browser section above.

The rename is **reported, never performed**. `findIdentityReferences()` lists every
committed `path:line` that names the template's package name or its upstream
repository, with the files that legitimately do — the manifest, the lockfile, the
licence, `docs/rename-checklist.md`, the provenance note and the checker itself —
exempted by name and by reason. A blind global replacement would rewrite the
licence and the migration history; the actual rename is a deliberate, documented
operation.

### Two defects the rehearsal found, and one it will find again

It is worth stating what this command earned its keep on:

1. **A fresh clone could not install.** `bun.lock` still carried
   `apps/backend/api` and `@starter/api`, left behind when PR B removed the
   separate API Worker. `bun install --frozen-lockfile` in a clean checkout failed
   with `lockfile had changes, but lockfile is frozen` — which a warm checkout
   never hits, because the lockfile is already consistent with `node_modules`.
   Every other lane in this repository runs in a warm checkout. Only the rehearsal
   was cold, and it failed.
2. **`.moon/cache` is gitignored; `.moon/workspace.yml` is not.** Excluding the
   `.moon` directory by name produced a checkout where `bun run build` failed with
   `Unable to locate .moon/workspace.{yml,yaml,…}`.
3. **`setup`'s download skip was a string check**, not a capability check — see the
   browser section above.

It will also report this file, because the paragraph above used to spell the
package name literally. That is the intended behaviour: the rehearsal flags
references in prose too, and the fix is to not write the name out.

## Coverage

There is no coverage number, deliberately. Coverage measures which lines ran, and
the interesting failures here are about *what was asserted* — whether a schema
refuses an unknown field, whether an aborted request reports as a failure. A
coverage percentage would be a number to improve rather than a thing to read.

What is measured instead: guards with no baselines, and assertions written so that
each one names a specific failure someone could observe.