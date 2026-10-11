# Billing and the dev stack

Two things are documented here because they are one mechanism wearing two
faces: **what this project sells**, and **which local services a development run
starts**.

The link between them is a name. `@starter/billing` is the catalogue;
`bun run stripe:setup` declares it in a Stripe account; `bun run dev --stack
stripe` points a development run at that same test account. If the catalogue and
the account disagree, every layer above them inherits the disagreement, so neither
is allowed a second copy of a price.

## The catalogue

`packages/shared/billing` holds every plan, every credit pack, the currency they
are charged in, and the webhook events the application acts on. It is the only
place an amount appears.

Prices are not duplicated into handlers, into a pricing page, or into a test
fixture. A checkout request names *what it wants* — `team`, `month` — and
`resolveSubscription` in that package returns the amount, the Stripe lookup key and
the currency, or a refusal naming the cause and the remedy. There is no amount
parameter on any billing function, so there is no path by which a caller can
choose what it pays.

The package is **portable** rather than sitting beside the Stripe handlers, and
that is forced by the architecture rather than chosen: `MAY_REACH` in
`scripts/src/guards/policy.ts` forbids `node -> worker`, and two planes must read
this file — the Worker validating a checkout, and the tooling declaring the
catalogue. A catalogue either side would be a second copy.

### What the catalogue refuses

| Situation | What happens |
|---|---|
| Unknown plan or pack | Refused, with the ids that do exist |
| A plan that exists but is not for sale | Refused as *not purchasable*, not priced at zero |
| A purchasable plan with a zero price | Impossible by construction: a free plan is granted, not bought, so it is not `purchasable` |
| Two prices sharing a lookup key | Refused — reconciliation would pick one arbitrarily and a customer could be billed either amount |

That last row is the one worth stating as a fact about this repository: it exists
because each of the others was once the other way round.

## Declaring the catalogue

```bash
bun run stripe:setup -- --dry-run                    # read only; report what would change
bun run stripe:setup                                 # reconcile a real test account
bun run stripe:setup -- --webhook-url https://…     # also reconcile the endpoint
```

It reads `@starter/billing` and makes the account agree with it.

**Idempotent.** Run it twice and the second run writes nothing: every object is
found by `lookup_key` or `metadata.plan_id` and left alone.

**A changed price is rolled forward, not edited.** Stripe prices are immutable. If
the amount in the catalogue changes, the old price is archived and a new one
created, and the outcome is reported as `created` rather than `updated`. Editing a
price is the failure that keeps billing the old amount to existing subscribers
while reporting that the catalogue was updated.

**A plan that is not purchasable is reported, not skipped.** It appears in the
output with the reason. A `continue` would be a silent skip, and a run that looks
complete while omitting a catalogue entry is the outcome this repository treats as
worse than an error.

### Where the secret goes

Not into a `.env` file. The key is read from `STRIPE_SECRET_KEY` or from the
run-owned 0600 vars file `bun run dev --stack stripe` writes, travels in an
`Authorization` header, and is never an argument, never printed, and never written
back to disk. Where it belongs permanently is the deployment's decision, made
through the deployment's channel.

### What it refuses against a local target

`stripe-mock` accepts writes and keeps nothing. Against it the API calls succeed
and **no Stripe object exists as a result**, so the command says so and exits `4`
(refused) rather than exiting `0` having achieved nothing. That is the whole
reason `EXIT.refused` is separate from `EXIT.failed`. The dev stack no longer ships
an emulator, but a developer can still run one, so the refusal holds for them too.

## Developing against Stripe

```bash
bun run dev --stack stripe
```

There is **no emulator**. The stack points the application at Stripe's own test mode,
so a checkout session is a real object in a real account, and a webhook is a real
event. Configure it once, in `apps/frontend/client/.env.local` (gitignored, and read
by the dev server):

```bash
STRIPE_API_BASE=https://api.stripe.com
STRIPE_SECRET_KEY=sk_test_…        # https://dashboard.stripe.com/test/apikeys
```

Then declare the catalogue in that account:

```bash
bun run stripe:setup -- --dry-run    # report what would change
bun run stripe:setup                 # create it, idempotently
```

The service starts nothing, so it has three jobs instead, and each is a refusal or a
report rather than a container:

| | |
|---|---|
| **No key** | Refuses, naming `sk_test_`, where to get one, and the offline alternative |
| **A live-mode key** | Refuses. `sk_live_` from a local run means a checkout click creates a real invoice |
| **A restricted or unrecognised key** | Refuses, each for its own stated reason |
| **A key that does not authenticate** | Refuses, having asked Stripe first — so it fails at startup rather than at the checkout button |
| **A self-hosted emulator** | Allowed, with `STRIPE_MOCK_LIMITS` printed, because it still exists |

