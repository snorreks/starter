# Documentation

Start here. Nothing below is required reading before running a command — the
[command guide](../AGENTS.md) is.

## Reading order

| If you want to… | Read |
|---|---|
| run something | [../AGENTS.md](../AGENTS.md) |
| know what is actually verified | [capability-matrix.md](capability-matrix.md) |
| write or run tests | [testing.md](testing.md) |
| understand a past decision | [first-round-review.md](first-round-review.md) |
| change the architecture | [architecture.md](architecture.md) |
| deploy it | [deployment.md](deployment.md) |
| change accounts, sessions or mail | [auth.md](auth.md) |
| build or understand the desktop client | [native.md](native.md) |

## Guides

- [testing.md](testing.md) — the four lanes, why they are separate, and how each is
  verified
- [auth.md](auth.md) — the account lifecycle, the rate limiter, and mail
- [cloudflare.md](cloudflare.md) — Workers, D1, credentials, and the Worker's
  deployment-mode binding
- [deployment.md](deployment.md) — the one configuration and deployment path: the
  validated authority, the pipeline, migrations, concurrency, health, and the
  recovery procedure
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

- [guides/sveltekit-3-subpaths.md](guides/sveltekit-3-subpaths.md) — why `#lib` and
  the workspace packages are aliased where they are
- [contracts/README.md](contracts/README.md) — the written-brief workflow, and why
  nothing executes a brief automatically

## Conventions in these documents

- **Counts and results are derived, not asserted.** A number here should be one you
  got from running the command.
- **"Not implemented" is stated as such**, with the exit code and what to run
  instead. A command that prints advice and exits 0 is a bug, and the docs say so
  where it happens.
- **"Verified" means verified.** If a check ran against a fake boundary, the table
  says which boundary.
- **Comments and docs do not disagree.** If you find one, that is a defect worth
  reporting, not a documentation nit.