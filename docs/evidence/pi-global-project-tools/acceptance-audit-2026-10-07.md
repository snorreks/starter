# Pi global project tools acceptance audit — 2026-10-07

This audit records observed results, including failed and unrun acceptance. No
credentials, verification links, browser cookies, or raw environment values are
included. PRs remain drafts; merge and publication are pending.

## Revisions and environment

| Work | Revision tested |
| --- | --- |
| Starter | `3474a5ecc838011dd5b61e249a6a08fce966a5d8` plus the working-tree `.pi/lib/jobs.ts` runtime-launch change (tests ran against these exact files before commit). |
| Portable workflow package | `3b6edfcb4fab4ebd80b1c23e66bef385bd9e991b` |
| Runtime tools | Pi 1.0.2; Bun 1.4.2; package runtime browser tests use locked Playwright/Chromium. |

## Acceptance requirements

| Requirement | Status | Command / run | Artifact and result |
| --- | --- | --- | --- |
| Fresh install; isolated global/project Pi composition and ownership | PASS | `bun run test:pi-live` and `bun run test:composition-live` in `packages/workflow-helpers` at `3b6edfcb4fab4ebd80b1c23e66bef385bd9e991b` | Real Pi CLI 1.0.2; 1+1 tests passed, 31 assertions. Fresh isolated `PI_CODING_AGENT_DIR`; no extension errors. [Portable real-Pi test transcript](artifacts/portable-real-pi-tests.transcript.txt), SHA-256 `79ed5db61cb300284bd2a81fbc08a03c0592f6ef5f376c54c13de3249f7fd6ec`. |
| Starter built UI account/notes journey with model-driven Pi | FAIL | Real Pi 1.0.2 with offline `acceptance/scripted` faux provider; `dev_process start_profile built`; attempts `agent_runtime_5fe46e2d065540a1b705df1dbce5372a` and `agent_runtime_cf632ade23ad4b5cb79f78b8396e41ba` | The first attempt's Worker log shows verification and sign-in rejected (403); the second reached verification (302) and sign-in (200), but the model/tool sequence still failed to observe the edited note. No qualifying screenshot was retained. Redacted Pi output [transcript](artifacts/pi-account-notes-redacted.transcript.txt), SHA-256 `3793a254f1ed6f5a04bc45d82c7b2eff3ab6f42041e274a9213b7e7f7e858ad2`; run-filtered [Worker log for the first attempt](artifacts/pi-account-notes-worker.log), SHA-256 `d254361e6baaf55e4bfb65da0adfdec272fc87b72a4aa2ff1c6913e669af4f25`. Both owned runtime jobs were stopped through the token-verified supervisor. |
| Screenshot of the resulting account/notes state with matching run metadata | FAIL | Same Starter Pi run | Journey did not reach a verified edited note; no qualifying screenshot or hash. |
| Fixture error visible in bounded browser console/network and matching runtime logs, with no stale or leaked auth evidence | NOT RUN | No controlled browser error fixture was introduced in this pass | Existing log path was exercised and run-filtered; that does not prove the error-injection requirement. |
| Same stored visual capture reviewed through CLI and Pi with matching grade, policy and provenance | PASS | `bun run agent -- visual review --run visual_36b4515f-c9cc-44f4-a890-400d678f7c7e --json`; `PI_VISUAL_REVIEW_RUN_ID=visual_36b4515f-c9cc-44f4-a890-400d678f7c7e bun test .pi/tests/live/visual_review_facade.test.ts` | The CLI and Pi facade matched all 76 grades and provider/model provenance (1 test, 9 assertions). [Parity transcript](artifacts/visual-cli-pi-parity.transcript.txt), SHA-256 `cdd0ab3935b17420c825b264a039ff626423eb4f0e09a5cb83bc781792c94dee`. Review JSON SHA-256 `cb11ed4a8a4aa46a63d49b7757ca55ac76d48075adb5b82cab3d4d7c77dbc313`; HTML SHA-256 `c25db88161a1f1ddb50efc77c50974dd2610d24927389da0de140d39d74f782e`. The review itself is `failed` (62 passed, 6 failed, 8 needs-human-review); those outcomes were surfaced identically and not retried. |
| Two concurrent parent captains isolate runtime state, browser sessions, artifacts, logs and stop authority | FAIL | `bun run test:qa-live` at package revision above exercises concurrent isolated QA children, not two parent captain Pi processes | 2 real supervised Pi QA children passed, but direct parent-captain acceptance remains open. This test is supporting evidence only, not a PASS for this requirement. |
| Bounded delegated QA with explicit tools and no recursive/publication access | PASS | `bun run test:qa-live` | 2 real Pi QA tests passed: owned browser checks, reload persistence, evidence capture and linked-worktree separation. Transcript above, SHA-256 `79ed5db61cb300284bd2a81fbc08a03c0592f6ef5f376c54c13de3249f7fd6ec`. |
| Cancellation removes task-owned runtime/browser processes | NOT RUN | No real-Pi cancellation acceptance was executed | Two failed-run Worker jobs were explicitly stopped via their verified handles; this is recovery cleanup, not a cancellation test. |
| Generic non-Starter project uses portable fallback and browser without Starter imports | FAIL | `bun run test:composition-live` | Trusted generic, denied and Aikami-shaped composition passed (1 test, 18 assertions); the required generic browser journey was not exercised. |
| Docker-backed full browser-to-FFmpeg compute, output hash and media probe | PASS | `bun run agent -- compute full --json` at Starter source revision above; run `agent_full_4000c2e5-cf63-44ee-b1b7-1c26537db887` | One Playwright test passed. Encoded MP4 SHA-256 `8804503517b67b738b437eb470cabe0f3aa0644f4103e74d6a0fcb0f03f57c9c` (112,717 bytes); evidence JSON SHA-256 `c52770a3ab9457e0b7503c72eab6334662bcbfbb4b148fa10ff75a09c85f319e`; media probe: H.264, 320×180, 3.019 s. Paths are under `.wrangler/runs/<runId>/artifacts/compute/`. |
| Pi process restart/recovery reattaches only owned jobs, invalidates stale browser handles, and revalidates current evidence | NOT RUN | Pure helper checks exist; no actual Pi process restart acceptance was run | The current evidence proves explicit stop, not restart/recovery. |

