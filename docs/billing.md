# Billing and the dev stack

Two things are documented here because they are one mechanism wearing two
faces: **what this project sells**, and **which local services a development run
starts**.

The link between them is a name. `@starter/billing` is the catalogue;
`bun run stripe:setup` declares it in a Stripe account; `bun run dev --stack
stripe` stands up a local emulator to develop against. If the catalogue and the
emulator disagree, every layer above them inherits the disagreement, so neither is
allowed a second copy of a price.

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
reason `EXIT.refused` is separate from `EXIT.failed`.

## Developing against Stripe

```bash
bun run dev --stack stripe
```

Starts local Supabase and a `stripe-mock` container, and writes `STRIPE_API_BASE`,
`STRIPE_SECRET_KEY` and the resolved target into the run-owned vars file.

### What stripe-mock does and does not do

Both facts are printed in the dev banner, from `STRIPE_MOCK_LIMITS`, because
discovering either of them by waiting is how an afternoon disappears:

- **It keeps no state.** Created products and prices exist for the call that
  created them. Ids it returns are synthetic.
- **It delivers no webhooks.** Not one.

### Webhook delivery

Getting an event from Stripe to a local process needs the Stripe CLI's
`stripe listen`, which is a Go binary distributed through a package manager and
not a workspace dependency. This repository pins what it can pin and does not
shell out to whatever a machine happens to have, so the bridge is **detected, not
assumed**, and its absence is one of three distinct answers:

| State | What the banner says |
|---|---|
| Installed and authenticated | How to run `stripe listen --forward-to …` |
| Installed, not authenticated | That `listen` would forward nothing, and to run `stripe login` |
| Absent | That webhook delivery was **not run**, and how to install it |

The middle case is the one that matters: `stripe version` succeeds without a
login, so a green probe is not evidence that anything will be delivered.

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
| `stripe` | `supabase`, `stripe` | adds stripe-mock |
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

`stripe-mock` in a container, bound to loopback on two allocated ports. Readiness
is verified before the run continues, and a service that never becomes ready is
removed rather than left holding its port. Teardown re-checks the port, because a
container that survived `rm --force` would otherwise present three commands later
as a bind error nobody can trace.

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
- **`stripe-mock` still delivers no webhooks**, and this lane does not change that.
  Here the fixture *does* deliver, because the lane owns the signer — which is
  exactly the thing a real deployment does not have and must therefore configure
  with a real endpoint secret.

## What this does not do

Stated so nobody discovers it the expensive way.

- **No local Cloud Run.** Encode dispatch reaches a real Google project or it does
  not happen.
- **No webhook delivery from stripe-mock.** See above.
- **No subscription persistence.** The webhook is verified and routed; nothing is
  written, and the response says `handled: false`.
- **`stripe-mock` is not pinned to a digest.** The tag is overridable through
  `STRIPE_MOCK_IMAGE` and the resolved image is printed in the banner, so a run's
  provenance is visible. Pin it before a release.

## Where things are

| | |
|---|---|
| `packages/shared/billing` | the catalogue: plans, packs, currency, events, resolvers |
| `packages/backend/billing` | checkout, portal, webhook verification |
| `scripts/src/local/service.ts` | the one lifecycle every local service implements |
| `scripts/src/local/stripe_service.ts` | stripe-mock, and the webhook-bridge status |
| `scripts/src/local/container_service.ts` | the finite runner image |
| `scripts/src/local/jobs_service.ts` | the jobs Worker in workerd |
| `scripts/src/local/media_image.ts` | the image's tag, Dockerfile, build and Rust-test assertion |
| `scripts/src/dev-stack.ts` | named stacks, combinations, and the prompt's data |
| `scripts/src/registry/service_registry.ts` | what each app *is*, and what it requires locally |
| `scripts/src/setup/stripe_catalog.ts` | the idempotent declaration |
| `apps/frontend/client/src/routes/api/webhooks/stripe/+server.ts` | the route |