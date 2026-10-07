# Prompt 02 — Real local Supabase, SQL policies and generated repositories

Implement only Prompt 02 from `docs/superpowers/plans/2026-10-07-supabase-cloudflare-migration.md`. Read the common execution contract and spec. Create one Herdr worktree and one PR.

**Branch:** `feat/supabase-02-foundation`. **Base:** integrated baseline; rebase after 01 before final checks. **Budget:** target 40–70 paths, hard maximum 99. **Parallel:** implementation may run alongside 01; manifest/lock/shared-path merges are sequential.

## Deliverable and files

- Create `supabase/config.toml`, ordered SQL migrations under `supabase/migrations/`, synthetic seed fixtures, and RLS/concurrency tests under `supabase/tests/`.
- Create `packages/backend/database/src/supabase/{client,database.types,notes_repository,chat_repository,jobs_repository}.ts` with explicit exports from the package. Add repository tests beside these modules and integration harness/scripts in that package. Retain existing D1 code until 08.
- Create `scripts/src/db/supabase_local.ts`, `scripts/tests/supabase_local.test.ts`, and package-owned local migrate/type-generation entrypoints. Wire root/CLI/Moon/setup doctor and CI only as required by the deliverable. Scripts spawn the database-owned tool; scripts do not import backend packages.
- Extend checkout/run allocation for unique Supabase project id, API/Postgres/Studio/mail ports, readiness identity, and owned teardown. Derive all configured local URLs from this one allocation.

## Database contracts

Use `auth.users`, application profiles, notes, conversations, messages, chat generations, jobs/attempt state, maintenance runs, and bounded admission counters. UUID auth ids are foreign keys. Preserve current processor protocol/resource ids. Internal state is not broadly exposed through the Data API.

Export the repository/client factories specified in the design. Keep storage rows private; project to shared DTOs. Complete notes/chat mutation plus recency update transactionally. Chat generation admission is keyed by `(owner_id,conversation_id,client_id)` with canonical request fingerprint, stable assistant id, state and attempt fencing. Job RPCs preserve existing admission, lease/fencing, completion and retention semantics, not a weaker CRUD table.

Expose only necessary tables/functions. RLS and constraints prevent cross-user reads/writes, owner spoofing, invalid state transitions, and direct Data API bypass. Restrict privileged RPC execution; never let a caller nominate an arbitrary owner. SQL functions with elevated rights use a fixed search path and explicit identity checks.

## Sequence and checks

- [ ] Add local ownership/port fixtures: two allocations differ; stale ownership cannot stop/reset the other stack; missing Docker is a named nonzero failure. Run and observe the failure before implementing helpers.
- [ ] Start a real isolated local Supabase stack and apply migrations. Add two synthetic Auth users through the local supported API, not inserts that bypass Auth lifecycle.
- [ ] Add direct Data API negative controls: A cannot read/update/delete B's note; supplied `owner_id=B` cannot create it; anonymous access is refused; internal tables are inaccessible. Assert on actual HTTP/data results.
- [ ] Add concurrent SQL/API tests: same chat key has one admitted generation; changed payload conflicts; only one job lease wins; stale completion fails; quota increments and admission are atomic. These must execute real Postgres, not `bun:sqlite` stand-ins.
- [ ] Implement migrations/RPCs/repositories. Test UUID mapping, timestamp units, row-to-DTO projection and legal state transitions.
- [ ] Generate `database.types.ts` from the reset local migration database with pinned CLI. Add `bun run db:types` and `bun run db:types:check`; the check regenerates to a temporary file and compares without overwriting tracked output.
- [ ] Add `bun run test:database` as a required credential-free integration lane that needs Docker. Preserve pure unit independence. Document that Docker is a new database-lane prerequisite.
- [ ] Run `bun run test:database`, `bun run db:types:check`, database package tests/typecheck, `bun run guard:whole-repo`, `bun run lint`, `bun run format`, and relevant setup/CI policy fixtures. Check at least one fresh reset-and-replay.
- [ ] Rebase after 01, regenerate manifests/lock through pinned tools, rerun validation and the PR-budget command, then create one PR.

## Handoff

Record exact repository interfaces, table/RPC names, generated-type command, allocation environment variables, local mail URL, and test counts. Existing default application still uses its complete legacy backend. Do not provision hosted Supabase, migrate live data, delete D1, or switch runtime defaults.
