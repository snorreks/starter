# Starter E2E and visual quality: findings and implementation prompt

Date: 2026-10-07. This is a proposed implementation plan based on source inspection,
not evidence that the proposed lanes have run. No application code was changed.

## Findings

### Aikami: useful ideas, specific weaknesses

Inspected `/home/sonny/Development/Projects/passion/aikami/apps/e2e/`, especially
`src/visual/`, and `scripts/src/lib/ai/`.

- Declarative `*.visual.ts` suites define routes, setup hooks, prompts, TypeBox
  schemas, masks and hard gates. Reuse this idea, with a smaller fixed result
  contract and explicit page/state coverage.
- `src/visual/core/evaluate.ts` distinguishes boolean requirements from score
  thresholds. Keep hard requirements: a generous average must not hide a missing
  primary action.
- `src/visual/runner.ts` assumes a running server, treats a response below 500 as
  readiness, swallows suite-load errors, and exits zero for zero suites. Its
  `--eval-only` branch does not load stored captures, so it has nothing to evaluate.
  These are source findings; I did not execute the runner.
- There are two cache implementations: the core cache and the shared VLM cache.
  Their image/prompt/schema keys omit provider and model. Use one cache authority
  that includes every input affecting the judgment.
- `scripts/src/lib/ai/image_optimizer.ts` mutates originals, silently catches
  errors, and defaults to square resizing. UI evidence needs preserved originals,
  aspect ratio preservation, readable text, and a reported fallback.
- `scripts/src/lib/ai/ai_vlm_client.ts` can send image base64 as plain text to a
  model outside a hardcoded vision prefix list. It also permits validation to be
  skipped if importing/checking TypeBox throws an unexpected error. Starter must
  fail closed on unsupported image input and unavailable validation.
- Aikami's Unlighthouse command is in `apps/frontend/site/package.json`, not E2E:
  `build`, background preview on port 4398, `sleep 3`, `bunx unlighthouse-ci`, then
  `kill %1 ... || true`. This can lose the audit's failure status, resolves tools
  at runtime, and has fragile process ownership/readiness. Reuse the audit concept,
  not that shell command.

### Starter: preserve what already works

- `apps/e2e/playwright.config.ts` builds and serves the actual web Worker through
  workerd, with one origin, shared Chromium resolution, checkout-derived ports,
  and a run identity verified by `preflight.ts`. Keep these guarantees.
- `capture_evidence.ts` separately captures six desktop states, requires a server,
  uses a 300 ms wait, duplicates account helpers and note data, and tolerates
  missing individual screens. It explicitly reports vision inspection as
  unimplemented even when a key exists. Replace its orchestration and retain the
  old command as a working alias.
- `tests/jobs.spec.ts` covers the disabled jobs profile. The enabled web API is
  tested in Worker integration; real Workflow/R2/D1/FFmpeg is tested separately
  by `apps/backend/jobs/tests/compute_lane.test.ts`. There is no existing browser
  journey connecting those pieces into one running stack.
- `apps/backend/jobs/tests/local_runtime.ts` already uses Miniflare's real
  Workflows/DO/D1/R2 engines. Adapt its mechanisms, not its hardcoded identities,
  into a reusable owned runtime. Confirm cross-Worker Workflow wiring with the
  installed version before committing to a runtime design.
- `compute_lane.ts` uses processor port 8099 and image tag `starter-media:local`;
  it accepts an existing image without a source fingerprint. Concurrent runs and
  stale media builds need explicit handling in the new harness.
- `packages/shared/fixtures/src/index.ts` defines `MOCK_USER` and `MOCK_NOTES`;
  `scripts/src/db/seed.ts` and the Node emulator consume these. Built Worker E2E
  must use real authentication: the emulator user override is deliberately limited
  to local Node runtime in `request_context.ts`.
- Existing visual capture omits reset/forgot-password, verify-email, device
  authorization, and chat routes. Native has its own root, notes and jobs pages.
  UI tokens already support light/dark media preferences.
- `.pi` cannot import `scripts/` source. E2E has a narrow existing exemption for
  shared scripts imports. Put reusable evaluation/optimization in scripts, and
  expose a bounded JSON CLI to Pi. Do not weaken import guards to enable reuse.
