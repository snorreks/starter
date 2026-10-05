# Starter optimization review

Reviewed against merged main through `cd5f2647`, the operator's round-two and SOPS
runbooks, and Aikami's selective updater/toolchain DX. This is a prioritized repair,
not a claim that a template is universally optimal or production-certified.

## Preserve the useful boundaries

Keep one SvelteKit origin, service calls rather than self-fetches, injected feature
collaborators, request-local identity, private/no-store authenticated responses,
atomic D1 auth budgets, separate native/compute lanes, and one target resolver.
Aikami's update ergonomics transfer well; copying its whole application, agent
setup or additional servers would add authorities this starter does not need.

## Repairs made

- **Exact remote destination.** Generate disposable, gitignored Wrangler configs
  from the resolved target and committed runtime policy. Bind D1/account/Worker,
  auth origin/mail vars and optional compute identities to that same target.
  Resolve asset, migration and Dockerfile paths before relocating the config.
- **Web-only really means web-only.** Neutral dev defaults contain no R2 or
  Workflow bindings. Only an enabled, completely resolved compute target adds them.
  Generated jobs config has no public route and preserves resource/schedule caps.
- **Wrangler compatibility.** Do not use `--env` on already named generated configs;
  legacy secret commands otherwise append the suffix and address another Worker.
  Use supported `--message` release provenance, not `--meta`. Never create a new
  D1 database and pretend its new UUID is the absent ID an approval named: creation
  belongs to configure/provision, followed by a fresh plan.
- **Account isolation.** Authenticated CLI commands explicitly scope Wrangler to
  the configured account, refusing its cached-account fallback and restoring the
  calling environment afterwards.
- **Credentials.** Root `.env.deploy`, ignored/untracked, regular file and mode
  600; deploy token only, command-scoped loading, injected CI token wins. Offline
  plan/build/dev/update never load it. Runtime secret values use stdin. No token
  is moved into the runtime store, logs, argv or a tracked file.
- **D1 housekeeping.** Replace unsupported `DELETE … LIMIT` with a bounded key
  subquery. Test expired/live windows in real local D1, and report prune failures
  through the host's structured logger without weakening the auth verdict. Remove
  the dead, unbounded request-context maintenance export.
- **Compute fixture agreement.** Provision the media crate's actual fixture path
  under the same schema-owned R2 key that the runtime reads. Give the tiny-job
  deployment probe the required idempotency header.
- **One selective updater.** `bun run update`: offline preview, explicit `--yes`,
  independently selectable Nix/Bun/packages, exact workspace updates including
  `.pi`, reviewed Bun version override, all platform hashes and CI/version mirrors.
  Build/check the new Nix Bun before using it to generate a lockfile; subsequent
  nested tasks get that runtime first on PATH. No global upgrades or unpinned bunx.
- **Real process bounds.** Update, deploy builds and Wrangler execution/capture use
  time/output/cancellation bounds and owned process groups. A launcher exiting while
  its child retains the pipes cannot outlive the deadline. Existing synchronous
  CLIs use a supervised adapter, including stdin-only secret installation.
- **Operator-independent tests.** Remote migration/log tests use explicit fixture
  destinations rather than this checkout's local overlay. Generated web/jobs configs
  are tested for agreement; the neutral committed template is tested as neutral.

## Verification

The following completed locally on these changes; bounded transcripts are under
`.starter/verification/` (untracked):

```bash
bun run typecheck
bun run lint
bun run format
bun run test
bun run guard:whole-repo
bun run workflows
bun run test:browser
bun run test:worker
bun run e2e
nix build --no-link --print-out-paths .#bun
```

Counts are derived from transcripts, not typed into this document. Existing dated
capability-matrix rows remain evidence for their recorded revisions, not new claims
about this working tree. Bun emits an internal directory-mismatch diagnostic under
some isolated tests, although those tests exit successfully; SvelteKit also reports
its existing deprecated alias warning. These have not been misreported as clean
runtime/compiler output.

The full network `bun run update --yes --verify` has **NOT RUN**: this review adds
and tests the update path without mixing an unreviewed major-version migration into
a deployment repair. Update execution is fixture-tested with real process-failure
boundaries; the host's pinned Nix Bun build was actually performed. macOS/ARM Bun
builds, native packaging, paid compute, live scheduled maintenance, production,
external mail delivery and destructive rollback rehearsal are **NOT RUN** here.

## Follow-ups, not invented guarantees

- Replace deprecated SvelteKit alias configuration with supported subpath imports
  in a separately browser-verified migration.
- Choose an explicit auth-data retention policy for web-only deployments; disabled
  compute also means no scheduled jobs maintenance. Expired auth rows are not valid
  sessions, but expiry alone is not deletion.
- Auth/UI libraries currently declare no-unit-test-success tasks; their behavior is
  exercised in host/real-browser lanes. Remove those misleading empty task edges or
  give them meaningful independent tests before treating every project as tested.
- Rehearse Docker/native/mobile/production/compute with their real prerequisites.
  A working web release is not proof of any of these lanes.
- Keep provider mail-domain verification, production environment approvals and
  token least privilege as operator checks. Do not spend money or widen an account
  merely to make a template's optional example say it ran.
- The old double-suffixed staging Worker is retained. Retiring it requires an
  explicit decision about existing traffic and rollback; this review never deletes
  it or mutates production resources.
