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

## Guides

- [testing.md](testing.md) — the four lanes, why they are separate, and how each is
  verified
- [cloudflare.md](cloudflare.md) — Workers, D1, deployment, credentials, and the
  Worker's deployment-mode binding
- [native.md](native.md) — Tauri desktop and mobile, build modes, signing
  prerequisites
- [logs.md](logs.md) — the `bun run logs` family and what each refusal means
- [secrets.md](secrets.md) — SOPS, and which commands are not implemented yet
- [lint.md](lint.md) — Biome, the whole-repository guards, and what each refuses
- [toolchain.md](toolchain.md) — which versions are pinned, and where
- [rename-checklist.md](rename-checklist.md) — before your first release
- [adding-a-feature.md](adding-a-feature.md) — the shape of a change here
- [agent.md](agent.md) — Pi extensions, project trust, and the discovery rules

## Reference

- [guides/sveltekit-3-subpaths.md](guides/sveltekit-3-subpaths.md) — why `#lib` and
  the workspace packages are aliased where they are
- [contracts/TEMPLATE.md](contracts/TEMPLATE.md) — full-mode contract
- [contracts/THIN_TEMPLATE.md](contracts/THIN_TEMPLATE.md) — standard-mode contract

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