- Native builds validate an HTTPS API origin; Tauri APIs are confined to
  `src/lib/platform/`. A browser screenshot is not evidence of a packaged native
  runtime or a Stronghold vault.

## Recommended approach

Keep Playwright as the browser runner. Share one owned runtime lifecycle and one
scenario manifest across functional journeys, screenshots and audit selection.
Put image preparation, providers, grading and reports behind scripts APIs/CLI.
Use native Playwright screenshot comparison for approved browser baselines.
Use a schema-validated vision rubric for semantic/design review.

Alternatives considered:

1. Copy Aikami's bespoke visual runner: quickest initial port, but duplicates
   browser lifecycle, fixture setup, error handling and reporting.
2. Adopt a hosted visual platform: potentially useful later, but adds accounts,
   external artifact ownership and provider dependence to a starter template.
3. Extend Playwright with reusable tooling: recommended; keeps the real browser
   and Worker contracts, supports optional paid evaluation, and minimizes runners.

Use direct Lighthouse for controlled per-scenario audits. Add Unlighthouse only as
an optional public-route exploration command. It must consume the same route
manifest/runtime, not maintain its own server launcher or authoritative gate.

---

## Copyable implementation prompt

Everything below is the implementation brief. Implement in a new branch/PR in
`/home/sonny/Development/Projects/passion/starter`. Read AGENTS.md and the linked
testing, architecture, compute, agent and toolchain docs first. The user requests
implementation of this plan; execute its stages in order and report evidence.
Do not modify Aikami. Treat its source as a reference, not a library dependency.
Create a draft PR if repository access permits; never merge or deploy.

### Objective and invariants

Deliver a clean E2E system with:

- A self-starting local built-web runtime and isolated synthetic fixture data.
- Real browser journeys through frontend, web API, jobs Workflow, DO broker,
  local D1/R2, and the real Rust/FFmpeg container in an explicit Docker lane.
- Desktop/mobile and light/dark capture of all current frontend routes and
  representative UI states, with declared gaps rather than silent omission.
- Deterministic browser assertions and reviewed screenshot baselines.
- Optional structured vision review, optional design-reference comparison,
  and optional System One scoring followed by descriptive diagnosis.
- Lighthouse scores and metric budgets; local HTML/JSON reports with provenance.
- Shared scripts logic callable by both E2E and Pi without boundary violations.

Never make a required lane succeed by skipping it. Preserve disabled-compute
behavior, real session/ownership checks, one public web origin, no jobs REST API,
and no database/auth packages in native/browser bundles. Never substitute a mock
media response for evidence of FFmpeg execution. No arbitrary uploaded-media
feature, new public test admin API, remote provisioning, or deploy is needed.

### Commands and result semantics

Provide these root commands, documented and uncached where they observe runtimes:

| Command | Contract |
| --- | --- |
| `bun run e2e` | Existing credential-free functional lane; preserve current assertions |
| `bun run e2e:visual` | Start stack, prepare fixtures, capture and deterministic visual checks; no model calls |
| `bun run e2e:visual -- --update-snapshots` | Explicit local baseline update, never automatic on CI |
| `bun run e2e:visual:review -- --run <id-or-manifest>` | Evaluate an existing capture manifest; server/browser not required |
| `bun run e2e:visual:review -- --capture` | Capture then evaluate using configured provider |
| `bun run e2e:audit` | Start stack, Lighthouse selected route/scenario states on desktop/mobile |
| `bun run e2e:full` | Real browser-to-media black box; Docker required |
| `bun run e2e:doctor` | Report capabilities for selected lanes, with remedies and actual launch probes |

Keep `capture-evidence` as an alias to the new capture operation. Optional
`e2e:explore` uses Unlighthouse against approved public routes only. Do not add
optional providers, Docker or paid calls to `test:all` implicitly.

Every operation records `passed`, `failed`, `error`, `not-run`, or
`not-applicable`, plus fresh/cached provenance. A runtime/provider/schema error
is different from an observed product defect. Nonzero exit for any required
failed/error/not-run result, unmatched filter, zero discovered tests/scenarios,
missing required capture/reference, or incomplete capture manifest. Capture-only
success means capture/checks succeeded and explicitly says AI was NOT RUN.
Advisory review may exit zero for observed visual findings, but must still exit
nonzero for configuration/transport/schema errors; offer `--gate` for calibrated
AI thresholds. No default invented universal "80 means good" CI gate.

