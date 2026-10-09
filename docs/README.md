# Documentation

Start here. Nothing below is required reading before running a command — the
[command guide](../AGENTS.md) is.

## Reading order

| If you want to… | Read |
|---|---|
| configure GitHub branches, protections and automation | [github.md](github.md) |
| run something | [../AGENTS.md](../AGENTS.md) |
| know what is actually verified | [capability-matrix.md](capability-matrix.md) |
| write or run tests, or understand local commit checks and CI feedback | [testing.md](testing.md) |
| run local Supabase or review its SQL/RLS boundary | [supabase-local.md](supabase-local.md) |
| review the Supabase web identity and request services | [supabase-web-backend.md](supabase-web-backend.md) |
| configure and verify optional Cloud Run compute | [supabase-cloud-run-compute.md](supabase-cloud-run-compute.md) |
| bootstrap a Herdr checkout and scope local settings | [worktrees.md](worktrees.md) |
| understand a past decision | [first-round-review.md](first-round-review.md) |
| review the current DX/security repairs and remaining limits | [optimization-review.md](optimization-review.md) |
| change the architecture | [architecture.md](architecture.md) |
| deploy it | [deployment.md](deployment.md) |
| run a real encode, or decide whether to leave Cloudflare | [compute.md](compute.md) |
| change accounts, sessions or mail | [auth.md](auth.md) |
| build or understand the desktop client | [native.md](native.md) |

## Guides

- [testing.md](testing.md) — the unit, browser, Worker, E2E, database and compute lanes, why they are separate, and how each is
  verified
- [worktrees.md](worktrees.md) — the shared terminal/agent bootstrap, environment sources, and per-run ownership
- [supabase-local.md](supabase-local.md) — local project allocation, migrations, generated types, repositories and policies
- [the database package](../packages/backend/database/README.md) — Supabase migrations, RLS, generated types and local integration
- [auth.md](auth.md) — the account lifecycle, the rate limiter, and mail
- [cloudflare.md](cloudflare.md) — Workers, R2, credentials, and the Worker's
  deployment-mode binding
- [deployment.md](deployment.md) — the one configuration and deployment path: the
  resolved target, the CI variable model, provisioning, secret installation, the
  ordered pipeline, migrations, concurrency, health, rollback and image retention
- [compute.md](compute.md) — the optional Cloud Run compute example, its local verification, and hosted limits
- [logs.md](logs.md) — the `bun run logs` family and what each refusal means
- [secrets.md](secrets.md) — SOPS: the operations, and what each one refuses
- [lint.md](lint.md) — Biome, the whole-repository guards, and what each refuses
- [toolchain.md](toolchain.md) — which versions are pinned, and where, including
  the Rust policy every first-party crate shares
- [../apps/backend/media/README.md](../apps/backend/media/README.md) — the bounded
  FFmpeg processor: protocol, preset, limits, measured image, and its container
  and CLI entrypoints
- [native.md](native.md) — the desktop client: device sign-in, the vault, the
  capability set, and what a release would still need
- [rename-checklist.md](rename-checklist.md) — before your first release
- [adding-a-feature.md](adding-a-feature.md) — the shape of a change here
- [agent.md](agent.md) — Pi extensions, project trust, and the discovery rules

## Reference

- [evidence/current.json](evidence/current.json) — the machine-readable record every
  count in [capability-matrix.md](capability-matrix.md) is derived from. Checked by
  `bun run evidence`; `bun run evidence --write` regenerates the matrix's current
  table from it
- [guides/sveltekit-3-subpaths.md](guides/sveltekit-3-subpaths.md) — why `#lib` and
  the workspace packages are aliased where they are
- [contracts/README.md](contracts/README.md) — the written-brief workflow, and why
  nothing executes a brief automatically

## Conventions in these documents

- **Counts and results are derived, not asserted.** A number here should be one you
  got from running the command, and the current matrix is generated from
  `docs/evidence/current.json` rather than typed. Hand-editing a count makes
  `bun run evidence` fail.
- **"Not implemented" is stated as such**, with the exit code and what to run
  instead. A command that prints advice and exits 0 is a bug, and the docs say so
  where it happens.
- **"Verified" means verified.** If a check ran against a fake boundary, the table
  says which boundary.
- **Comments and docs do not disagree.** If you find one, that is a defect worth
  reporting, not a documentation nit.
