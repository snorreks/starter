# @starter/billing-server

## Purpose

Stripe, from inside the Worker: Checkout and billing-portal session creation, and
verification of the webhooks that follow.

It exists as a package rather than as files inside the web application for the
same reason the jobs Worker is one: this code has to be reviewable and testable
without dragging SvelteKit in with it, and the billing rules — what may be bought,
what a delivery must prove, how long a signature stays valid — should not change
because a route file was edited.

Two decisions are load-bearing. Prices are resolved from `@starter/billing`, so no
amount ever arrives from a caller; and an absent `STRIPE_WEBHOOK_SECRET` refuses
the delivery rather than parsing the body anyway, because an endpoint that grants
a subscription on an unverified POST is an open one in every environment.

No Stripe SDK. The API surface used here is six endpoints and one HMAC, WebCrypto
is available in every runtime this package runs in, and an SDK would add a
dependency whose pinned version would then have to be kept in step with the one
`bun run stripe:setup` uses.

## Setup and commands

From this directory: `bun run typecheck`, `bun run lint`, `bun run format`,
`bun run test`.

The Worker needs two bindings, both supplied as secrets and never as vars:

```
STRIPE_SECRET_KEY      sk_test_…            # the account's key
STRIPE_WEBHOOK_SECRET  whsec_…              # the endpoint's signing secret
STRIPE_API_BASE        https://api.stripe.com
```

Locally, `bun run dev --stack stripe` writes all three into the run-owned 0600
vars file, pointing at stripe-mock.

To declare the catalogue in an account:

```bash
bun run stripe:setup -- --dry-run     # report what would change
bun run stripe:setup -- --yes
```

## Validation

`bun run test` covers the two things that are hard to get right. The verification
tests sign their own fixtures with the HMAC Stripe uses, so they state the
algorithm rather than comparing a constant with itself, and they cover the ways an
endpoint is fooled: a body signed with another secret, a genuine signature over a
modified body, an absent header, a rotated key set, and a replayed delivery both
from the past and from the future. The checkout tests assert that no request
carries an amount and that an unpurchasable plan never reaches Stripe at all.

## Boundaries

Worker-plane: this code runs inside a request lifecycle and reaches Stripe over
HTTPS. It may import `@starter/billing` and portable packages, and nothing else —
no browser code, no SvelteKit, and no tooling.

It holds no credentials and resolves none from the environment on its own; every
credential is a parameter. The client is passed in rather than cached at module
scope, because a Worker isolate serves many concurrent requests and a cached
client would pin the first request's credentials for all of them.

It performs no writes. Verification decides whether a delivery is genuine;
applying it — recording a subscription, crediting a balance — belongs to the
route, which is the only place that knows the database and the idempotency key.