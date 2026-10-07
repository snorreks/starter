# Pi global project tools acceptance audit — 2026-10-08

This is the final evidence audit for the acceptance journeys in the original
implementation plan. `PASS` means the specified behavior was observed at the
revision listed; `FAIL` is reserved for an observed current check failure;
`NOT RUN` means the check was not completed. Earlier failed attempts are retained
as diagnosis evidence and do not replace a later passing rerun. Credentials,
passwords, verification URLs/tokens, cookies and raw model output are excluded.
Both pull requests remain drafts; merge and publication are pending.

## Revisions and environment

| Work | Revision tested |
| --- | --- |
| Starter adapter and harness | `1e4d65af5caee3c664a5200bb266bc1e3156dbfe` (unchanged code; this audit adds evidence only) |
| Portable workflow package | `44e758a4e2ad5c5bd5a7257024efedc18416b276` |
| Model journey | Pi 1.0.2, `google/gemini-2.5-flash`, built Starter profile, run `agent_runtime_feec967469bc4b0795c3d7802b0e9dd8`, job `job-1791408092603-0c1a41`; process exit 0 |
| Browser/test runtime | Bun 1.4.2; package's locked Playwright and Chromium; Docker available for compute |

## Acceptance journeys

| Requirement | Status | Command / run and tested revision | Evidence and observed result |
| --- | --- | --- | --- |
| Fresh install; isolated global/project Pi composition and ownership | PASS | `bun install --frozen-lockfile`; `bun run test:pi-live`; `bun run test:composition-live` in `~/.pi/worktrees/workflow-helpers/agent/packages/workflow-helpers` at `6312f08763fbae084485b768d431c4ce06723725` | Frozen install had no changes. Real Pi CLI 1.0.2 isolated install/RPC passed (13 assertions); composition passed (18 assertions). [Portable process transcript](artifacts/portable-real-pi-tests.transcript.txt), SHA-256 `79ed5db61cb300284bd2a81fbc08a03c0592f6ef5f376c54c13de3249f7fd6ec`. |
| Starter built UI account/notes journey with model-driven Pi | PASS | Actual Pi process through `bun run agent -- ...` global model env; built profile run `agent_runtime_feec967469bc4b0795c3d7802b0e9dd8`; Starter `1e4d65a`, package `6312f08` | Account signup, mailbox verification, sign-in, create/edit note, reload and persistence observation completed. Worker observed `POST /api/auth/sign-up/email 200`, verification redirect and page 200, sign-in 200, `POST /api/notes 200`, `PATCH /api/notes/:id 200`, subsequent `GET /api/notes 200` and `/notes 200`. Sanitized [Pi transcript](artifacts/pi-model-driven-account-notes-6312.transcript.json), SHA-256 `bde9a172857664613e956a1b0f3c4270ad9ddafd9b3559bed0d4f2e3774acb28`. |
| Screenshot of resulting account/notes state with matching run metadata | PASS | Same model run; browser screenshot at `http://127.0.0.1:4241/notes` | [Screenshot](artifacts/model-driven-account-notes-6312.png), SHA-256 `be70856336a55f833d879d8af5fd794ed48440b814dbb4e030946c239cb41cac`, 37,402 bytes, 1440×900; transcript records matching run ID and URL path. Screenshot preserves original capture. |
| Debugging: introduced fixture error correlated to bounded browser console/network and matching run logs; no stale evidence or leaked auth | PASS | `CHROMIUM_PATH=$CHROMIUM_PATH PI_GENERIC_BROWSER_EVIDENCE=<evidence>/artifacts/generic-project bun run test:generic-browser-live` at package `44e758a` | Fixture run `debug_fixture_db894075e3ef410a813f4f480e5dcd7a` produced a console error and HTTP 500, both correlated with the same runtime log event. Bounded browser histories reported no dropped entries. [Correlation evidence](artifacts/generic-project/debug-correlation.json), SHA-256 `3e53db227955a2027011e40075c8ec3939a8db37f198c62f0b8b45efd0892c1e`. No auth data or query values were retained. |
| Visual QA: same stored capture reviewed through CLI and Pi, matching grade/policy/provenance | PASS | `bun run agent -- visual review --run visual_36b4515f-c9cc-44f4-a890-400d678f7c7e --json`; `PI_VISUAL_REVIEW_RUN_ID=visual_36b4515f-c9cc-44f4-a890-400d678f7c7e bun test .pi/tests/live/visual_review_facade.test.ts` at Starter visual harness revision | CLI/Pi facade matched all 76 grades and provider/model provenance (1 test, 9 assertions). [Parity transcript](artifacts/visual-cli-pi-parity.transcript.txt), SHA-256 `cdd0ab3935b17420c825b264a039ff626423eb4f0e09a5cb83bc781792c94dee`. Review result itself was `failed`: 62 passed, 6 failed, 8 needs-human-review; the grade was surfaced identically and not retried. Review JSON SHA-256 `cb11ed4a8a4aa46a63d49b7757ca55ac76d48075adb5b82cab3d4d7c77dbc313`; HTML SHA-256 `c25db88161a1f1ddb50efc77c50974dd2610d24927389da0de140d39d74f782e`. |
| Two concurrent parent captains isolate state, browser sessions, artifacts, logs and stop authority | PASS | `PI_PARENT_CAPTAIN_ARTIFACTS=<Starter evidence>/artifacts/parent-captains bun run test:parent-captains-live` at package `6312f08` (unchanged implementation, same final head) | Two actual concurrent parent Pi processes and two real Pi child processes had separate session/run/browser IDs, screenshots/artifacts and own-page/log assertions. Both foreign stop attempts were refused while both runtime PIDs remained alive; each captain then stopped only its owned runtime. Cancellation closed browser sessions; no owned Pi runtime process remained. [Summary](artifacts/parent-captains/parent-captains-summary.json), SHA-256 `20db51bcdf26f70097ddf75549c3d2e8e694a31d9ed3a5f47ca57072d91006ae`; screenshot hashes `683d6d10079cd9dfbcc118103f3861f6d9fe65a6b7fe7e39feb2039783314d56` and `1b96b00858a83a762ce768dcb5db85d14cdbb9a06ebad0baa240296832ba8821`. |
| Bounded delegated QA: explicit tools, browser checks, linked worktrees, no recursive/publication access | PASS | `bun run test:qa-live` at package `6312f08` (unchanged implementation, same final head) | Two actual supervised Pi QA child processes passed with separate linked worktrees, origins, contexts, artifacts and persisted browser state; role restrictions were verified. Included in [portable process transcript](artifacts/portable-real-pi-tests.transcript.txt), SHA-256 above. |
| Cancellation cleans up task-owned runtime and browser processes | PASS | `bun run test:parent-captains-live`; `bun run test:browser-live` at package `6312f08` | Live captain test verifies cancellation/owned stop leaves no runtime Pi process and closes each browser session; browser suite also covers cancellation before an operation begins, closing the context and rejecting stale session use. `test:browser-live`: 5 tests / 38 assertions. |
| Generic non-Starter project uses portable fallback and browser without Starter imports | PASS | `CHROMIUM_PATH=$CHROMIUM_PATH PI_GENERIC_BROWSER_EVIDENCE=<evidence>/artifacts/generic-project bun run test:generic-browser-live` at package `44e758a` | Real generic Node project invoked its declared fallback status command, used the portable Chromium browser to save state, reloaded and observed persistence, then captured a 1440×900 screenshot. Test passed 2 cases / 12 assertions; no Starter imports. [Summary](artifacts/generic-project/generic-project.json), SHA-256 `fd172119579a736556a3dac92b7dcf09d5ae379d4330de0c8adb92d065f1b01b`; [screenshot](artifacts/generic-project/generic-project.png), SHA-256 `927b072cd6a007c28f19223b783726de2248dd8347220be67e5c7b7c612ad86d`. |
| Full compute: real browser-to-FFmpeg journey through the Pi facade with hash and media probe | PASS | `bun run --cwd .pi test:compute-facade` at Starter `1e4d65a` | Real Docker-backed journey invoked by loaded Pi project tool, run `agent_full_b64eb326-b1ff-4c53-9e6c-638d0cc94504`, 1 test / 7 assertions. MP4 SHA-256 `8804503517b67b738b437eb470cabe0f3aa0644f4103e74d6a0fcb0f03f57c9c`, 112,717 bytes; evidence JSON SHA-256 `d1289d6b585cac6f8ebf3f2d78008140f0699e1f0c7b51036de41e62ffd1beb2`; H.264, 320×180, 3.019 s. |
| Recovery: actual Pi process restart/reload discovers only retained owned jobs | PASS | `PI_PARENT_RECOVERY_EVIDENCE=<Starter evidence>/artifacts/parent-recovery-transcript.json CHROMIUM_PATH=$CHROMIUM_PATH bun run test:parent-recovery-live` at package `44e758a` | Two actual Pi processes restarted with the same session ID. Restart attached the persisted session, announced the owned run and ignored the foreign run. Owned run `a6021869-4c8d-42f2-8d70-41683b039519`; foreign `ec418747-018e-4851-8fd0-2176d3026707`. The same real-Pi restart rejected the pre-restart browser session handle, rehashed the retained screenshot, and reattached only to the expected live runtime identity. Transcript SHA-256 `66a9febd9f09eeb2b2b3a45aa66f4e3fbe4cd21a1c8b1d2fa8ae3c5cbfc86215`; screenshot SHA-256 `1248dd124d110b8a4fb3dbfadfa825701bce6b682e8699fb88375d7a4466b04f`. |

