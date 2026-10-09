# @starter/fixtures

## Purpose

This package provides portable synthetic fixtures for local development. The mock
user and sample note records are the shared source used by the emulator identity
and synthetic local Supabase seed. They run in both the browser and Worker runtimes, with no runtime
dependencies.

## Setup and commands

No setup or configuration is required. From this directory, run `bun run typecheck`,
`bun run lint`, or `bun run format`.

## Validation

`bun run test` runs the repository's Bun unit lane, which exercises the applications
that consume these fixtures. The lane must discover and pass a nonzero set of tests;
the command's output reports the number of tests and files. `bun run guard` checks
the package boundaries and this README alongside those tests.

## Boundaries

This package has no dependencies and contains no runtime or database code. Consumers
decide how to present or persist these records.