### Proposed file ownership

Keep modules cohesive; split along these responsibilities, not arbitrary line
limits. Reuse existing modules wherever their contracts fit.

```text
apps/e2e/
  playwright.config.ts                 # functional project configuration
  playwright.visual.config.ts          # selected capture/baseline projects
  playwright.full.config.ts            # Docker-backed integrated journey
  src/
    config/run.ts                      # pure run options; no importing Playwright config
    fixtures/test.ts                    # Playwright test extension and fixture lifetimes
    fixtures/accounts.ts               # real signup, captured email, verified login
    fixtures/scenarios.ts              # apply shared synthetic records through public APIs
    pages/auth.ts                      # small shared interaction helpers
    pages/notes.ts
    pages/jobs.ts
    scenarios/manifest.ts              # explicit cases and variants; runtime validation
    scenarios/auth.ts
    scenarios/notes.ts
    scenarios/chat.ts
    scenarios/jobs.ts
    scenarios/native.ts
    visual/capture.ts                  # readiness, identity/URL assertions, attachments
    visual/coverage.ts                 # route discovery versus scenario declarations
    audit/targets.ts                   # manifest-derived auditable states/auth preparation
  tests/                               # retain existing functional behavior
  tests/visual/pages.spec.ts            # manifest-driven screenshot and layout assertions
  tests/full/encode.spec.ts             # real cross-Worker/browser/media path
  references/manifest.json              # optional imported design references + provenance
  references/images/                   # local exported Figma/design frames
  baselines/                           # reviewed deterministic snapshot artifacts

scripts/src/e2e/
  runtime.ts                           # owned lifecycle: start, ready, dispose
  worker_runtime.ts                    # actual built web/jobs binding graph and assets
  processor.ts                         # Docker engine, source-fingerprinted image/container
  run_manifest.ts                      # durable versioned run identity and artifact records

scripts/src/visual/
  config.ts                            # validated tool-only env and config precedence
  schemas.ts                           # TypeBox output contracts and semantic validation
  images.ts                            # original preservation + readable review derivatives
  prompt.ts                            # versioned rubric and reference comparison instructions
  providers/structured_vision.ts       # declared image + JSON-schema-compatible HTTP provider
  providers/ollama.ts                   # local structured vision, if included
  providers/system_one.ts              # optional verified score protocol
  evaluate.ts                          # bounded calls and evaluation pipeline
  grade.ts                             # deterministic scoring and hard gates
  cache.ts                             # one content-addressed validated evaluation cache
  report.ts                            # escaped local HTML + JSON + concise summary

scripts/src/audit/lighthouse.ts         # serialized measurements and explicit auth/state handling
scripts/src/commands/visual.ts          # JSON CLI surface usable by Pi
scripts/tests/                         # fixture-driven boundary/failure tests
.pi/lib/visual.ts                       # bounded CLI adapter only, if adding a Pi tool
.pi/extensions/visual.ts                # thin entrypoint only, if adding a Pi tool
.pi/tests/visual.test.ts
```

Scripts may import shared packages only. They accept artifact locations and
scenario data; they must not import E2E/app modules. E2E owns application-specific
interactions. New E2E-to-scripts imports must comply with the existing narrow
exemption: use declared package exports or justify a narrowly scoped update;
do not exempt whole directories. Pi calls a scripts CLI using its existing
bounded process helper. If direct in-process reuse becomes necessary later,
extract a dedicated Node-only shared package rather than placing browser-unsafe
code in a shared barrel.

Update Moon source groups to include `src/**/*`, scenarios, references and
baselines. Separate Bun tooling tests from Playwright specs so neither runner
discovers the other's tests. Declare tools in their owning workspaces, pin actual
compatible versions, and resolve through those workspaces. No runtime `bunx`.

### Stage 1: prove the owned runtime before migrating tests

1. Extract pure run configuration from `playwright.config.ts`/`preflight.ts`:
   run ID, origins, ports, profile, artifact root, fixture revision and deadlines.
   Avoid module-generated identities being regenerated in child processes;
   persist/pass a single identity explicitly.
