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

## The development server

```bash
bun run dev                 # prompts for a stack on a TTY
bun run dev --stack client  # local seeded Supabase and the Vite client
bun run dev:worker          # serves the built Worker in workerd; requires a build
```

Without an explicit stack, `bun run dev` prompts on a TTY and exits with
`EXIT.usage` (2) without a TTY or when `CI=true`.

`bun run dev --stack client` provisions a checkout-owned local Supabase stack when
`SUPABASE_URL` is unset, seeds one synthetic account into it
(`seed@example.invalid`, two notes), and writes that account into the run-owned
Worker vars file so the first page load is already signed in. Stopping the server
stops the stack and removes the file.

Three properties keep that from reaching anything real:

- **The bindings are written only for a stack the launcher started.** `SUPABASE_URL` set by the developer — and the E2E lane's own vars file — mean nothing is provisioned, seeded or signed in.
- **The application refuses the bindings** unless `SUPABASE_URL` is plain http on loopback and the deployment was already classified local. That check is in `apps/frontend/client/src/lib/server/dev_auto_login.ts` and is what a deployment would depend on.
- **A harness runtime does not get the offer.** A run carrying `E2E_RUN_ID` — the visual and browser lanes — seeds its stack and omits the sign-in bindings, so those lanes keep observing signed-out pages.

Signing out is recorded in an `httpOnly` marker cookie, so signing out during local development means signed out; `/login` then offers the seeded account again as a one-button form. A seed failure fails the command: a dev server against an empty database, saying nothing, is the outcome this refuses.

`bun run db:seed` is a separate, explicit operation against a stack started by other means. It reads `supabase/config.toml` at the repository root, which is a different project from the one a `bun run dev` run owns — that is why it answers `Local Supabase status failed with exit 1` while a dev server is up.

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

## Local commit checks and CI feedback

`bun run setup` installs `.moon/hooks/pre-commit` by setting a worktree-specific
`core.hooksPath=.moon/hooks`. Git resolves that relative path in the active checkout,
so each Herdr linked worktree executes its own revision's hook. Existing worktrees
keep their hook settings until they run setup; the worktree bootstrap command does
that for fresh checkouts. Moon's automatic hook sync stays disabled; setup owns each
worktree's Git setting and preserves the committed hook.

The hook checks staged source blobs with the pinned Biome binary in memory, rejects
plaintext environment files and malformed `secrets/*.enc.env` files from the index,
runs the uncached whole-repository guards, and typechecks affected Moon projects.
Changes to root or shared workspace configuration run all typechecks. It never
rewrites or re-stages files, so partially staged hunks stay as staged. Typechecking
uses the active working tree because Moon cannot typecheck a temporary index snapshot;
CI remains the authority on the exact committed tree. A missing tool or failed check
blocks the commit with its command and remedy.

The `CI Feedback` workflow runs after `CI` completes. It checks the reported commit
against the open PR head, confirms the run is still current, and updates one
bot-owned comment with failed jobs, links, local commands, and a copyable fix prompt.
A passing run updates an existing failure comment and does not create a new one.
The reporter checks GitHub job results directly; it does not download PR artifacts
or run pull-request code with a write token. Its job is informational and cannot
change the required `CI` gate. Forks get the same comment through the separate,
least-privilege workflow.