## Repository verification commands

| Command | Result at the Starter source revision above |
| --- | --- |
| `bun run --cwd .pi test` | PASS, 239 tests / 20 files / 1,197 assertions. |
| `bun test tests/jobs.test.ts` from `.pi` | PASS, 23 tests / 70 assertions, including timeout, cancellation and token-verified stop boundaries. |
| `bun run typecheck` | PASS; `pi:typecheck` executed against the changed supervisor, other unchanged Moon tasks were cache hits. |
| `bun run --cwd .pi loader:smoke` | PASS, 4 tests / 10 assertions. |
| `bun run e2e:visual` | PASS, 88 tests; complete manifest run `visual_36b4515f-c9cc-44f4-a890-400d678f7c7e`, 76/76 captures; manifest SHA-256 `f7fcd379b12b32b16d51442d8805df78569e39fea7e03c75a89f96a33b53dff5`. |
| `bun run agent -- compute full --json` | PASS; see the full-compute row above. |

The targeted three direct gaps therefore remain open: the account/notes journey is
FAIL, actual process restart/recovery is NOT RUN, and two concurrent parent captains
are FAIL (concurrent QA children are not an equivalent observation). Cancellation
cleanup is also NOT RUN.

## Full-compute profile scope ruling

No persistent `full` `dev_process` profile was added. The implemented authority and
the linked E2E plan define full compute as a bounded, Docker-backed one-shot operation
(`bun run agent -- compute full --json`), and this audit executed that operation
successfully. The acceptance table's “persistent full-compute profile” phrase
conflicts with that explicit one-shot boundary. This is a scope discrepancy for the
requester to decide; adding a long-lived Docker compute service would change the
authority and lifecycle contract without support from the agreed one-shot design.

## CI and PR status

- Starter PR [#44](https://github.com/snorreks/starter/pull/44), base `main`, draft.
- Portable package PR [#1](https://github.com/snorreks/.pi/pull/1), base `master`, draft.
- `gh pr checks` at audit time reported only CodeRabbit “Review skipped: draft pull request” on each. No CI check is attached to either current head. The latest listed Starter CI failures were for older SHAs (`cb92b31…`, `bc069df…`, `081db9f…`), not the PR head. The portable repository had no branch run listed.
- To request CI after the acceptance fixes: push updated heads, then mark each PR ready for review (this changes draft state and is intentionally pending). Recheck with `gh pr checks 44 --repo snorreks/starter` and `gh pr checks 1 --repo snorreks/.pi`. Do not merge or publish as part of this audit.

## Reruns

```bash
# Portable process/browser checks
cd /home/sonny/.pi/worktrees/workflow-helpers/agent/packages/workflow-helpers
bun run test:pi-live
bun run test:composition-live
bun run test:qa-live

# Docker-backed full compute
cd /home/sonny/Development/Projects/passion/starter/.worktrees/pi-global-project-tools
bun run agent -- compute full --json

# Remaining acceptance work: complete the direct account/notes, two-parent,
# restart/recovery, cancellation, browser-error and paired-visual journeys before
# treating this PR as ready to merge.
```