### Why test mode and not a local mock

A stateless mock cannot exercise the two things billing consists of: an object you
created being there on the next request, and a webhook arriving because something
happened. `stripe-mock` was honest about that — its limits were printed everywhere it
was offered — and it was still the wrong default. Test mode costs a Stripe account
and a network round trip, and returns real API-version fidelity instead.

For genuinely offline work, run a `stripe-mock` container yourself and point
`STRIPE_API_BASE` at it. `bun run stripe:setup` refuses against any local target
(exit `4`), because "created 5 objects" against a stateless emulator would be true of
the API calls and false of the account.

### Webhook delivery

Webhooks come from the Stripe CLI, which subscribes to your test account directly —
there is no endpoint to register in the dashboard:

```bash
stripe login                                                       # once
stripe listen --forward-to http://127.0.0.1:5273/api/webhooks/stripe
stripe trigger payment_intent.succeeded                            # in another terminal
```

`listen` prints a signing secret (`whsec_…`) on start. Put it in
`STRIPE_WEBHOOK_SECRET` in `.env.local` and restart the run. **Until you do,
deliveries are refused** — the endpoint verifies every signature and rejects an
unverifiable one, by design.

The CLI is a Go binary from a package manager, not a workspace dependency, so it is
**detected, not assumed**, and its absence is one of three distinct answers:

| State | What the banner says |
|---|---|
| Installed and authenticated | The exact `stripe listen` command, and where its secret goes |
| Installed, not authenticated | That `listen` would forward nothing, and to run `stripe login` |
| Absent | That webhook delivery was **not run**, and how to install it |

The middle case is the one that matters: `stripe version` succeeds without a login,
so a green probe is not evidence that anything will be delivered.

## Webhook verification

`packages/backend/billing/src/webhook.ts` decides whether a delivery is genuine,
and `/api/webhooks/stripe` is transport around it.

- **The signed bytes are the raw body.** `request.text()`, not a parsed and
  re-serialised object — key order and whitespace change, and the digest no longer
  matches.
- **An absent `STRIPE_WEBHOOK_SECRET` refuses the delivery.** The previous
  generation of this code logged a warning and parsed the body anyway, on the
  reasoning that it was acceptable in staging. It is not acceptable anywhere: an
  endpoint that grants a subscription on an unverified POST is an open one, and
  the deployments most likely to run it are the ones that are not staging.
- **A delivery outside the five-minute window is refused**, in both directions. A
  correctly signed request captured an hour ago proves only that Stripe signed it
  once.
- **Every `v1` in the header is checked**, not just the first. Stripe sends one per
  key during a rotation, and rejecting the older key disables real events for the
  length of the overlap window.
- **Comparison is constant-time**, because a byte-by-byte `===` leaks how many
  leading characters of a digest matched.
- **An event this application does not handle is answered 200.** It is a genuine
  delivery; answering 400 makes Stripe retry it and eventually disable the
  endpoint, taking the events it *does* handle down with it.

The route reports `handled: false` rather than implying a subscription was
updated. There is no subscription table in this template, and inventing one would
mean choosing a schema and an entitlement mapping a project will have opinions
about. `verified.event.id` is the correct idempotency key if you add it.

## The dev stack

`bun run dev` decides what to start from a name.

```bash
bun run dev                          # asks, on a terminal
bun run dev --stack client           # a database and the app — the historical behaviour
bun run dev --stack full             # app, database, Stripe, image, jobs Worker
bun run dev --stack supabase,stripe  # any combination, by service name
bun run dev app --stack jobs         # with an explicit mode word
```

| Stack | Services | |
|---|---|---|
| `client` | `supabase` | the default; a database and the app |
| `supabase` | `supabase` | a database only |
| `stripe` | `supabase`, `stripe` | adds your Stripe test account; refuses without a key |
| `container` | `supabase`, `container` | adds the finite runner image |
| `jobs` | `supabase`, `container`, `jobs` | adds the jobs Worker in workerd |
| `full` | all four | everything |

Two rules make it safe rather than merely convenient.

**A stack always brings up what the application needs.** `--stack stripe` still
starts the database, because the app's own `requires` in the service registry says
so. A checkout page that 503s on save because nobody named the database is the
failure this prevents.

**A non-interactive run with no stack is refused**, with the command to run.
`bun run dev` used to mean exactly one thing; with four services it does not, and
a stack that silently picked "everything" would start a container build on a
laptop that was only trying to look at a page. The refusal is exit `2`.