2. Use an invocation-specific temporary state directory and ports from existing
   allocation helpers, with actual availability checks. Same-checkout concurrent
   runs must either get separate owned resources or fail immediately and clearly.
   Never mutate a developer's `.wrangler` database to clean up a test run.
3. Default to building/starting owned processes. Preserve the existing web
   launcher's behavior where feasible; add an explicit state-dir contract shared
   by migrations and serving. Do not maintain competing var/config translators.
4. For full integration, prove a local multi-Worker binding graph using pinned
   Wrangler or Miniflare: built web Worker + static assets, built jobs Worker,
   same D1 database identity and same R2 bucket identity, real cross-Worker
   `ENCODE_WORKFLOW`, DO, and local processor origin. Reuse configuration facts;
   test derived config drift rather than duplicating compatibility dates/classes.
   Fail if web and jobs accidentally get separate stores.
5. Native capture reuses shared fixture/scenario content but owns its frontend
   origin. Keep API-origin validation intact. Start with browser-rendered native
   UI using its supported development host/composition boundaries, explicitly
   labelled `native-ui-browser`; never claim that this ran a packaged Tauri app.
   Verify any real device/bearer path separately from mocked platform capabilities.
6. Prefer owned startup. Optional explicit attach requires a matching persisted
   harness identity, build identity, profile and origin. Arbitrary dev-server
   attach is capture-only and labelled unverified; cannot certify E2E or baselines.
   A 200 response is not sufficient identity. Never kill an attached server.
7. Startup and teardown must handle partial startup, cancellation, timeout and
   SIGINT/SIGTERM. Stop only owned children/containers; dispose runtimes before
   deleting state. Preserve failure evidence. Report cleanup failures without
   overwriting the original failure. Test ports can be rebound after disposal.
8. Docker image identity must include Dockerfile, Cargo lock/source, and relevant
   build context. Avoid stale named-image reuse. Containers use run-specific names
   and ephemeral loopback ports; clean them on every exit path.

Acceptance: one small real browser/API smoke probe succeeds with no existing
server; a wrong run ID is rejected; two run scopes never share data; partial
startup and interrupted execution leave no owned listeners/containers. Prove
the full binding graph before spending effort on a general reporting framework.

### Stage 2: canonical fixtures and explicit coverage

Extend the shared fixtures package with serializable named content scenarios:
empty, populated, long text/Unicode, known validation inputs, deterministic chat
content, and media fixture/preset descriptors. Keep existing exports compatible.
Fixtures carry no browser, server, provider, subprocess or database dependencies.
Avoid creating a second independent seed catalog in E2E.

Use real auth/account creation and API writes for built-web fixtures. Real auth
generates IDs/timestamps: compare shared content while resolving ownership to the
new account. Do not reuse the emulator-only identity override. Keep business
timestamps predictable where the API permits; normalize or explicitly mask only
irrelevant volatile display fields. Never freeze the auth/server clock globally.
Namespace mutable accounts per scenario/run; never share writes between tests.

Create a scenario manifest with stable ID, app, route template and resolved URL,
state, fixture ID, setup helper, ready assertions, expected content/controls,
variant list, capture regions, visual requirements, reference ID, audit eligibility,
and runtime profile. JSON data is TypeBox-validated; executable helpers remain
typed TypeScript referenced by stable names.

Discover `+page.svelte` routes for both client and native. Each discovered route
must map to scenarios or a specific reviewed exclusion. Dynamic `/chat/[id]`
uses a fixture-created conversation; tokens for email/reset/device pages come
from their real local flows. Also declare 404/error screens even though they are
not separate page files. New uncovered routes fail a coverage check. Route
coverage cannot prove every UI state: list state requirements explicitly.

Initial web coverage: landing; login/signup/invalid credentials; forgot-password
and reset valid/invalid; verify-email valid/invalid; device authorization states;
notes anonymous/empty/populated/long content/create/delete; chat empty/list/
conversation/stream/error where the shipped profile actually supports them;
jobs disabled, and encode empty/pending/succeeded/failure in the appropriate
runtime profile. Native coverage: root/signed-out, notes and jobs, plus reachable
authenticated/confirmation states using explicit host capability handling.