## Model timeout diagnosis

The earlier live run `agent_runtime_389fb655275c4ed89332da035a367891` timed out after 900 seconds. Its last useful functional progress was account signup/mailbox delivery; verification was repeatedly revisited and sign-in returned 403, with no notes mutation or screenshot. The sanitized historical trace is [here](artifacts/pi-live-model-timeout.transcript.txt), SHA-256 `3022a4db6648c6eb6ee008d39bbb0c373c361f8931ea67af67605593e8cc0a86`.

The direct diagnosis run established that discovery and orchestration were working: Pi loaded the browser tool, started the built Worker, verified its run identity, opened a browser attached to that run, and read the page snapshot. The model's intuitive semantic locator shapes were rejected by a role-only schema, after which repeated locator errors stalled progress. That is a browser API/schema interaction defect; the runtime was alive and correctly identified, and no evidence points to tool discovery or orchestration as the cause. Sanitized [schema diagnosis transcript](artifacts/pi-model-browser-schema-diagnosis.transcript.jsonl), SHA-256 `28a187c1b73c5ebdf0a943e4d22bb4fde0f7d8c99f44dd8dd90e6aa94efd3de4`.

The package fix adds accepted semantic aliases and useful locator validation, plus cleanup when an already-cancelled call reaches a browser session. TDD red/green cases cover link/textbox/button targets and cancelled-before-start cleanup. The final model run still made a `/register` 404 attempt and a few ambiguous locator attempts, but used the browser snapshot to recover, switched to the actual account form, completed verification/sign-in/notes, reloaded and captured the screenshot. These recovered attempts are recorded without raw prompts, form values, mailbox bodies or verification links in the final transcript.

