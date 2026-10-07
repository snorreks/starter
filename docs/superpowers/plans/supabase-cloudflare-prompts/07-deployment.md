# Prompt 07 — One deployment authority across three providers

Implement only Prompt 07 from the migration plan; read its common contract, spec, and all merged runtime handoffs. Create one Herdr worktree and one PR.

**Branch:** `feat/supabase-07-deployment`. **Requires:** 04, 05, 06 merged. **Budget:** target 45–80 paths, maximum 99. Run sequentially against the integrated runtime consumers.

**Implementation references:** Read [the Nordclaw Cloud Run reference review](../../../reviews/2026-10-07-nordclaw-cloud-run-reference.md), including the listed `cloud_run.ts`, `service_accounts.ts` and `gcp_apis.ts`. Adapt the Artifact Registry/idempotent provisioning ideas to Starter's target/bounds/credential rules and Cloud Run Jobs. Do not inherit directory-existence build skips, mutable deployed images, broad API enablement, public-service defaults or false-success setup behavior.

## Files and scope

- Extend `scripts/src/deploy/{target,compatibility,configure,credentials,preflight,provision,apply,release,remote_config,variables}.ts` and `scripts/src/registry/{app_registry,deployment_values}.ts` as actually present.
- Add bounded Supabase/Google provider adapters under `scripts/src/deploy/providers/` and process/HTTP fixtures. Keep provider calls behind the one resolved target and bounded tools boundary.
- Adapt `scripts/src/db/{migrate,status,seed}.ts`, setup profiles/doctor, native configuration, `.github/workflows/deploy.yml`, secret schema/examples, deployment docs and tests. Scripts invoke package-owned tooling without importing backend packages.
- Retain legacy target support only for the existing default until 08; the Supabase preview plan covers the entire new deployment and is separately fixture-verified.

## Target contract

Resolve staging/production Supabase project ref, API/auth URL, mail sender and native redirect allowlist; Cloudflare account/web/jobs/Workflow identities and R2 bucket; Google project/region/Cloud Run job/artifact image/runner/dispatcher identities; processor protocol, resource limits and required secret names. Public Supabase publishable configuration is distinct from administrative secrets.

Reject targets that share isolated resources across environments, mismatch callback/API origins, refer to inconsistent protocols, or omit enabled compute destinations. Offline plan reads no credentials and performs no network request. Authenticated preflight is read-only. Provision/apply validate the same complete target; secret values use stdin/request bodies with redaction and do not enter argv.

## Sequence and checks

- [ ] Add target fixtures where web names staging but Supabase or Google points to production; shared buckets/projects/job identities; invalid callbacks; disabled compute; missing prerequisite secrets. Expect explicit failure before a mutating spawn.
- [ ] Extend the resolver/schema and adapters. Keep operational phases distinct. Supabase project creation that may incur costs is explicit provisioning, not a hidden consequence of plan/preflight.
- [ ] Implement migration commands through pinned Supabase package tooling, exact project identity and expand/contract ordering. Seed is synthetic and local unless the command explicitly scopes and authorizes remote fixtures.
- [ ] Implement Google image/job/IAM configuration planning and bounded apply subprocesses/API adapters, with least-privilege runner versus dispatcher identities and no service-account material in reports.
- [ ] Add setup fixtures where API listing is denied, account describe fails for a non-not-found reason, account creation fails, quiet registry pull fails, or dry-run plans missing resources. Quiet capture preserves process exit status. Discovery failures remain errors; failed mutations exit nonzero; planned resources are not reported as fixed. Derive required APIs from actual target capabilities and verify image digest/revision rather than build-directory existence.
- [ ] Add process fixtures observing exact argv/stdin and mocked provider HTTP boundaries for partial apply, rollback limitations and idempotent provision. A provider failure must stop dependent stages and record only completed operations.
- [ ] Add release record provenance covering schema revision, Worker/image/protocol, Supabase/Google/R2 targets, native API origin, and verification status. Redact grants, refresh tokens, dispatcher keys and administrative credentials.
- [ ] Extend CI environment variables/secrets and permissions/bounds policy. Previews must not read production credentials; offline planning works without environment-scoped secrets.
- [ ] Run deployment/target/credentials/native/configuration/workflow fixtures, `bun run deploy:check --env staging` against a synthetic fully resolved target, `bun run workflows`, `bun run guard:whole-repo`, `bun run typecheck`, lint/format and relevant unit lanes.
- [ ] Write exact hosted preflight/provision/apply/verification commands and prerequisites in `docs/deployment.md`. Mark live actions NOT RUN during this implementation; do not invoke them or widen accounts to complete the PR.
- [ ] Run the PR-budget check and create one PR.

## Handoff

Record complete target/secret names, command behavior and exit codes, failure recovery, operator live checks and CI requirements. 08 can delete legacy routes/configuration only after this preview deployment path is complete at its tested boundaries. No remote resources are retired automatically.
