# Prompt 04 — Remote functions, pagination and complete chat turns

Implement only Prompt 04 from the migration plan; read the common contract, spec, and 03 handoff. Create one Herdr worktree and one PR.

**Branch:** `feat/supabase-04-web-remote-chat`. **Requires:** 03 merged. **Budget:** target 35–65 paths, maximum 99. **Parallel:** with 05 and 06, respecting shared ownership.

## Files and scope

- Create `apps/frontend/client/src/lib/remote/notes.remote.ts`, `apps/frontend/client/src/lib/composition/notes_remote_adapter.ts`, and focused tests. Modify web notes routes/views as needed, without importing remote query objects into portable features.
- Update `apps/frontend/client/vite.config.ts`, `scripts/src/guards/policy.ts`, `scripts/src/guards/guard_architecture.ts`, relevant guard fixtures, and bundle checks for remote modules.
- Update `apps/frontend/client/src/lib/server/{chat_model,chat_service}.ts`, chat HTTP endpoints/server loads, `packages/frontend/features/src/chat/**`, notes paging consumers, and shared page/generation schemas. Use the 02 transactional generation repository; change SQL only if a discovered missing invariant requires a narrowly reviewed migration.

## Interfaces and pinned behavior

Web remote functions delegate to the 03 application services with Valibot argument validation and validated output. Native keeps named HTTP APIs and existing feature service facades. Add cursor DTOs with `items`, `nextCursor`, `hasMore`, `serverTime`. Page limits stay bounded; orders include id tie-breakers.

Chat admission returns a stable generation/reply id and `admitted|running|completed|conflict`; only `admitted` starts the provider. `running` gives an explicit recoverable status without a second call, `completed` replays the stored result, and changed content gives HTTP 409. SSE retains valid terminal error/success frames and schema validation.

Bound owner concurrency, prompt-history tokens/bytes, output tokens/bytes, and total elapsed generation time. Make the model an explicit configuration field. Define tested defaults in code/docs using the actual selected model's limits; do not invent a tokenizer estimate and call it an exact token count. Deterministic model fixtures remain; live provider tests are separately named.

## Sequence and checks

- [ ] Add guard fixtures: remote server execution can reach its intended service; a normal browser module cannot; secrets/server code cannot appear in the emitted remote wrapper.
- [ ] Add real browser/Worker tests proving remote argument validation, authorized creation, form failure behavior, SSR initial data and refresh. Tests must use generated remote wrappers, not only direct handler calls.
- [ ] Add pagination fixtures with more than 500 messages, identical timestamps, newest-page reload, older-page prepend and malformed/foreign cursors. Assert newest persisted messages remain visible after navigation.
- [ ] Add generation fixtures for simultaneous retries, changed content with same key, completed replay, provider completion followed by persistence failure, stale attempts, and independent simultaneous owners. Observe one provider call for a single admitted request key.
- [ ] Implement genuine provider streaming and supported abort forwarding. Probe abort during a delayed provider response and ensure no local output/persistence follows abort. Record limitations in actual provider billing cancellation; no promise of exactly-once billing.
- [ ] Add injected deadline/output/concurrency-budget tests and terminal outcome telemetry. HTTP 200 with stream failure must produce a failure outcome event.
- [ ] Run `bun run test`, `bun run test:database`, `bun run test:browser`, `bun run test:worker -- --backend supabase`, `bun run e2e -- --backend supabase`, `bun run typecheck`, `bun run guard:whole-repo`, build/bundle checks, lint and format. Include meaningful discovery assertions.
- [ ] Measure route bundle and a representative long-history update; report observations without claiming a benchmark from directory movement.
- [ ] Run the PR-budget command and create one PR. Do not redesign the auth facade or Google compute adapter.

## Handoff

Document public HTTP page changes and compatibility/version policy, remote host adapters, chosen model/default budgets, admission/replay semantics, generation telemetry and provider checks NOT RUN. Native consumers must validate schemas and get classified compatibility failures rather than silently misread envelopes.
