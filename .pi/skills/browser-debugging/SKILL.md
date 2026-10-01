---
name: browser-debugging
description: Use when something is wrong in the browser that the terminal does not show — a blank screen, a layout that breaks, a request that fails, a console error, a state that renders wrongly. Captures screenshots, traces, console and network evidence from a verified local environment, and reports them without sending anything anywhere.
---

# Browser debugging

Evidence from a **verified local** environment. Every step below runs against a
real fixture stack this repository already owns, not an ad-hoc server.

## The rule about "verified"

A fixed port answers a readiness probe whether or not it belongs to your run. A
leftover `wrangler dev` from an earlier command keeps port 8787 with a stale D1
and a stale schema, the suite then reports a product bug that is actually a
leftover socket, and you spend the afternoon on the wrong bug.

This repository already refuses that. `apps/e2e/preflight.ts` compares a run id
the Worker echoes back, so a stale listener cannot be mistaken for yours. **Use
those commands rather than starting servers by hand** — a hand-started server has
no run id, and the preflight will correctly refuse it.

## 1. The deterministic lane first

Always run this before looking at anything by eye:

```bash
bun run test:browser
```

Real Svelte in Chromium. A UI assertion that fails is stronger evidence than
anything a screenshot can tell you, and it is reproducible.

If you are changing what a spec touches, `bun run e2e` covers the full stack
(built client, real Worker, real local D1) and retains a trace on failure.

## 2. Deterministic screenshots

```bash
bun run e2e:visual
```

Writes PNGs of the real screens — login, a login error, an empty list, a
populated list — and prints the directory. It starts its own servers through
Playwright, so it captures the same build the e2e suite validated rather than
whatever happens to be on :4183 from someone's terminal.

The directory is `/tmp/starter-evidence` unless `E2E_EVIDENCE_DIR` says
otherwise. Read the files with the `read` tool. They stay on this machine.

## 3. Traces, console and network

Playwright records console output, network requests and a step-by-step trace.
Turn tracing on for a run you are about to inspect:

```bash
bun run --cwd apps/e2e playwright test --trace on
```

Or keep the default `retain-on-failure` and inspect only what broke. The trace
is a zip in `apps/e2e/test-results/`; the HTML report in
`apps/e2e/playwright-report/` has the console and network timeline per test.

Run a single spec while iterating:

```bash
bun run --cwd apps/e2e playwright test tests/auth.spec.ts --trace on
```

`playwright` is declared by `@starter/e2e`, so it is reached through that
package. Never `bunx playwright` from the root: that does not find the local
install and downloads whatever the registry currently serves.

## 4. What the evidence means

| Evidence | Reads as |
|---|---|
| A failing spec assertion | a real, reproducible defect — start here |
| A 4xx/5xx in the network timeline | look at the Worker's log, not the page |
| A console error with no failed request | a client-side throw — get the stack |
| A screenshot that looks wrong with no error | a genuine visual or layout question |
| A screenshot that looks fine with a failed request | a real bug the eye cannot see |

Cross-check the server side with the `debugging-with-logs` skill. The browser
shows you the request that failed; the log shows you what the Worker did about
it.

## 5. Optional vision review — configured, never assumed

Image inspection needs a model that can see images. **Nothing here depends on
one, and no provider is added by this repository.**

- `apps/e2e/visual.ts` reads `VISION_API_KEY` or `OPENAI_API_KEY` from the
  environment, and reads nothing else — no provider SDK, no network probe.
- With neither set, capture still runs and reports **`SKIPPED`**, with the reason.
  It does not print green. That is deliberate: a run that prints green because
  the inspection step was unavailable is worse than one that says it did not run.
- `VISION_DISABLE=1` turns it off explicitly, even with a key present.

So there are three states, and they are distinguishable on purpose:

| State | How it reads |
|---|---|
| Ran | findings listed per capture |
| **Skipped, no provider** | `SKIPPED: … no VISION_API_KEY or OPENAI_API_KEY` |
| **Blocked, a real failure** | a non-zero exit and a failing spec |

Do not treat a skip as a pass, and do not report a skip as a failure either. It
is an absent optional capability.

## What this skill never does

- **Never upload a screenshot.** They can contain unreleased UI and whatever the
  fixture happened to show. They are written locally and left there.
- **Never add a provider or a key** to make vision work. Configuring one is a
  decision for the person who owns the machine.
- **Never substitute a vision opinion for a test.** A model describing a layout is
  an opinion about a picture; a spec is a contract. If the question is whether the
  button works, run the spec.
- **Never `pkill -f wrangler`.** The pattern broad enough to match the dev server
  also matches the shell that launched it, which kills the caller. `preflight.ts`
  prints the pid to use.