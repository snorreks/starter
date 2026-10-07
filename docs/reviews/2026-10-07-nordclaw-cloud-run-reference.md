# Nordclaw Cloud Run references for migration PRs 06 and 07

Read-only source review on 2026-10-07. Nordclaw revision: `86b2f53d2ad8af7cb183ca8c010a624562c52471`; the five requested files had no reported working-tree modifications. No Nordclaw build, lint, test, provisioning, or deployment command was run. These are implementation references, not evidence that the corresponding cloud operations succeeded.

## Reference map

| Reference | Useful patterns | Required adaptation |
|---|---|---|
| [edge-proxy/Dockerfile](/home/sonny/Development/Projects/passion/nordclaw/apps/backend/edge-proxy/Dockerfile) | Multi-stage Rust build, dependency caching, release stripping, small runtime stage | Preserve Starter's pinned Rust/toolchain/base-image policy, `--locked`, real-binary self-check, non-root runtime, FFmpeg/ffprobe/shared libraries and CA certificates. Do not copy ONNX models/base image or Rust 1.88. |
| [edge-proxy/moon.yml](/home/sonny/Development/Projects/passion/nordclaw/apps/backend/edge-proxy/moon.yml) | Named build/test/clippy tasks; separate live integration tasks; supply-chain/coverage task ideas | Preserve Starter's `cargo-*` lane names and toolchain/config/fixture inputs. Add `--locked` where supported and clippy `--all-targets -- -D warnings`. Do not fold Rust/Docker prerequisites into credential-free web selectors. |
| [deploy/cloud_run.ts](/home/sonny/Development/Projects/passion/nordclaw/scripts/src/lib/deploy/cloud_run.ts) | Artifact Registry build/push/deploy sequence; project/region naming; secret-reference/environment-key collision handling | Implement Cloud Run **Jobs**, not service deployment. Use one resolved target, argv arrays, bounded subprocesses, immutable image digests, complete provenance and explicit phases. |
| [setup/service_accounts.ts](/home/sonny/Development/Projects/passion/nordclaw/scripts/src/lib/setup/service_accounts.ts) | Describe-before-create idempotency, explicit project-scoped service accounts | Separate runner and dispatcher identities/permissions. Distinguish not-found from permission/network failure; dry-run means planned, not fixed. Failed creation must propagate nonzero. |
| [setup/gcp_apis.ts](/home/sonny/Development/Projects/passion/nordclaw/scripts/src/lib/setup/gcp_apis.ts) | Discover enabled APIs, batch enablement, per-API reporting | Select APIs from the actual compute target. Failed discovery is an error, not an empty enabled set. Use bounded readiness checks instead of assuming a fixed delay proves propagation. |

## Starter remains the baseline

[Starter's media Dockerfile](../../apps/backend/media/Dockerfile) already has digest-pinned images, locked Cargo dependencies, an offline real-source build, a binary version self-check, the FFmpeg runtime and an unprivileged user. Preserve those properties in the job image. The new runner must terminate with the actual encode outcome; a listener answering on port 8080 is not job success.

[Starter's media Moon configuration](../../apps/backend/media/moon.yml) already separates Cargo/image lanes from web tasks. Improve its own input/locking completeness when adapting it; do not copy Nordclaw task names or its toolchain choices wholesale.

Required Rust validation for the affected crate:

```bash
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --release --locked
```

Run in `apps/backend/media`; tests require their named FFmpeg/process prerequisites. Keep task inputs covering source, tests, fixtures, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, applicable formatter/linter config, runner code and Dockerfiles. Validate the final container with actual encoding, nonzero induced failure, signal/deadline behavior, and binary revision/protocol checks.

`cargo-deny`, mutation testing, and coverage are useful independent options, not new default migration requirements. Add them only with pinned installation, an owned command/doctor boundary, and real output; do not expand this eight-PR train merely to reproduce every Nordclaw task.

## Patterns to avoid carrying over

- Nordclaw's Dockerfile uses mutable base tags and `cargo build --release` without `--locked`. Starter's existing controls are stronger here.
- The deploy path skips builds when a build/dist directory exists. Existence is not proof of revision, input, target, or mode agreement. Require matching artifact metadata and immutable image identity.
- `cloud_run.ts` builds shell command strings, invokes `bunx moon`, interpolates environment values and uses `latest` cache/base references. Adapt ideas to Starter's pinned tools, argv construction, secret handling and bounded process runner. An optional cache-fetch failure may be recoverable; the actual build/push/deploy failure may not.
- The referenced deploy utility uses `execSync` without an explicit timeout, and its service argument builder includes `--allow-unauthenticated`. Do not inherit those choices. Cloud Run Jobs has a different execution/IAM contract and no public service router in this plan.
- That utility's `run(..., {quiet:true})` returns error output instead of throwing on a failed process. Consequently, the base-image `docker pull` check can set `baseImageExists=true` even when the pull failed, bypassing its intended fallback. Quiet output must preserve exit status; add a real failed-pull fixture when implementing registry checks.
- `service_accounts.ts` maps all failed describes to missing; its standalone entry does not set a failing exit for creation errors. Both setup files mark dry-run planned actions as `fixed: true`, conflating intention with mutation.
- `gcp_apis.ts` maps failed API discovery to an empty set and enables a broad Firebase/Vertex/IAP/SQL/etc. catalogue. Derive the minimal API list: Cloud Run/Artifact Registry plus the service-management/IAM operations actually required. Enable Cloud Build, Secret Manager, Scheduler or other APIs only if the selected implementation uses them.
- The five files do not establish exact IAM grants, job permissions, credential lifecycle, or end-to-end success. PR 07 must verify its own runner/dispatcher/deployer permissions and failure propagation with fixtures and later live checks.

## How executors should use these files

PR 06 reads the Dockerfile/Moon references and this review before implementing the runner/image/Cargo changes. PR 07 reads the deploy/setup references before implementing Google provider adapters and provisioning boundaries. Inspect referenced helper implementations before adapting them; referenced function names are not proof of their behavior.

Nordclaw is an optional sibling source reference. Never import its modules into Starter or depend on its absolute path in builds/tests. If absent, this review and Starter's own code retain the required design decisions; do not fabricate having read unavailable files. Record the reference revision if revisiting an updated copy.
