# apps/e2e

## Purpose

Playwright browser checks for the built SvelteKit Worker and the browser-rendered
native host. The project contains no product code; it owns test fixtures, route
coverage, runtime lifecycle, screenshot evidence and Lighthouse measurements.

## Commands

From the repository root:

```bash
bun run e2e                         # existing built Worker functional lane
bun run e2e:visual                  # full visual matrix; no model calls
bun run e2e:visual -- --update-snapshots  # explicit local baseline update
bun run e2e:visual:review -- --run <run-id> # optional structured vision review
bun run e2e:visual:review -- --capture     # capture and review using .env.e2e
bun run e2e:audit                   # three Lighthouse samples per public target/viewport
bun run e2e:full                    # built client + local Supabase; compute disabled
bun run e2e:doctor                  # Chromium, Node/Lighthouse and Docker checks
bun run test:compute                # Docker compute lane; the real-encode proof
```

The visual command covers every discovered Svelte page route plus declared UI
states, at 1440x900 and 390x844 with light/dark themes. It writes a versioned
`run.json`, a local HTML index, original screenshots, traces on failure and
baseline snapshots under the ignored `.wrangler/runs/<run-id>/artifacts/` tree.
The manifest lists each deliberate coverage gap: the root error boundary has no
deterministic trigger; valid reset and device codes are secret-bearing; create and
delete are exercised in functional flows but not captured separately; chat
transport failure needs a deterministic fault fixture; enabled job states are
covered by the Docker lane rather than the visual matrix; and native captures use
the browser host. Mobile captures are responsive
Chromium evidence, not iOS or Safari evidence. Native captures run the supported
Vite browser host, not a packaged Tauri application.

Visual review is optional. Copy `.env.e2e.example` to the gitignored `.env.e2e`, set
an explicit image-capable model and key, then pass a complete capture run to the
review command. The adapter sends image bytes with strict structured output and
validates the response locally. Without credentials, the live provider check is
not run; the HTTP adapter is covered with a local fixture. Review output and its
content-addressed cache remain local. System One scoring and design-reference
comparison are not implemented yet.

`e2e:full` provisions an isolated local Supabase stack, builds only the client,
and serves its built web Worker in Miniflare using the committed Wrangler
configuration. The runtime reports that compute is disabled. The existing full
encode spec still expects enabled jobs and a media container, so this command
cannot currently pass that spec or provide real-encode evidence.

`bun run test:compute` is the only real-encode proof: the Docker compute lane
builds `Dockerfile.job` and runs the finite media runner against local protocol
fixtures. It requires a running Docker-compatible engine and image build access.
Local tests do not prove Cloud Run's managed lifecycle or Cloudflare cron delivery.

Lighthouse runs only public durable routes represented in the scenario manifest
(`web-landing` and `web-login` currently), on desktop and mobile, with three
serialized navigations per target. It records all four category scores, LCP, CLS,
TBT, transfer bytes and request count, plus raw reports and median summaries. These
local measurements are not field Core Web Vitals. Their provisional thresholds are
recorded in each report and fail this local audit when exceeded; they are not yet
CI quality gates. Authenticated scenarios are omitted rather than audited after a
login redirect. The optional Unlighthouse public-route exploration command is not
implemented; the declarative scenario manifest remains the route-coverage
authority.

## Setup and artifacts

The harness selects the same Chromium as the browser lane and allocates per-run
ports, state and artifacts. It refuses a stale server whose health response does
not echo the invocation's run ID. `bun run e2e:doctor` proves the browser can
launch, requires Node.js >=22.19 for Lighthouse, and checks that a Docker-compatible
engine responds. Docker is needed for the local Supabase stack as well as the
separate compute lane; a successful doctor check alone does not prove an encode.

From this package, `bun run test:e2e`, `bun run test:visual`, `bun run test:audit`,
`bun run test:full`, `bun run test:tooling`, `bun run typecheck`, `bun run lint` and
`bun run format` run the respective lanes directly. The shared scenario manifest
is Standard Schema-validated and compared to dynamically discovered `+page.svelte` routes;
an added route without a declared scenario fails tooling tests.

## Boundaries

E2E may import shared packages and the repository's bounded tooling helpers. Shared
fixtures contain only serializable synthetic content. Real account fixtures use
the public signup, captured local verification mail and browser sign-in flows; no
emulator-only identity override is available in the built Worker.

See [docs/testing.md](../../docs/testing.md),
[docs/capability-matrix.md](../../docs/capability-matrix.md), and
[docs/compute.md](../../docs/compute.md).