Use desktop 1440x900 and mobile 390x844 with a declared DPR (start at 1 for stable
baselines), locale/timezone, and light/dark for every applicable primary state.
Mobile dimensions are responsive-browser evidence, not an iOS/Safari claim.
Add focused 320px, landscape, keyboard focus, reduced-motion and enlarged-text
cases for important flows; avoid multiplying every axis across every state.
Report the exact generated matrix and declared gaps per app/profile.

### Stage 3: stable visual capture and useful design references

Migrate capture into Playwright fixtures/specs so server startup, accounts,
timeouts, retries and traces have one lifecycle. Assert route, heading, controls
and content before photographing. Await fonts and relevant decoded images and
web-first state assertions. Use animation/caret controls and stable screenshot
assertions; no arbitrary sleep or blanket `networkidle` requirement on streaming
pages. Record console exceptions, broken relevant assets and unexpected failed
API calls with explicit narrow expected-error declarations.

Capture a viewport image for composition and selected element/full-page images
for content. Tall pages must not be shrunk into unreadable single images: use
bounded overlapping sections with crop coordinates and original dimensions.
Retain pristine PNG originals for pixel comparisons. Missing required images
fail the run even if other scenarios succeeded. Never evaluate stale files left
by another run; review reads only manifest-listed artifacts with verified hashes.

Approved baselines use Playwright `toHaveScreenshot` with small explicit
tolerances per rendering environment. Set a canonical CI Chromium/OS/font
environment; label local differences honestly. Do not quantize baseline pixels
or auto-approve updates. Deterministic assertions cover overflow, control
visibility, expected content and keyboard flow. Add pinned axe integration for
applicable accessibility rules, with reviewed exceptions, while retaining real
keyboard checks; screenshot AI must not invent contrast measurements.

References are separate from previous-build baselines. Support local exported
Figma/design PNGs first, with source URL/node/frame description, hash, expected
viewport, theme, content state, region and allowed intentional differences.
No Figma credentials or live Figma SDK required. Reject incompatible reference
variants or report them not-applicable with a reason. Compare labelled ACTUAL
and REFERENCE images at consistent scale/region. Do not stretch either image.

### Stage 4: image preparation with observable fallback

Implement `prepareReviewImages` in scripts. Input: original path, crop metadata,
provider MIME/dimension/payload capabilities and preparation settings. Output:
validated derivative path/hash/MIME/dimensions/bytes plus backend used, changes
and fallback reasons. Original bytes never change.

Backend preference: optional declared Sharp, then capability-probed ImageMagick
`magick`, then optional FFmpeg, then the original valid PNG. Use bounded argv
calls, atomic temporary outputs, decoded-output verification, preserved aspect
ratio, no upscaling, and a text-readable size policy. Do not use aggressive
palette quantization by default. Make formats follow provider support; do not
assume every endpoint accepts WebP. Prefer actual byte savings over blindly
encoding every image. Runtime optimizer failure is visible and falls through to
the next valid backend; corrupt/missing input is an error, not a fallback.

If the original fits configured/provider limits, unavailable optimizers are a
reported fallback and capture/review can proceed. If it exceeds limits and no
safe derivative can be produced, fail preparation with a concrete remedy.
Never silently truncate input or send an unreadable thumbnail. Tests with fake
executables and small image fixtures prove missing tools, nonzero status,
timeout, corrupt output, aspect ratio, original immutability and oversize failure.

### Stage 5: provider configuration, structured judgments and optional cascade

Use an explicit gitignored root `.env.e2e` with `.env.e2e.example`. Read it in
tooling only. Process environment wins over file values; CLI nonsecret overrides
win over both. Reuse the existing dotenv/environment conventions where possible.
Do not expose any value through `VITE_*`, Worker vars, argv, HTML or artifacts.

Example supported configuration (validate actual enum/units):

```dotenv
E2E_VISION_PROVIDER=openrouter
E2E_VISION_MODEL=<explicit-image-and-structured-output-capable-model>
E2E_VISION_BASE_URL=https://openrouter.ai/api/v1
E2E_VISION_API_KEY=
E2E_VISION_TIMEOUT_MS=60000
E2E_VISION_CONCURRENCY=2
E2E_VISION_MAX_CALLS=50
E2E_VISION_MAX_OUTPUT_TOKENS=2500
E2E_VISION_POLICY=advisory
E2E_SYSTEM_ONE_ENABLED=false
E2E_SYSTEM_ONE_BASE_URL=
E2E_SYSTEM_ONE_MODEL=
E2E_SYSTEM_ONE_API_KEY=
```

