# Testing

Commands must prove real work. A missing prerequisite is a named nonzero refusal; no cached result certifies a server, database or browser that did not start.

## Application lanes

```bash
bun run test                 # credential free unit tests, all projects
bun run test:browser         # real Svelte in Chromium
bun run test:worker          # built Worker in workerd against local Supabase
bun run e2e                  # built app and Worker in a real browser, one origin
bun run test:all              # the four lanes above once each
bun run test:database        # local Postgres, Auth, Data API/RLS and concurrent RPCs
bun run test:compute         # Docker runner image and real FFmpeg
```

`test:all` deliberately excludes database and compute integration lanes; it contains unit, browser, Worker and E2E once each. `test:database` and `test:compute` require Docker or Podman. Worker/E2E require Node, Chromium and free checkout-owned ports. The Supabase harness allocates a unique local project and refuses to stop another run's stack.

## Native

```bash
bun run --cwd apps/frontend/native test
bun run native:doctor
bun run native:build
```

Native auth/vault unit and bundle checks run without a device. Desktop builds require the pinned Rust toolchain and WebKitGTK on Linux. Android/iOS require their platform SDK/toolchain; physical-device deep links and Stronghold remain NOT RUN unless exercised.

## Checks and generated evidence

```bash
bun run typecheck
bun run lint
bun run format
bun run guard:whole-repo
bun run workflows
bun run build
bun run check:bundle
bun run db:types:check
bun run smoke
bun run smoke -- --without-heavy
bun run evidence
```

Fresh-template smoke starts from copied source with no credentials. The web-only variant removes native and compute application examples and reruns task discovery and required checks. `docs/evidence/current.json` records command, revision, timestamp, discovered count and artifact; the capability table is derived from it. Previous evidence stays dated. Hosted Supabase, Resend, Cloud Run and physical-device observations remain NOT RUN without their actual prerequisites.
