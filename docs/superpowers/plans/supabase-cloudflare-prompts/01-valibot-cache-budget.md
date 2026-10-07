# Prompt 01 — Valibot contracts, trustworthy caching, bounded PRs

Implement only Prompt 01 from `docs/superpowers/plans/2026-10-07-supabase-cloudflare-migration.md`. Read that plan's common execution contract and linked spec first. Create one Herdr worktree and one PR; do not implement later prompts.

**Branch:** `refactor/supabase-01-contracts`. **Base:** integrated migration baseline. **Budget:** target 55–80 paths, hard maximum 99 including review fixes. **Parallel:** may implement alongside 02; merge this PR first.

## Deliverable and file ownership

- Convert `packages/shared/schemas/src/**` application contracts to Valibot, retaining exported schema/type names and existing limits.
- Adapt `packages/frontend/platform/src/dto.ts`, `apps/frontend/client/src/lib/server/http.ts`, direct schema users in routes/server/tests, `scripts/src/registry/app_registry.ts`, `scripts/src/deploy/variables.ts`, `scripts/src/visual/schemas.ts`, and `apps/e2e/src/scenarios/manifest.ts` as actually present in the execution base.
- Update owning package manifests/lock; add pinned Valibot and Standard Schema spec types where consumed. Retain `.pi` TypeBox SDK tool declarations; update only shared-validator call sites if any. Do not rewrite the Pi tool namespace or carry duplicate application schemas.
- Repair `scripts/src/ci/cache_scope.ts` and project Moon inputs so the actual transitive source/config graph is covered. Prefer authoritative Moon inputs/dependency cache strategies; remove the supplemental gate only after its correctness is reproduced by native configuration.
- Create `scripts/src/ci/pr_file_budget.ts`, `scripts/src/commands/pr_budget.ts`, and `scripts/tests/pr_file_budget.test.ts`; wire `pr:budget` in root scripts/CLI. The checker includes base-to-HEAD, pending tracked changes, and untracked paths owned by the checkout; no ignored generated-output counting, but no reviewable source exclusions.

## Contracts

Produce synchronous Standard Schema-compatible application validators and `parseDto(schema, value, what)` with its existing classified-error behavior. Parsing must reject unknown keys and must not alter wire data. Define a narrow shared `checkSchema`/`parseSchema` boundary only where multiple hosts need the same validation/error policy; do not build a universal schema framework.

Preserve resource-id patterns. Introduce a separate UUID schema for Supabase identity; any temporary legacy+UUID user-id union is named/documented and removed in 08. Compile-time checks must infer DTO types without `any` or unsafe return assertions. JSON Schema export is introduced only for a real current consumer with golden fixtures.

The PR-budget CLI exits nonzero above the configured cap and reports exact count/base. Test `99` accepted, `100` rejected; conservative rename counting; generated and deleted files; staged/untracked files; invalid/missing base. A required base must not default silently.

## Test and implementation sequence

- [ ] Inventory every direct TypeBox use and schema introspection before changing code. Distinguish externally required Pi parameters from application validation. Record planned changed paths.
- [ ] Add parity fixtures for strict unknown fields, missing/optional/null, invalid UUID/resource ids, finite integers, all union variants, empty note updates, maximum lengths, emoji/surrogate string-length boundaries, and Rust golden protocol documents. Example assertions: `expect(checkSchema(NoteCreateSchema, {...valid, ownerId:'other'})).toBe(false)` and `expect(checkSchema(NoteUpdateSchema, {})).toBe(false)`. Resolve any JSON Schema code-point versus JavaScript string-length mismatch explicitly; do not silently change the wire contract.
- [ ] Run the new fixtures against the deliberately wrong migration in a temp fixture or observe the missing validator API failure. Do not temporarily weaken repository schemas.
- [ ] Migrate contracts and consumers; use `strictObject`, bounded errors, and native Standard Schema. Preserve defaults only in tooling APIs that explicitly already apply them.
- [ ] Add cache fixtures proving edits in features/platform/jobs invalidate the correct consumer, while unrelated edits do not. Include root configuration, migrations/generated inputs when declared, and build-affecting environment inputs. Query the actual resolved Moon task graph.
- [ ] Implement and test the PR-budget command with temporary Git repositories; never modify the repository to prove an over-limit case.
- [ ] Build representative browser/Worker artifacts and compare retained validation bytes to the baseline. Verify compiled TypeBox performance is not used as a workerd claim. Do not make noisy timing thresholds a CI correctness gate.
- [ ] Run `bun run test`, `bun run typecheck`, `bun run lint`, `bun run format`, `bun run guard:whole-repo`, `bun run workflows`, `bun run build`, `bun run check:bundle`, `bun run test:browser`, and `bun run test:worker` as prerequisites permit; required unavailable lanes remain unresolved. Count tests.
- [ ] Run `bun run pr:budget -- --base origin/main --max-files 99` against the actual PR base; commit only owned files and create one PR with schema parity and artifact evidence.

## Handoff

Report validator helper signatures, application schema exports retained, Pi exception, exact dependency versions, measured artifact differences, actual cache invalidation evidence, PR count, and NOT RUN checks. Do not modify Supabase provisioning or deployment target logic in this PR.
