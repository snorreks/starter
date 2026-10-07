# Supabase, Cloudflare, and portable application contracts

Status: proposed execution design, requested by the user; no application migration or remote changes performed. Inspected base: `71c2d9c` on `feat/e2e-visual-quality`, 2026-10-07. Execution must refresh this inventory. Existing untracked `docs/plans/` and concurrently staged frontend/runtime edits belong to other work and must not be included or overwritten by these planning changes.

## Intent and scope

Build one reusable starter with Supabase Auth/Postgres, Cloudflare SvelteKit SSR/API and R2, Resend mail, Tauri, production chat boundaries, and optional Cloud Run processing. Keep portable features, request-local identity, one application service implementation, real-runtime tests, bounded operations, and one resolved deployment target. Experimental remote functions and Tauri mobile are acceptable.

Deliver the migration in eight independently reviewed PRs, each in its own Herdr worktree and with at most 99 changed paths. Prefer substantial cohesive prompts over many small PRs. Do not rename application roots during this migration: a move would consume the review budget without improving the provider integration.

This is a starter replacement, not an automatic migration of live accounts/data. Never delete remote D1 databases, Workers, identities, or buckets. If live data exists, preserve its deployment and produce a separate export/import and user-account migration decision before switching it. New Supabase user identities are UUIDs; do not preserve the old user-id validation pattern accidentally.

## Schema decision

Use Valibot for first-party application DTOs, input validation, environment/registry validation, and web remote functions. Preserve exported contract/type names and strict unknown-key rejection. Use `InferOutput` for parsed values and `InferInput` where a form intentionally transforms its input. Wire contracts do not coerce, strip keys, apply defaults, or transform values implicitly.

TypeBox remains at Pi SDK tool-registration boundaries where the host requires TypeBox/JSON Schema. This is an explicit external interface exception, not a second definition of application DTOs. Export JSON Schema for Rust/tool interoperability only when a real consumer needs it, using a pinned conversion package and compatibility fixtures. Do not add Zod alongside Valibot for application contracts.

Evidence and limitations: [schema selection](../../reviews/2026-10-07-schema-selection.md). The local synthetic comparison supports this recommendation; it does not establish production workerd throughput or whole-app bundle savings.

## Backend and identity

SQL migrations are the database authority. Generated Supabase types are derived artifacts; Valibot DTOs describe public operations. Explicit repository projections map database rows to DTOs. Use `supabase-js` over HTTPS initially; multi-statement application changes use transactional SQL RPCs. No Hyperdrive, direct Postgres runtime connections, or general Supabase Edge Functions are required initially.

Supabase clients for users are request-scoped and carry verified user access tokens. Administrative/maintenance clients are separately constructed and inaccessible to browser/native bundles. The Worker verifies tokens using supported Supabase APIs and preserves token-refresh response headers and cookies. Membership/ownership authorization lives in policies and transactional operations, not in unverified client metadata or supplied owner ids.

The Supabase Data API is independently reachable. Enable RLS and least-privilege grants for exposed relations. Data integrity, lengths, legal transitions, idempotency, and paid-action admission must hold when the Worker is bypassed. Internal tables use a non-exposed schema. Any privileged RPC has a fixed search path, explicit execution grants, authenticated identity checks, and concurrent negative controls.

Use `auth.users` plus an application profile table, not a second password/session implementation. Preserve verification, recovery, logout, account deletion, and enumeration-resistant responses. Keep Resend as Supabase custom SMTP and for application mail; local tests use the local mail capture service.

Native uses Supabase PKCE with an external browser and allowed callbacks/deep links. Persist a versioned access/refresh/expiry credential record only through the opt-in secure store; otherwise memory. Scope credentials by environment, Supabase project, API origin, and account. Refresh is single-flight; logout invalidates pending refresh publication and clears persisted state. Do not claim the old RFC 8628 device flow is unchanged.

## Staged compatibility

While PRs 02–07 land, preserve the current default deployment. A temporary explicit `STARTER_BACKEND_PROFILE=legacy|supabase` selects complete identity and data wiring, never Supabase identity with D1 user data. The Supabase preview profile must have its own mandatory integration checks; it cannot silently fall back when missing configuration.

PR 08 makes Supabase the sole application backend and removes this selector, Better Auth, D1 application bindings, legacy migrations/tests/commands, and Cloudflare Container code. Do not create permanent parallel provider implementations. No required lane may pass through an empty suite or blanket skip.

## Shared operation contracts

Keep frontend features dependent on narrow services. HTTP routes and web remote functions delegate to the same server operation; server loads call it directly. Application operations accept verified identity/context, not a framework request.

The database foundation exports these adapters from `@starter/database/supabase`:

```ts
createUserDatabaseClient(config: SupabasePublicConfig, accessToken: string): SupabaseClient<Database>
createAdminDatabaseClient(config: SupabaseAdminConfig): SupabaseClient<Database>
createSupabaseNotesRepository(client: SupabaseClient<Database>): NotesRepository
createSupabaseChatRepository(client: SupabaseClient<Database>): ChatRepository
createSupabaseJobRepository(client: SupabaseClient<Database>): JobRepository
```

`NotesRepository` exposes `list(ownerId, page)`, `create(ownerId, input)`, `update(ownerId, id, input)`, and `remove(ownerId, id)`. `ChatRepository` exposes owner-scoped conversations/messages and transactional generation admission/completion. `JobRepository` preserves the existing admission, lease, fencing, completion, failure, and retirement semantics. Export concrete DTO/page types with these interfaces. Preserve old external operation behavior while adapters are introduced; pagination additions are coordinated through PR 04.

