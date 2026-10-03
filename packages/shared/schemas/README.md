# @starter/schemas

Portable TypeBox schemas and the project app registry.

## Purpose and runtime

Portable, in the strict sense: this package's promise is that every module in it
loads unchanged in a browser, in workerd and under Bun. That is why it has **no
runtime dependencies on other projects** — not "few", none.

- Import the subpath you need (`@starter/schemas/notes`) rather than the barrel.
- `LogEventSchema` is the single structured log shape for every plane.
- `app_registry.ts` is the only place app -> worker / bucket / adapter mappings
  live. Deployment tooling, `bun run logs` and the Pi log tool all read it.

TypeBox is the TypeScript authority for wire shapes. A wire fixture is the
documented check that a non-TypeScript implementation agrees with it.

## Setup and configuration

None. Schemas are data; the registry is data. There is no environment variable and
no generated file.

## Commands

From `packages/shared/schemas`:

```bash
bun run test
bun run typecheck
bun run lint
```

The root `bun run test` fans out to this project's `test` task through Moon; this
is a dependency of nearly every other project, so it is built early.

## Tests and artifacts

`bun test`, with no `--pass-with-no-tests`: the package has tests, and what they
cover is the part that matters — that a schema **rejects** the payloads it is
supposed to reject. A validator that accepts everything is worse than no validator,
and only a negative assertion catches it.

Artifacts: none. The deliverable is the source.

## Boundaries and documentation

May import nothing. Not "nothing first-party" — nothing at all. This package sits
at the bottom of the dependency graph, and the guard reports an edge leaving it as
`plane-reachability` from `portable`, which may reach only `portable`.

Publishing a subpath is a decision, not a convenience: add the entry to this
package's `exports` map. A deep import that skips the map resolves today and
survives a file move it should not have survived, and `rulePackageExports`
refuses it.

- [docs/architecture.md](../../../docs/architecture.md) — the portable core
- [docs/adding-a-feature.md](../../../docs/adding-a-feature.md) — where a new DTO and its schema belong
- [docs/testing.md](../../../docs/testing.md) — why the assertions here are negative
