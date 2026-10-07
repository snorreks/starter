# Pi global project tools acceptance audit — 2026-10-07

This audit records observed results, including failed and unrun acceptance. No
credentials, verification links, browser cookies, or raw environment values are
included. PRs remain drafts; merge and publication are pending.

## Revisions and environment

| Work | Revision tested |
| --- | --- |
| Starter | `083c304a16ad306818f84086888e6cc1d42a5174` plus the evidence-manifest correction in the working tree. The model-driven attempt ran against this exact source tree. |
| Portable workflow package | `3b6edfcb4fab4ebd80b1c23e66bef385bd9e991b` |
| Runtime tools | Pi 1.0.2; Bun 1.4.2; package runtime browser tests use locked Playwright/Chromium. |

## Acceptance requirements

| Requirement | Status | Command / run | Artifact and result |
| --- | --- | --- | --- |
| Fresh install; isolated global/project Pi composition and ownership | PASS | `bun run test:pi-live` and `bun run test:composition-live` in `packages/workflow-helpers` at `3b6edfcb4fab4ebd80b1c23e66bef385bd9e991b` | Real Pi CLI 1.0.2; 1+1 tests passed, 31 assertions. Fresh isolated `PI_CODING_AGENT_DIR`; no extension errors. [Portable real-Pi test transcript](artifacts/portable-real-pi-tests.transcript.txt), SHA-256 `79ed5db61cb300284bd2a81fbc08a03c0592f6ef5f376c54c13de3249f7fd6ec`. |
| Starter built UI account/notes journey with model-driven Pi | FAIL | Real Pi 1.0.2 with offline `acceptance/scripted` faux provider: `agent_runtime_5fe46e2d065540a1b705df1dbce5372a`, `agent_runtime_cf632ade23ad4b5cb79f78b8396e41ba`; live OpenRouter model `google/gemini-2.5-flash`: `agent_runtime_389fb655275c4ed89332da035a367891` | Offline attempts reached 403 verification/sign-in and then 200 sign-in but failed to observe an edited note. The live-model attempt loaded the built account page and repeatedly requested verification; it timed out at 900 seconds before any note mutation. Raw Pi output was discarded because it might contain synthetic credentials. Sanitized live [transcript](artifacts/pi-live-model-timeout.transcript.txt), SHA-256 `3022a4db6648c6eb6ee008d39bbb0c373c361f8931ea67af67605593e8cc0a86`; earlier redacted [Pi transcript](artifacts/pi-account-notes-redacted.transcript.txt), SHA-256 `3793a254f1ed6f5a04bc45d82c7b2eff3ab6f42041e274a9213b7e7f7e858ad2`; first-attempt [Worker log](artifacts/pi-account-notes-worker.txt), SHA-256 `d254361e6baaf55e4bfb65da0adfdec272fc87b72a4aa2ff1c6913e669af4f25`. Every owned runtime was stopped through the token-verified supervisor. |
| Screenshot of the resulting account/notes state with matching run metadata | FAIL | Same Starter Pi runs above | Journey did not reach a verified edited note; no qualifying screenshot or hash. The live attempt's filtered Worker request sequence is preserved in its transcript; no auth values or verification query parameters are retained. |
| Fixture error visible in bounded browser console/network and matching runtime logs, with no stale or leaked auth evidence | NOT RUN | No controlled browser error fixture was introduced in this pass | Existing log path was exercised and run-filtered; that does not prove the error-injection requirement. |
| Same stored visual capture reviewed through CLI and Pi with matching grade, policy and provenance | PASS | `bun run agent -- visual review --run visual_36b4515f-c9cc-44f4-a890-400d678f7c7e --json`; `PI_VISUAL_REVIEW_RUN_ID=visual_36b4515f-c9cc-44f4-a890-400d678f7c7e bun test .pi/tests/live/visual_review_facade.test.ts` | The CLI and Pi facade matched all 76 grades and provider/model provenance (1 test, 9 assertions). [Parity transcript](artifacts/visual-cli-pi-parity.transcript.txt), SHA-256 `cdd0ab3935b17420c825b264a039ff626423eb4f0e09a5cb83bc781792c94dee`. Review JSON SHA-256 `cb11ed4a8a4aa46a63d49b7757ca55ac76d48075adb5b82cab3d4d7c77dbc313`; HTML SHA-256 `c25db88161a1f1ddb50efc77c50974dd2610d24927389da0de140d39d74f782e`. The review itself is `failed` (62 passed, 6 failed, 8 needs-human-review); those outcomes were surfaced identically and not retried. |
| Two concurrent parent captains isolate runtime state, browser sessions, artifacts, logs and stop authority | FAIL | `bun run test:qa-live` at package revision above exercises concurrent isolated QA children, not two parent captain Pi processes | 2 real supervised Pi QA children passed, but direct parent-captain acceptance remains open. This test is supporting evidence only, not a PASS for this requirement. |
| Bounded delegated QA with explicit tools and no recursive/publication access | PASS | `bun run test:qa-live` | 2 real Pi QA tests passed: owned browser checks, reload persistence, evidence capture and linked-worktree separation. Transcript above, SHA-256 `79ed5db61cb300284bd2a81fbc08a03c0592f6ef5f376c54c13de3249f7fd6ec`. |
| Cancellation removes task-owned runtime/browser processes | NOT RUN | No real-Pi cancellation acceptance was executed. During the live model timeout, the parent Pi exited at the 900-second bound while the Worker remained alive; `stopJob` then stopped its token-verified owned job. | The cleanup outcome is evidenced, but this did not prove cancellation propagation from Pi. No matching run-owned browser process remained. Live transcript SHA-256 `3022a4db6648c6eb6ee008d39bbb0c373c361f8931ea67af67605593e8cc0a86`. |
| Generic non-Starter project uses portable fallback and browser without Starter imports | FAIL | `bun run test:composition-live` | Trusted generic, denied and Aikami-shaped composition passed (1 test, 18 assertions); the required generic browser journey was not exercised. |
| Docker-backed full browser-to-FFmpeg compute, output hash and media probe | PASS | `bun run agent -- compute full --json` at Starter source revision above; run `agent_full_4000c2e5-cf63-44ee-b1b7-1c26537db887` | One Playwright test passed. Encoded MP4 SHA-256 `8804503517b67b738b437eb470cabe0f3aa0644f4103e74d6a0fcb0f03f57c9c` (112,717 bytes); evidence JSON SHA-256 `c52770a3ab9457e0b7503c72eab6334662bcbfbb4b148fa10ff75a09c85f319e`; media probe: H.264, 320×180, 3.019 s. Paths are under `.wrangler/runs/<runId>/artifacts/compute/`. |
| Pi process restart/recovery reattaches only owned jobs, invalidates stale browser handles, and revalidates current evidence | NOT RUN | Pure helper checks exist; no actual Pi process restart acceptance was run | The current evidence proves explicit stop, not restart/recovery. |

