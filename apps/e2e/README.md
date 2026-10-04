# apps/e2e

The Playwright suite, and the harness that starts the server it drives.

## Purpose and runtime

Node, driven by Playwright. This project contains no application code: every file
is either a spec under `tests/` or part of the harness (`playwright.config.ts`,
`global-setup.ts`, `preflight.ts`, `capture_evidence.ts`). The guard classifies the
whole directory as role `test` for the same reason.

The lane exists because the cheaper lanes cannot see it. Ten E2E specs once failed
on `assets.not_found_handling: "404-page"` answering a browser *navigation* with
404 while the same URL answered 200 from `curl` — one header's difference. No unit
test and no API test noticed.

## Setup and configuration

```bash
bun run --cwd apps/e2e browsers:install   # the pinned Chromium, with its libraries
```

Through the workspace script rather than `bunx playwright`, which does not resolve
the pinned copy and installs whatever the registry serves — a version mismatch
against the `@playwright/test` these specs run under.

The harness allocates its own port from this checkout's range and stamps a run id
into the served origin, so a leftover listener from an earlier run fails loudly
instead of being mistaken for this run's server. Both come from
`@starter/scripts`' `run_scope.ts` and `browser_path.ts`.

## Commands

From the repository root:

```bash
bun run e2e            # the whole lane: build, start the built Worker, drive a browser
bun run e2e:visual     # capture the evidence screenshots
```

From `apps/e2e`:

```bash
bun run test:e2e       # Playwright with this project's config
bun run test:headed    # the same specs, visible
bun run browsers:install
bun run capture-evidence
bun run typecheck
bun run lint
```

## Tests and artifacts

Assertions on the runner's own output, not on its exit code: a renamed spec
directory makes Playwright report zero tests and exit 0, which is a green job that
ran nothing. CI greps the teed log for a nonzero passing count and fails when the
match finds nothing.

Artifacts, on failure only — traces and screenshots land in
`apps/e2e/test-results/` and `apps/e2e/playwright-report/`, and CI uploads them
with `if-no-files-found: ignore` so an unreleased UI never reaches artifact storage
unnecessarily.

`capture_evidence.ts` produces screenshots. Vision inspection of them reports as
**SKIPPED** with a reason, never as a pass.

The captured screens are `landing`, `login`, `login-error`, `notes-empty`,
`notes-populated` and `jobs-disabled`. Each is a state this deployment actually
reaches: `jobs-disabled` is the jobs screen as signed-in user sees it with the
template's shipped profile, which is **off**, so that is the honest screenshot
rather than a fabricated "Encoded" row. A fixture that only signs in would
photograph `/notes` under another screen's name — the capture harness navigates
first and prepares afterwards, so the fixture has to land where it says it does.

It needs a running server on the port `playwright.config.ts` chose for this
checkout, and says so by name when there is not one.

## Boundaries and documentation

May import `@starter/*` packages. It reaches `scripts/src/shared/*` by relative
path, which is the one declared exemption in
`CROSS_WORKSPACE_RELATIVE_EXEMPTIONS`: the harness and the tooling it configures
are one Bun process, and importing the module is what makes the harness exercise
the real path resolution and port allocation. That exemption is checked for
staleness — if the last import using it goes away, the guard reports the row.

- [docs/testing.md](../../docs/testing.md) — the four lanes and what each proves
- [docs/capability-matrix.md](../../docs/capability-matrix.md) — what is verified, fixture-verified, or not run
- [docs/architecture.md](../../docs/architecture.md) — why one origin, and why a browser rather than `curl`