The prompt accepts a number or a name and, like `--stack`, answers with a
combination: `2`, `supabase,stripe` and `1,stripe` all work. The point of that is
that the answer you give at the prompt is the syntax you can paste into a script.

## How long a start takes, and what makes the second one fast

```bash
bun run dev          # ~32s cold, ~1s warm
bun run dev --fresh  # discard the data first, then start over with the mock seed
bun run db:stop      # stop the development database, keeping its data
```

The local development database is **one per checkout, not one per process**. Its
project id, ports and owner token are derived from the checkout path, so a second
`bun run dev` finds the first one's stack and adopts it instead of booting eight
containers again. `scripts/src/db/supabase_local.ts` derives them;
`probeRunningSupabase` decides whether adopting is safe.

Three rules make it safe rather than merely fast.

**Nothing is adopted unless it is provably this checkout's own.** Adoption needs
the 0600 ownership file this checkout wrote, `supabase status` reporting that same
project id, and the API actually answering. Every one of those can say no — a
leftover file beside stopped containers, a stack from another project, containers
still booting — and every "no" means a full start, which is always available.

**Only `bun run dev` shares.** E2E, `test:worker`, `test:database` and `db:types`
each allocate a unique run id and are untouched; a shared database would let one
run's rows into another's assertions. `DEV_SHARED_STACK_RUN_ID` documents the blast
radius rather than becoming the allocator's default, because a default is what a
caller would inherit by forgetting an argument.

**A reused database outlives the run, and that is stated every time.** Ctrl-C stops
the app, not the database — that is what makes the next run fast. It is one stack
per checkout rather than one per run, always named in the banner, and stopped by
exactly one command:

```bash
bun run db:stop   # refuses, rather than reporting success, when there is nothing to stop
```

A *failed* start is still torn down. Leaving a healthy database behind is the
feature; leaving a half-started one holding ports is the bug.

### Stopping keeps the data, and discarding it is a separate word

`bun run db:stop` takes the containers down and leaves the Postgres volume. Those
are different resources, and somebody stopping a database wants the ports and the
memory back — not their local rows deleted, silently, by a command whose name says
"stop". So the next `bun run dev` starts the stack against the same volume, and a
developer who stopped the database last night has this morning's data.

That is why the next boot is seconds rather than the half-minute an empty stack
takes, so it is worth saying that this is a volume rather than a file: the data
survives a reboot, a `docker system prune` would remove it, and nothing in
`.wrangler` is involved. Whether it is there is decided by asking the engine
(`preservedSupabaseVolumes`), not by a marker file recording what a previous run
intended — and the banner names it, because yesterday's rows on the first screen
otherwise read as a bug:

```
Local Supabase (started by this run) -> http://127.0.0.1:55609
Restored the data from the volume kept by the last run.
  Start over instead: bun run dev --fresh
```

Discarding is the explicit half:

```bash
bun run dev --fresh   # stop this checkout's database, remove its volumes, re-migrate, re-seed
```

Three things have to be true for that word to mean what it says, and all three are
in `prepareSupabaseService` rather than in the command: it never adopts a running
stack (it stops it first, without keeping anything), it removes the volumes a
previous `db:stop` left (`supabase start` would otherwise reattach them), and it
still seeds — a fresh database with no seeded account is not a fresh database, it
is a login form.

**Only `db:stop` keeps data, and it has to ask.** Every lane tears down through the
same `stopSupabaseLocal` under a unique project id per run, so a `preserveData`
default of `true` would leave one set of volumes per E2E run on the machine,
forever. The default is therefore destructive and `db:stop` opts in by name.
`scripts/tests/dev_supabase_persistence.test.ts` asserts both halves, against an
injected container engine.

### Services start together

Supabase, the Stripe target check, the runner image and the jobs Worker have no
ordering dependency on each other, so they start concurrently and the stack takes as
long as its slowest service rather than the sum. Two things had to hold for that:

- **The declared order is not an execution order and never becomes one.** The
  returned list stays in declared order, because `describeStack` prints the banner
  in it and `disposeServices` tears down in reverse of it. Reverse-of-completion
  would stop the jobs Worker before the image it dispatches to.
- **A service's steps are labelled with its own name.** With several live at once,
  "the innermost running step" is ambiguous, so each service gets its own progress
  scope — `scripts/src/shared/progress.ts` — and a step nests only inside its own.

## What a run says while it starts