Implement one well-tested structured vision transport first (OpenRouter or a
declared compatible image/JSON-schema endpoint), with an adapter boundary for
Ollama. If supporting Ollama, implement and fixture-test its actual image/format
request shape. Do not call a generic compatible endpoint an Ollama implementation.
No default hardcoded "best" model or text-only base64 fallback. Validate declared
capabilities against provider metadata where available; retain explicit model
configuration for local/custom endpoints. Unsupported vision is a named error.
No silent remote fallback when a user selected a local endpoint.

Use TypeBox 1.x already pinned in this repo, never an accidental second major.
Send provider-supported strict JSON Schema and always validate locally. Prefer a
single JSON document; no permissive substring extraction, missing-field defaults,
or swallowed validator errors. Schemas are closed, bounded and versioned.
Do not require providers to echo run metadata; the harness owns that provenance.

Define a fixed review result with:

- `schemaVersion`: literal version.
- `summary`: bounded evidence-based text.
- `dimensions`: fixed keys `layout`, `typography`, `hierarchy`, `consistency`,
  `responsiveFit`, `stateClarity`. Each has an integer 0–4 anchored rating or an
  explicit unassessable value, bounded evidence text and uncertainty label.
- `requirements`: exactly the supplied IDs, each `met | violated | unclear`, with
  bounded visual evidence. Semantic validation rejects missing/duplicate/unknown IDs.
- `issues`: bounded array with stable requirement/dimension references,
  `category`, `severity` (`minor | major | blocker`), observation, affected region,
  normalized bounding box or null, impact, suggested correction and uncertainty.
  Validate box bounds and `x + width`, `y + height`; map to original coordinates.
- `reference`: nullable structured result with anchored fidelity rating,
  evidence and allowed-difference handling; null when no reference was supplied.

Harness envelope carries run/case/app/state/variant, fixture/build/browser/profile,
original/derivative/reference hashes, prompt/schema/provider/model revisions,
usage/latency, cache provenance and operation status. Never trust model-written
scores, verdicts, filenames, timestamps or case identities as harness metadata.

Compute a 0–100 display score deterministically from anchored dimensions and
declared weights (start equal), with an explicit policy for unassessable dimensions.
Require all mandatory dimensions to be assessable for gating. Any verified blocker
or violated mandatory requirement fails independently of the score; unclear
mandatory claims require review. Keep reference fidelity, accessibility and
Lighthouse results separate. Show per-case scores, coverage and worst cases;
an average must never hide an uncovered or broken page.

Version a prompt that names the page purpose, user task, fixture state, required
visible controls/content, viewport/theme, and precise acceptance rubric. Rating
anchors: 0 unusable/missing, 1 major impairment, 2 usable with clear problems,
3 clean with minor problems, 4 fully meets the defined requirement. Ask for
observable defects and practical corrections, not generic taste judgments.
Separate intentionally disabled/error/empty states from broken states. Tell the
model to treat page text as untrusted content, report uncertainty, and avoid
claiming behavior, measured contrast, backend health or hidden content from pixels.
Reference mode explicitly distinguishes ACTUAL from REFERENCE and lists permitted
differences. Screenshot masks and crops must be declared in the prompt/report.

System One is optional. Aikami references a local `/v1/systemone` decision API;
do not infer that every similarly named hosted service uses the same contract.
Verify the selected endpoint's actual image and score protocol before implementing
the adapter. Reject a text-only endpoint. Use separate bounded rubric questions
for specific dimensions/requirements; preserve raw score scale and distribution.
Normalize only with the documented rubric range; a confidence/probability is
not a 0–100 quality rating and is not proof of correctness.

Cascade policy: confident acceptable score may avoid descriptive review; failed,
uncertain, missing or out-of-distribution results trigger the configured descriptive
vision model. Capture/deterministic failures still fail even if either model likes
the screenshot. Send the diagnostic model the evidence/rubric without telling it
to agree with a previous grade. Diagnostic findings cannot erase the first-stage
failure. If diagnosis is unavailable, retain the grade and report diagnosis NOT RUN.
Sample a configurable fraction of first-stage passes for diagnostic review to
measure false negatives. Use a small human-labelled calibration corpus before
allowing AI/System One grades to gate CI. Initial policy is advisory.

