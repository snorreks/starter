# @starter/billing

## Purpose

The single source of truth for what this project sells: the subscription plans,
the one-time credit packs, the currency they are charged in, and the Stripe
webhook events the application acts on.

It exists as a package rather than as a module beside the Stripe handlers
because two planes must read it and `MAY_REACH` in `scripts/src/guards/policy.ts`
forbids `node -> worker`. The Worker needs it to validate what a caller is asking
to buy; `bun run stripe:setup` needs it to decide what to create in Stripe. A
pricing table that both a browser bundle and a Node CLI can load is exactly what
the `portable` plane is for, and this file imports nothing so it is identical in
all three runtimes.

Prices appear nowhere else. The catalogue is read; a literal amount, currency or
plan id written at a call site is the defect this package exists to prevent.

## Setup and commands

No setup or configuration. From this directory: `bun run typecheck`,
`bun run lint`, `bun run format`.

To push the catalogue into a Stripe account, from the repository root:

```bash
bun run stripe:setup -- --dry-run          # report what would be created
bun run stripe:setup -- --env staging --yes
```

Against the local emulator (`bun run dev --stack stripe`) the objects are created
in `stripe-mock` and the command says so; nothing is provisioned remotely.

## Validation

`bun run test` runs this package's unit tests. They assert the properties that
would otherwise be unwritten conventions: that no two prices share a Stripe
lookup key, that a purchasable plan has a positive price on every interval it is
sold on, that a free plan is granted rather than bought, and that every refusal
names both the cause and the remedy.

`bun run guard` checks the package boundaries and this README.

## Boundaries

Portable, and that means more than "no dependencies". The module must load in a
browser, in workerd and under Bun, so it may not import `node:*`, a database
client, a Stripe SDK, or anything from `apps/` or `scripts/`.

It holds no I/O and no credentials. Where the corresponding Stripe objects live
is a question for the deployment configuration; this package answers only what
should exist, never where or whether it was created.