# Supabase web remote notes and chat turns

Prompt 04 consumes the request-local service graph frozen in
[`supabase-web-backend.md`](supabase-web-backend.md). Remote functions are web-host
adapters; native continues to use the named HTTP routes and portable feature service
facades.

## Web notes adapters

`/notes` calls the generated `listNotes` query during SSR in the Supabase profile, so
the first HTML response contains its first bounded page. The page composition uses a
host adapter over generated remote query/command wrappers for refresh, create, update,
and delete. The portable Notes feature imports no remote query object. The exported
`createNote` remote form validates inputs with Valibot; infrastructure and repository
failures remain server errors instead of being copied into client validation state.
Missing updates map to a typed not-found response. The SSR first page and each remote
refresh stop at 200 notes.

Cursor pages carry `items`, `nextCursor`, `hasMore`, and `serverTime`. Notes cursors
are opaque, owner-bound keys over `(updated_at,id)`; invalid or foreign cursors are
refused. The page size is 1–50, and the notes screen caps one refresh at 200 items.

## Chat page HTTP compatibility

The existing named `GET /api/chat/conversations/:id/messages` response remains the
`{ messages, serverTime }` envelope for native compatibility. Supabase returns its
current newest page there. Legacy behavior stays bounded at its existing history
ceiling. Web SSR loads the newest 50 messages directly from the service and renders
them immediately.

Older web history uses the additive named endpoint
`GET /api/chat/conversations/:id/messages/page?cursor=...`. Its strict DTO is
`{ items, nextCursor, hasMore, serverTime }`; pages are bounded at 50 and ordered by
`(created_at,id)`. The first page is newest, and older pages prepend. Message DTOs
carry optional `clientId` so retries can omit their persisted user turn from prompt
history; older DTOs remain valid during rollout. Native clients must validate schemas
and classify incompatible envelopes instead of treating unknown data as an empty
transcript. Native clients do not need to consume this endpoint. A future change to the existing HTTP envelope
requires a versioned endpoint or an explicit compatibility rollout; generated remote
function identifiers are never a native API.

Native continues to validate the existing schemas through its named HTTP facade. A
server that returns an unknown stream frame fails as a classified protocol error; no
consumer treats an unknown envelope as an empty transcript.

## Generation model and budgets

The explicit provider model is `@cf/meta/llama-3.1-8b-instruct-fp8`. Cloudflare lists
its context window as 32,000 tokens ([model limits](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/)). The adapter requests genuine SSE streaming ([Workers AI streaming](https://developers.cloudflare.com/workers-ai/configuration/bindings/)) and
caps provider output at 768 tokens; local output is also capped at 12,288 UTF-8 bytes.
Recent prompt history uses at most 20 messages and 24,576 UTF-8 bytes. Oldest history
entries are discarded to fit while preserving the new message. This app has no model
tokenizer and does not report a guessed token count as exact. The 45-second total
generation deadline is injectable in tests.

Owner concurrency is capped at two active generations by the transactional Postgres
admission function, serialized per owner across Worker isolates. The existing
five-per-hour owner admission quota includes failed/cancelled retries. Failed and
cancelled attempts are marked through `fail_chat_generation` and may be retried with
the same key; a retry uses the stable reply id and a fenced incremented attempt. An
admitted row older than 60 seconds can be reclaimed, and stale rows do not occupy the
two active-generation slots (the stream deadline is 45 seconds).

## Admission, replay, and telemetry

The canonical fingerprint binds content to `(owner,conversation,clientId)`. Admission
returns the stable reply id and one of these states:

- `admitted`: only this outcome starts the provider.
- `running`: HTTP 409 with `{ code, generationId, recoverable }`; retrying does not
  make a second provider call.
- `completed`: the stored user and assistant messages replay as valid terminal SSE
  frames, without another provider call.
- `conflict`: HTTP 409 when the same key carries different content.

Provider and persistence failures retain a valid terminal SSE error frame. Structured
`chat.generation.outcome` events record completed, failed, and cancelled terminal
outcomes with elapsed time and the conversation and generation ids. They contain no
prompt or generated text. HTTP 200 with a stream error is recorded as a failure
outcome. Admission conflicts and failures before streaming do not emit this terminal
event.

## Local size and traversal observations

In the production build used for Supabase E2E, the notes route client chunk was
30.50 kB (11.41 kB gzip), and the server `notes.remote.js` chunk was 3.99 kB
(1.48 kB gzip). The tied-timestamp local fixture traversed 537 persisted messages in
12 ms in one full unit run. These are single-run observations from local build and
SQLite fixture output, not performance benchmarks or a before/after claim.

## Verification limits

Deterministic fixtures cover provider stream decoding, delayed-response abort forwarding,
deadline/output limits, persistence failure, cursor tie ordering beyond 500 messages,
and SQL admission races. Hosted Workers AI cancellation and actual provider billing
cancellation are **NOT RUN**; the binding receives the abort signal and local
consumption/persistence stop after abort, but no exactly-once billing guarantee is
made. Run the Supabase preview lanes with:

```sh
bun run test:worker -- --backend supabase
bun run e2e -- --backend supabase
bun run test:database
```