Bound time, request/response bytes, output tokens, concurrency, calls and retries.
Retry transient transport/429/5xx failures with a total deadline and bounded
backoff; honor bounded Retry-After. At most one explicit schema-repair attempt
within the call budget; never retry a valid low grade until it passes. Missing
usage/pricing is unknown, not zero; call/token limits are enforceable without
pretending to know dollar spend. Persist usage where returned.

Cache validated judgments by original and actual sent image hashes, references,
prompt/rubric/schema, requirements, provider/base endpoint identity/model/version,
generation options and preparation policy. Use one ignored content-addressed cache,
atomic writes and validated reads. Recompute policy verdicts on cached judgments;
changing a threshold must affect the result. Do not cache errors as passes.
Support `--no-cache` and freshness limits; mark cached results as reused evidence.

### Stage 6: one real black-box browser-to-media journey

Use the real built web/jobs Workers and actual shared local stores with the real
Docker processor. Seed the committed `sample-v1.mp4` into local R2; do not generate
fake output rows. Launch fresh builds and migrate the temporary D1 before use.

From a real browser: sign up, follow captured verification mail, sign in; navigate
to jobs; submit an encode through the UI; observe public admission and job ID;
wait with bounded polling for the actual terminal UI; reload and prove the result
persists. Do not require observing a fleeting running state to avoid timing flakes.
Fetch/download output through the owner's public `/api/jobs/:id/output` endpoint,
verify nonempty MP4, byte count/hash against public metadata, and probe the artifact
with FFprobe inside the owned processor container so host FFmpeg is unnecessary.
Verify the committed duration/codec/dimensions required by the preset.

Add focused tests for same-key replay without duplicate jobs, another verified
account denied job/output access, and signed-out denial. Verify existing Range
semantics with a small bounded partial read. For browser-visible failure/retry
states, use a separately labelled scripted processor implementing the genuine
protocol and deterministic injected failures; never label it real media evidence.
Keep real negative controls and lifecycle races already covered by compute tests
in that lane rather than duplicating the entire compute suite in Playwright.

The browser black box must create jobs through the UI/API, never call repository
services or Workflow creation directly. Harness-only D1/R2 observations may explain
failures and verify wiring/cleanup; they must not replace public behavior assertions.
Do not claim local runtime proves managed Cloudflare container lifecycle or natural
cron delivery. Keep existing compute evidence limitations explicit.

### Stage 7: performance audit and reports

Audits derive concrete targets and auth preparation from the scenario manifest.
Run Lighthouse against fresh navigations in a dedicated owned Chromium profile,
with resolved executable, explicit mobile/desktop settings, documented throttling,
and pinned tool version. Preserve authenticated cookies/storage and verify the
requested route/state was audited, not its login redirect. Never put session
values in argv, logs or published reports. Audit-only runs start their own stack.

Initial controlled performance sample: three valid serialized runs per target;
save every run and median results. Increase to five when establishing gating
budgets. Never run performance collection alongside Docker encoding, other browser
work, or LLM image preparation. A failed sample is not silently dropped to improve
the median; insufficient valid samples fail the audit operation.

Report Lighthouse performance/accessibility/best-practices/SEO separately, plus
LCP, CLS, TBT and meaningful byte/request budgets. Select page-specific absolute
budgets after measuring the actual starter in a fixed environment; record that
initial values are provisional. Authenticated pages can have intentional SEO
restrictions. Accessibility checks do not replace keyboard testing. Lab TBT is
not field INP; local emulator numbers are not deployed user performance.

Lighthouse navigation audit does not necessarily preserve prepared transient UI
states. Audit durable fixture-backed route states; for transient interactions use
the supported user-flow/snapshot/timespan API and label its audit mode. Unsupported
state auditing is an explicit gap, never a claimed navigation result.

Optional Unlighthouse provides a public-route overview from the same manifest,
with sampling/grouping that cannot silently omit required declared routes. It
must not click authenticated destructive flows or replace scenario coverage.
Keep its version pinned and artifacts local; no shell background/sleep wrapper.