## Other verification at the tested revisions

Portable package at `44e758a4e2ad5c5bd5a7257024efedc18416b276`:

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | PASS; no lockfile changes. |
| `bun test lib tests` | PASS, 306 tests / 25 files / 671 assertions. |
| `bun run typecheck` | PASS. |
| `bun run test:pi-live` | PASS, actual Pi 1.0.2 compatibility, 13 assertions. |
| `bun run test:composition-live` | PASS, 18 assertions. |
| `bun run test:qa-live` | PASS, two actual Pi children / 26 assertions. |
| `bun run test:browser-live` | PASS, 5 tests / 38 assertions. |
| `bun run test:parent-captains-live` | PASS, actual concurrent parent and child Pi processes / 13 assertions. |
| `bun run test:parent-recovery-live` | PASS, actual Pi restart / 6 assertions. |
| `bun run test:generic-browser-live` | PASS, real generic project fallback/browser and correlated error fixture / 12 assertions. |

Starter at `1e4d65af5caee3c664a5200bb266bc1e3156dbfe`:

| Command | Result |
| --- | --- |
| `bun run --cwd .pi test` | PASS, 239 tests / 20 files / 1,197 assertions. |
| `bun run test` | PASS, 917 tests / 60 files / 39,636 assertions. |
| `bun test tests/jobs.test.ts` from `.pi` | PASS, 23 tests / 70 assertions. |
| `bun run --cwd .pi loader:smoke` | PASS, 4 tests / 10 assertions. |
| `bun run typecheck`, `bun run lint`, `bun run format`, `bun run guard`, `bun run workflows`, `bun run evidence` | PASS at the recorded source verification revision. |
| `bun run e2e:visual` | PASS, 88 tests; 76/76 captures in `visual_36b4515f-c9cc-44f4-a890-400d678f7c7e`; manifest SHA-256 `f7fcd379b12b32b16d51442d8805df78569e39fea7e03c75a89f96a33b53dff5`. |
| `bun run --cwd .pi test:compute-facade` | PASS; see full-compute row above. |

## Compute scope

The accepted design is a one-shot Docker compute journey invoked through Pi. The
live Pi facade executed that real browser-to-FFmpeg journey and preserved output
hash and probe evidence. A persistent full-compute runtime is outside this
migration's scope; conflicting wording in the earlier report is corrected here.

## CI and pull requests

- Starter PR [#44](https://github.com/snorreks/starter/pull/44) targets `main` and remains draft.
- Portable package PR [#1](https://github.com/snorreks/.pi/pull/1) targets `master` and remains draft.
- Starter CI previously passed all five lanes at `1e4d65af5caee3c664a5200bb266bc1e3156dbfe` in [run 37685202765](https://github.com/snorreks/starter/actions/runs/37685202765). This audit/evidence commit will trigger a new head run; its result must be checked and recorded before reporting final readiness.
- `gh workflow list --repo snorreks/.pi` returns no configured workflows, so the portable PR has no CI runs. Its local frozen install, unit/type, real Pi, browser, parent captain and recovery checks above are the available verification.

## Remaining NOT RUN acceptance and exact next action

1. Debugging fixture correlation: add/use a deterministic browser error fixture, run `bun run agent -- runtime start --profile built --json`, then inspect the same run through the browser diagnostic and `read_logs` project tools; record bounded sanitized evidence.
2. Generic project browser: run a real browser action in the minimal non-Starter fixture after `bun run test:composition-live`; this needs no Starter package imports.
3. Recovery composition: restart the actual Pi process, then prove stale browser handles are rejected and current artifact bytes plus runtime identity are revalidated before the recovered status is reported.

All ten acceptance journeys in the original plan now have PASS results. The recorded fixture runs use actual Chromium and actual Pi child processes where process lifecycle is part of the contract; no journey was replaced by a skip or a mock-only result.