A stack takes from seconds to minutes: `supabase start` pulls images and boots
eight containers, and `--stack container` runs cargo inside a Docker build. Before
this existed the terminal said **nothing** for that whole stretch, and a silent
terminal is indistinguishable from a hung one — so the run gets killed by the only
thing that was slow.

```
Local stack: supabase
  ✓ supabase -> starting the local containers 31s
  ✓ supabase -> replaying migrations 0s
  ✓ supabase -> seeding the demo account 1s — 2 notes
  ✓ supabase 32s
Dev server (Node) -> http://127.0.0.1:5273
```

| | |
|---|---|
| `scripts/src/shared/progress.ts` | the reporter: one step at a time, with an elapsed time and an outcome |
| `scripts/src/local/service.ts` | `LocalServiceContext.progress` — a service cannot start a slow thing silently |
| `scripts/src/dev-stack.ts` | starts services concurrently, tears down in reverse declared order |
| `scripts/src/db/supabase_local.ts` | the per-checkout database, the adoption probe, and `db:stop` |
| `scripts/tests/dev_supabase_reuse.test.ts` | when a running database is adopted, and when it is refused |
| `scripts/src/db/supabase_local.ts` | the four long steps of an owned stack |
| `scripts/tests/progress.test.ts` | what the terminal shows, asserted without sleeping |

Two rules, both deliberate.

**A terminal and a pipe both get words; only a terminal gets motion.** The
spinner is a terminal affordance. A pipe — CI, `| tee`, a bug report — gets one
line per step, because a job that hangs with nothing in its log is the same defect
in a different place.

**The reporter owns one line and gives it up when it must.** Other modules print
while steps run: the Supabase CLI's captured output arrives as one block, the dev
server's stream arrives as chunks. A foreign write erases the live line, lands,
and the line is redrawn under it. That write-through is the only global side
effect in the tooling workspace; it exists only while a step is live, and the redraw
timer is unreferenced so it can never be why a command fails to exit.

## Services, and what they will not do

Each is one implementation of a single lifecycle (`scripts/src/local/service.ts`):
allocate, start, contribute bindings, tear down in reverse. A service cannot invent
its own ownership story, and two services writing the same binding is a refusal
naming both, not a last-writer-wins merge.

### `supabase`

Local Supabase, owned per checkout. Unchanged behaviour; `prepareDevBackend` is
now a thin wrapper over `scripts/src/local/supabase_service.ts` so the
allocate/start/seed sequence has one implementation behind both entry points.

### `stripe`

Nothing is started. The service resolves your test target from `.env`, `.env.local`
and the run-owned vars file, refuses a live-mode key, proves the key authenticates,
and reports what the Stripe CLI would do about webhooks. Two refusals are the whole
of it — no key, and a key that does not work — and each names its remedy. There is
no port, no image and no readiness wait, because there is nothing local to wait for.

### `container`

The finite runner image, built from current sources. It starts nothing, and says
so: `apps/backend/media` is not a server, and modelling it as a listener would mean
inventing a port and a health endpoint it does not have so a developer could see
something green that never runs a container.

Development builds can reuse a current image when its content-addressed stamp
matches the source inputs and the image identity. Otherwise they build with layer
caching and read the passing Rust test count recorded in the image at
`MEDIA_RUST_TESTS_PATH`; build-log parsing is only a fallback. A build with no
positive count is refused. `Dockerfile.job` does not use BuildKit cache mounts.

`bun run test:compute` always builds with `--no-cache`, runs the Rust tests, and
drives a real FFmpeg encode through the image. The development path prepares the
image without running that integration scenario. Both use `buildMediaImage` for
the tag, Dockerfile, context, recorded count and stamp validation.

### `jobs`

The jobs Worker in real workerd, which is the only place Workflows exists.

It chooses its profile from what the host can run, and says which:

- `JOBS_PROFILE=encode` makes the Worker call the Cloud Run Jobs API with a Google
  OAuth token. **There is no local emulator for that**, and one that answered `200`
  would be a lie with a port on it: the request would be shaped correctly and
  nothing would ever encode.
- So when the Google bindings are absent the Worker runs `disabled` and the banner
  names what is missing. What *is* real — workerd, Workflows bindings, the R2
  binding, env resolution — is still exercised, and readiness is asserted against
  the endpoint's documented answer: 404 with `cache-control: no-store`.

To exercise the runner itself: `bun run test:compute`, or `--stack container` to
build the image it will dispatch to.

## The full black-box lane

```bash
bun run e2e:full          # the owned runtime, two spec files, real everything it can be
```