Write an atomic versioned `run.json` and escaped local HTML report under a unique
ignored run directory. Include expected/discovered/executed counts, page/state/
app/viewport/theme coverage, deterministic results, original/derivative/reference/
diff images, criterion evidence, issue regions, grades, audit results, runtime
errors, not-run reasons and exact rerun commands. Retain Playwright traces and
sanitized logs for failures. Export a concise JSON result through the scripts CLI
so Pi can inspect an image using the same optimizer, provider, schema and grading.
Test HTML escaping and secret redaction. Do not duplicate secrets or full auth
state in artifacts; use synthetic public content in screenshots.

### Stage 8: verification, documentation and PR

Write meaningful fixture-driven tests for failure boundaries before implementation.
Required proofs include:

1. Wrong identity, occupied port, isolated data, startup timeout, partial cleanup,
   signal cleanup, and concurrent-run safety.
2. Missing route coverage, zero/unmatched selection, wrong captured URL,
   missing individual screenshot, corrupt manifest and stale/tampered image.
3. Optimizer unavailable/crashed/hung/corrupt output, retained original,
   aspect ratio, oversize payload and supported MIME handling.
4. Local HTTP provider fixtures receiving real image parts and strict schema;
   valid review, invalid/extra/missing fields, refusal/truncation, response limit,
   deadline, bounded 429 handling and no retry-until-pass.
5. Deterministic hard requirement and blocker gates, unknown requirements,
   invalid boxes, unassessable dimensions, reference mismatch and cache isolation
   after changing image/reference/model/prompt/schema/options or policy thresholds.
6. Optional System One score protocol fixture, normalization, uncertainty
   escalation, failed-grade diagnosis and sampled-pass escalation.
7. Real browser flow against the built web Worker, real screenshot comparison,
   real Lighthouse execution, and real full encode with Docker where available.
8. Pi CLI argv/timeout/cancellation/result validation and actual Pi loader smoke
   if an extension is added. Preserve the tool-surface budget; extend an existing
   suitable tool where possible instead of accumulating overlapping commands.

Do not mock every internal function. Use temp directories, real bounded processes,
local HTTP servers, real small image files and browser entrypoints at the edges.
Keep ordinary unit tests free of Docker and external API keys.

Run appropriate targeted checks, then the repository-required typecheck, lint,
format, guard, workflows/evidence consistency and relevant existing test lanes.
Verify install/lockfile consistency after dependency changes. Update root commands,
Moon inputs/tasks, E2E README and docs/testing.md. Record actual execution evidence
in the existing evidence workflow; do not fabricate counts or provider results.
Update the capability matrix through its established generator/authority.

Live paid-provider checks are NOT RUN if keys are absent; prove the HTTP adapter
with fixtures and give the exact remaining review command. Docker/Chromium missing
must fail the invoked live lane with a named remedy; record NOT RUN and the exact
remaining command. Do not replace these checks with skips or alter assertions.

Use separate focused commits for runtime/fixtures, visual capture, review tooling,
full integration, audits and docs. Keep the PR description around final behavior,
validation and limitations. Create a draft PR when possible and return its URL;
if remote access is unavailable, return the branch and exact PR creation command.
Do not merge, deploy, or modify unrelated product features.

## Primary references for implementation

- [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots):
  stable screenshot assertions and rendering-environment considerations.
- [Lighthouse measurement variability](https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md):
  serialized repeated measurements and aggregation rather than single-score claims.
- [Unlighthouse authentication](https://unlighthouse.dev/guide/guides/authentication):
  cookies, programmatic authentication and storage-reset handling.
- [OpenRouter structured output](https://openrouter.ai/docs/guides/features/structured-outputs):
  strict JSON Schema is model-capability-dependent; local validation remains required.
- [Ollama structured vision example](https://github.com/ollama/ollama-js/blob/main/examples/structured_outputs/structured-outputs-image.ts).
- [System1 Models API](https://system1models.ai/docs/api/reference) and
  [System One primitives](https://docs.system-one.dev/en/docs/primitives): distinct
  examples of score/image services; select and verify the actual endpoint instead
  of conflating providers that use similar terminology.