PR 03 exports `getVerifiedIdentity(request, cookies)` and `createApplicationServices(identity, config)`, and fixes the `SessionState`/`AccountService` facade contracts used by PRs 04 and 05. Record their exact implemented signatures in its handoff before dependent work begins. Do not make dependent agents infer these contracts from prose.

## Web/native communication

Use remote `query`, `form`, and `command` for web notes/query/form interactions. Keep remote query objects in the web host, out of portable features. Keep versioned HTTP endpoints for native, chat streaming, job status/output, upload admission, and webhooks. Never make native depend on SvelteKit's generated remote endpoint identifiers.

Add an explicit `remote-module` role for `*.remote.ts` to architecture/import policy. Its server execution may reach server services; emitted browser wrappers may not expose server code or secrets. Test both source rules and emitted artifacts. Validate remote arguments with native Valibot Standard Schema, and validate public operation output explicitly.

## Chat correctness

Generation is a persistent turn keyed by owner/conversation/client id, with a canonical content fingerprint, stable reply id, state, and fenced attempt. Same key and changed content returns conflict; completed retry returns the stored result; in-flight retry does not start another provider call. Two concurrent clients must not independently admit the same turn. No guarantee of exactly-once provider billing is made.

Bound prompt history, output bytes/tokens, active generations, owner admission, and total generation deadline. Configure the model explicitly, stream provider chunks, propagate cancellation when supported, stop local consumption after abort, and record completion/failure/cancellation separately from HTTP status. Use an existing binding that truly streams, or one maintained provider adapter if its transport gives the required control; no multi-provider fallback framework in this change. Live cancellation/billing behavior remains NOT RUN until measured against the selected provider.

Cursor pages have `items`, `nextCursor`, `hasMore`, and `serverTime`; size is bounded. Notes/conversation cursors order by `(updated_at,id)`; message cursors by `(created_at,id)`. Load the latest message page and prepend older pages; never silently return only the oldest 500 messages. Keep schema maximums and deterministic tie handling.

## Compute and maintenance

Retain Cloudflare Workflows as the sole durable orchestration owner initially. Postgres owns job/attempt state. Cloud Run Jobs owns process execution; R2 owns bytes. Supabase Cron owns bounded database-only housekeeping. Do not introduce a second queue/orchestrator simultaneously.

Cloud Run Jobs execute a finite runner around the existing Rust `encode` entrypoint, not its HTTP `serve` mode. Runtime arguments contain only opaque job/attempt identifiers. The runner obtains a Google-issued identity token from the platform metadata endpoint, requests narrowly scoped input/output grants from a Worker-owned internal endpoint, and uses expiring signed R2 URLs. The Worker verifies issuer, audience, service-account subject, attempt state, and expiry before issuing grants. The runner has no Supabase secret or persistent R2 credential. Terminal artifact acceptance remains fenced and integrity-checked by the Workflow.

Dispatch is a bounded Google Jobs API adapter with injected OAuth token acquisition. Initial runtime token acquisition may use an explicitly configured least-privilege dispatcher service-account secret, exchanged for short-lived tokens; do not put its value in argv/logs/artifacts. Record that operational tradeoff. Workload identity federation can replace it when configured and tested; do not pretend a cross-cloud identity integration is already provisioned. Restrict dispatcher permissions and runner identity to their distinct jobs.

Preserve cancellation, stale-attempt rejection, recovery of dispatch/recording failures, retention, and max attempts. A cancellation acknowledgement is not proof that the process stopped. Optional compute may be disabled explicitly; requesting enabled compute without prerequisites fails nonzero.

## Deployment and local execution

Extend `resolveTarget(environment)` to cover Supabase project/API/auth origin, Cloudflare web/jobs/workflow identities, R2, Google project/region/job/runner/dispatcher identities, artifact image, protocol, mail sender, and native callback/API configuration. Distinct staging and production targets are mandatory. Plan is offline; authenticated preflight is read-only; provisioning and applying are explicit.

Local Supabase is a real containerized stack. Each concurrently active worktree gets a distinct project id, API/database/Studio/mail ports, and owned lifecycle. Reuse checkout-derived allocation where possible; do not use stale `API_PORT`/`E2E_API_PORT` instructions from the Herdr skill. The current application uses `PORT` and the E2E harness owns `E2E_APP_PORT`/run allocation. Missing Docker is named and nonzero for integration lanes; pure unit tests stay credential-free.

## Review and completion

Hard cap: 99 changed paths per PR, including additions, deletions, generated files, and review fixes. Target 85 or fewer. Count against the actual PR base after rebasing, conservatively counting renames as delete+add. Do not exclude files from CodeRabbit to evade the cap. Repeated edits to one path count once. If a cohesive change cannot fit, split before publishing; the eight-PR count is an estimate, not permission to violate the cap.

Every prompt creates one worktree and one PR. Read Herdr's current help, supply repo `--cwd`, use `--no-focus`, and record returned paths/ids. Do not control somebody else's panes. Install dependencies per worktree. Dependent work starts from merged predecessors. Parallel implementations have separate checkouts; merge shared manifest/lock changes sequentially and regenerate locks through pinned tooling.

Completion requires fresh required lanes, synthetic two-user RLS tests, old-native/new-server compatibility, full auth journeys, retry/cancellation races, real local compute boundaries, deployment fixture boundaries, bundle secret checks, and fresh template smoke. Provider cloud execution, delivered SMTP, and physical mobile tests require their live prerequisites and remain honestly recorded as NOT RUN otherwise.