`bun run e2e` proves the pages and the API work. `bun run e2e:full` proves the
*system* does, and it is the only lane that puts the built Workers, a real
database, real Workflows, real R2 and a real FFmpeg container in one process and
then observes them only from outside.

| | |
|---|---|
| Runtime | `apps/e2e/src/full/runtime_host.ts` |
| Hosted Google | `google_fixture.ts` — Cloud Run Jobs, OAuth, IAP |
| Stripe | `stripe_fixture.ts` — seeded from `@starter/billing`, keeps state |
| Specs | `tests/full/encode.spec.ts`, `tests/full/billing.spec.ts` |

Two fixtures answer for services that have no local equivalent. Everything else is
real: Supabase is a real local stack, the Workers are the built artifacts under
Miniflare, R2 is a real bucket, Workflows are real bindings, and the encode runs a
real FFmpeg inside the real container image.

### Why the Stripe fixture is not stripe-mock

`stripe-mock` holds no state and returns generated fixtures, so a lookup key
resolves to whatever the generator produced — and an assertion about *what the
application asked for* would then be an assertion about the emulator. This fixture
is seeded from `@starter/billing`, keeps what it was told, and writes each checkout
to run-scoped evidence (`<run>/artifacts/stripe/checkouts.jsonl`) that the specs
read.

That is what makes the central assertion falsifiable:

> the account was asked for a **lookup key**, it resolved to the **catalogue's
> amount**, and the request carried **no number of its own**

If the application had taken an amount from the caller, the recorded amount would
be the application's own — and a test that asked the application what amount it
chose would agree with itself. Asking the account what it was told is the only
version of the question that can fail.

### What it covers

**Checkout** — a signed-in owner opens a session and the price is the catalogue's;
an unknown plan is refused; a plan that exists but cannot be bought is refused by
name; **an `amount` in the body is a 400, not an ignored field**; an anonymous
caller is refused; a credit pack resolves the same way; the redirect is built from
the deployment's own origin.

**Webhook verification** — unsigned, wrongly signed, and correctly-signed-over-
different-bytes deliveries are all refused; a genuine one is accepted; a replayed
one outside the five-minute window is refused; an event the application does not
handle is **acknowledged 200 rather than 400**, because a genuine delivery answered
badly makes Stripe retry until it disables the endpoint.

### What it does not prove

Stated here so nobody discovers it the expensive way.

- **Stripe is a fixture.** It implements the endpoints this application calls and
  no others: no tax, proration, trials, invoices, refunds or dunning. A test that
  needs those must say so rather than infer support from a checkout URL appearing.
- **No subscription is written.** The webhook is verified and routed; the route
  answers `handled: false` because this template has no subscription table.
- **The customer id is derived**, `cus_<account id>`. Real deployments resolve it
  from a customers table.
- **Google IAM is fixture-owned.** The jobs path is exercised; Cloud IAM is not.
- **This lane owns its own Stripe fixture**, including the webhook signer. That is
  exactly the thing a real deployment does not have and must therefore configure
  with a real endpoint secret, which is why `--stack stripe` refuses to run the
  E2E lane's fixture and demands a real key instead.

## What this does not do

Stated so nobody discovers it the expensive way.

- **No local Cloud Run.** Encode dispatch reaches a real Google project or it does
  not happen.
- **No subscription persistence.** The webhook is verified and routed; nothing is
  written, and the response says `handled: false`.
- **A self-hosted stripe-mock is not pinned to a digest.** The stack no longer runs
  one, but a developer can, with `STRIPE_MOCK_IMAGE` overriding the tag.

## Where things are

| | |
|---|---|
| `packages/shared/billing` | the catalogue: plans, packs, currency, events, resolvers |
| `packages/backend/billing` | checkout, portal, webhook verification |
| `scripts/src/local/service.ts` | the one lifecycle every local service implements |
| `scripts/src/shared/progress.ts` | what a run says while a service starts |
| `scripts/src/local/stripe_service.ts` | the test-mode target check, the live-key refusal, the webhook-bridge status |
| `scripts/src/local/container_service.ts` | the finite runner image |
| `scripts/src/local/jobs_service.ts` | the jobs Worker in workerd |
| `scripts/src/local/media_image.ts` | the image's tag, Dockerfile, build and Rust-test assertion |
| `scripts/src/dev-stack.ts` | named stacks, combinations, and the prompt's data |
| `scripts/src/registry/service_registry.ts` | what each app *is*, and what it requires locally |
| `scripts/src/setup/stripe_catalog.ts` | the idempotent declaration |
| `apps/frontend/client/src/routes/api/webhooks/stripe/+server.ts` | the route |