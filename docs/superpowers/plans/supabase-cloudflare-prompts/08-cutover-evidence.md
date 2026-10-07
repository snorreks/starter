# Prompt 08 — Sole Supabase default, legacy removal and fresh evidence

Implement only Prompt 08 from the migration plan; read its common contract, spec, and all seven merged handoffs. Create one Herdr worktree and one PR.

**Branch:** `refactor/supabase-08-cutover`. **Requires:** 07 merged and all earlier integration checks resolved. **Budget:** target 60–90 paths, hard maximum 99. This is sequential final integration, not a folder-renaming PR.

## Files and scope

- Remove legacy backend exports/implementations from `packages/backend/auth`, D1 schema/rate storage/migrations/config from `packages/backend/database`, legacy device-auth modules/routes/contracts, Cloudflare `encode_container.ts`/container bindings, and obsolete runtime dependencies only when no retained consumer remains.
- Remove the temporary backend selector and legacy deployment target branches. Supabase becomes the only application identity/data implementation. Cloud Run is optional; disabled compute remains explicit, and requested enabled compute fails with missing prerequisites.
- Update Worker/native configs, root/package/Moon tasks, `.github/workflows/{ci,deploy,native,native-release}.yml` only where required, and test harnesses to the new sole backend.
- Update `AGENTS.md`, current architecture/auth/database/cloudflare/compute/native/deployment/testing/toolchain/agent guidance, READMEs and generated evidence. Consolidate edits; do not rewrite every historical report or restate test counts manually.
- Update `scripts/src/smoke/template_smoke.ts` and smoke fixtures for fresh Supabase setup and a web-only copy; preserve existing E2E/visual work and portable Pi tooling.

## Sequence and checks

- [ ] Inventory every legacy reference before deleting. Classify source/runtime, obsolete tests/config, historical evidence, and externally required Pi TypeBox separately. Count deletions/generated files against the PR cap; do not hide them through rename detection.
- [ ] Add cutover fixtures proving missing Supabase configuration fails, legacy auth tokens do not authenticate, UUID user ids validate, disabled compute is explicit, and the starter requires no inherited cloud resource identifiers.
- [ ] Switch defaults and remove legacy code together. Remove temporary user-id union; retain named resource-id schemas. Delete only genuinely obsolete suites and replace their behavioral coverage with corresponding Supabase tests; do not turn failing required lanes into optional passes.
- [ ] Make credential-free unit checks independent of Docker. Database/Worker/E2E/compute lanes name their actual Docker/runtime prerequisites and refuse nonzero when missing. `test:all` includes its documented lanes with no duplicate execution.
- [ ] Ensure web-only smoke removes native/compute application examples without breaking shared auth/data setup, target resolution, task discovery or required checks. No generic profile/plugin generator is introduced in this PR.
- [ ] Run fresh combined-head `bun run test`, `bun run test:database`, `bun run test:browser`, `bun run test:worker`, `bun run e2e`, `bun run test:compute` and documented native CI/local lanes with real prerequisites. Record nonzero discovered counts; no cached result certifies newly migrated runtime behavior.
- [ ] Run `bun run typecheck`, `bun run lint`, `bun run format`, `bun run guard:whole-repo`, `bun run workflows`, builds/bundle checks, `bun run db:types:check`, `bun run smoke`, and `bun run smoke -- --without-heavy` on the fresh template copy.
- [ ] Refresh `docs/evidence/current.json` from actual transcripts and generate the capability table; run `bun run evidence`. Preserve dated previous evidence. Hosted Supabase/Resend/Cloud Run and physical-device observations stay NOT RUN unless actually performed with explicit authorization/prerequisites.
- [ ] Verify the final maintained runtime graph has no Better Auth, D1 application bindings or Cloudflare Container imports. Verify no Supabase admin/Google dispatcher secret in browser/native bundles. Pi SDK TypeBox remains a documented exception.
- [ ] Run the PR-budget command, verify the final base/head diff and create one PR with a clear removal/migration description. Do not delete hosted resources, migrate existing users/data, merge, deploy or publish stores as an implicit cleanup action.

## Final handoff

Report the final PR and revision, every required lane's observed status, derived evidence, remaining operator live commands, external prerequisites and compatibility decisions. The migration is implemented only if its required local/CI checks pass; absence of credentials is not evidence of a hosted deployment. Preserve the old live deployment until the operator has separately validated and authorized its replacement/retirement.
