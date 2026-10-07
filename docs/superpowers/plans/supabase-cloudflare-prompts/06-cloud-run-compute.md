# Prompt 06 — Postgres workflows, Cloud Run Jobs and bounded maintenance

Implement only Prompt 06 from the migration plan; read its common contract, spec, and 02/03 handoffs. Create one Herdr worktree and one PR.

**Branch:** `feat/supabase-06-cloud-run-compute`. **Requires:** 03 merged. **Budget:** target 45–75 paths, maximum 99. **Parallel:** with 04 and 05; own jobs/media/backend jobs modules and internal runner grants.

**Implementation references:** Read [the Nordclaw Cloud Run reference review](../../../reviews/2026-10-07-nordclaw-cloud-run-reference.md), including the listed `edge-proxy/Dockerfile` and `moon.yml`. Use Starter's existing media Dockerfile/Moon configuration as the baseline. Nordclaw is reference-only, not a runtime/build dependency; its service/ONNX image is not the job/FFmpeg image this prompt builds.

## Files and scope

- Adapt `packages/backend/jobs/src/lib/{job_repository,maintenance,maintenance_run,dispatch_port}.ts` through 02's Postgres repository, preserving established state/fencing contracts.
- Adapt `apps/backend/jobs/src/{env,index,media_store,processor_client}.ts` and `workflows/{encode_workflow,maintenance_workflow}.ts` for the explicit Supabase/Cloud Run preview configuration; preserve legacy default until 08.
- Create `apps/backend/jobs/src/cloud_run/{dispatch,oauth,execution,runner_identity}.ts` and focused tests. Runtime Google credential values use Worker secrets, never CLI arguments or artifacts.
- Create `apps/backend/media/runner/` finite runner, declared/pinned dependencies, README/tests, and job Dockerfile. Invoke the existing Rust finite `encode` entrypoint; do not rewrite FFmpeg processing or its protocol.
- Create Worker-owned `apps/frontend/client/src/routes/api/internal/jobs/[id]/grants/+server.ts` and server grant service, explicit route auth policy, and tests. Extend Supabase maintenance SQL under owned migrations, compute fixtures/harness and package tasks.

## Contracts

Cloud Run job arguments contain opaque job/attempt ids only. The runner uses platform metadata identity to request expiring input/output R2 grants from the application Worker. Validate Google issuer/audience/service-account subject and active fenced attempt using a maintained JWT library. Grants are object/method/expiry scoped; redact them and prevent insecure callback/redirect destinations. The runner holds no database/admin/R2 credentials.

Workflow dispatch uses Google OAuth from an injected provider. Implement the configured least-privilege service-account secret exchange with bounded requests, separate dispatcher/runner roles, and no material logged/serialized to release evidence. Do not claim federation exists; document the future substitution boundary.

After dispatch, the Workflow records/reconciles execution, waits with bounded polling/events, verifies output integrity, and commits under the active attempt. Database-only retention runs via one Supabase Cron schedule. Artifact retention remains an R2-aware service, not SQL pretending to delete objects. Current protocol `sample-v1` and preset `demo-180p-v1` remain unless intentionally versioned.

## Sequence and checks

- [ ] Add failure fixtures for dispatch accepted/record failed, retry reconciliation, two leases, stale completion, wrong Google subject/audience, expired grant, foreign output key and mismatched hash.
- [ ] Implement the repository/Workflow/Google adapter and finite runner. Ensure retrying ambiguous dispatch cannot accept duplicate output; use existing attempt fencing plus a documented execution reconciliation strategy.
- [ ] Run the actual Rust binary in Docker through the runner using local authenticated metadata/grant/API fixtures and real local Supabase/R2 emulation. HTTP fixtures verify the boundary, not Google's cloud IAM behavior.
- [ ] Add injected output/deadline/cancellation budgets; a stopped run cannot publish completion. Preserve terminal/retryable processor classification and max-attempt behavior.
- [ ] Test cloud identity material/signed URLs never enters process argv, structured logs, reports or public asset bundles. Exercise redirects and callback hosts explicitly.
- [ ] Add bounded maintenance/retirement tests with live/expired rows and foreign job objects. Assert one scheduler owner and isolation from a disabled compute profile.
- [ ] Add explicit `bun run test:compute -- --backend supabase --processor cloud-run-local` selection. It must run real processing and fail nonzero without Docker; it is not a cloud deployment or a blanket skip.
- [ ] Keep explicit Cargo tasks and complete toolchain/config/fixture/runner/image inputs. Run database/job/Worker unit suites, real compute lane, `cargo test --locked`, `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo build --release --locked`, jobs typecheck, whole-repo guards, lint/format and bundle checks. Verify the final image runs the real non-root FFmpeg processor and finite runner, not a cached stub or an HTTP listener presented as job success. Run local jobs journeys against preview web/native clients where feasible.
- [ ] Run PR-budget check and create one PR. No Google API mutation, image upload, hosted execution or Cloudflare Container deletion.

## Handoff

Freeze Google project/region/job/image/runner/dispatcher/protocol configuration names for 07. Report local runner/Workflow/Postgres/R2 evidence separately from NOT RUN hosted dispatch, metadata/IAM grants, cross-cloud transfer costs and deployment checks. Enabled compute without configured prerequisites must refuse explicitly.
