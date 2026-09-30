# @starter/schemas

Portable TypeBox schemas and the project app registry.

- **No runtime dependencies** on other projects — safe in browser, Worker and CLI.
- Import the subpath you need (`@starter/schemas/notes`) rather than the barrel.
- `LogEventSchema` is the single structured log shape for every plane.
- `app_registry.ts` is the only place app -> worker / bucket / adapter mappings
  live. Deployment tooling, `bun run logs` and the Pi log tool all read it.