## Repository verification commands

| Command | Result at the Starter source revision above |
| --- | --- |
| `bun run --cwd .pi test` | PASS, 239 tests / 20 files / 1,197 assertions. |
| `bun run test` | PASS, 917 tests / 60 files / 39,636 assertions; 15 tasks completed (1 executed, 14 cache hits). |
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

- Starter pull request #44, base `main`, draft.
- Portable package PR [#1](https://github.com/snorreks/.pi/pull/1), base `master`, draft.
- Portable package head `3b6edfcb4fab4ebd80b1c23e66bef385bd9e991b` has no CI run because that repository has no Actions workflows configured (`gh workflow list --repo snorreks/.pi` returned no workflows). Local commands in the validation table are the remaining available checks there.
- A manual Starter CI run, [37680587080](https://github.com/snorreks/starter/actions/runs/37680587080), ran against predecessor head `62466bbf1349a9f6f9cc6a5d83bf39fbe1f8df27`: Compute integration and Worker integration passed. Static and unit lanes failed on the visual-manifest link, report provenance references, and a doctor-test assumption about Chromium installation. Its E2E lane stayed in Playwright Chromium installation, so I requested cancellation to free the ref for final-head CI.
- Final-head CI [37682202351](https://github.com/snorreks/starter/actions/runs/37682202351) ran at `083c304a16ad306818f84086888e6cc1d42a5174`: E2E, Worker integration, and compute passed. Static/unit failed because the generated matrix still included a second, older observed visual row linking ignored run `visual_e0df9292-d351-4130-925f-0552203ee6b1`; the preceding fix had updated the historical row instead of this active row. The active manifest row and generated matrix are now corrected to point to this committed audit and record the one-run visual result. A new final-head CI run is still required after this correction.
- Portable package PR #1 has no CI run because its repository has no Actions workflows configured (`gh workflow list --repo snorreks/.pi` returned none). Its local process/browser checks are in the portable transcript above. No merge or publication is part of this audit.

## Reruns

```bash
# Portable process/browser checks
cd /home/sonny/.pi/worktrees/workflow-helpers/agent/packages/workflow-helpers
bun run test:pi-live
bun run test:composition-live
bun run test:qa-live

# Docker-backed full compute
cd <Starter worktree>
bun run agent -- compute full --json

# Remaining acceptance work: complete the direct account/notes, two-parent,
# restart/recovery, cancellation, browser-error and paired-visual journeys before
# treating this PR as ready to merge.
```
