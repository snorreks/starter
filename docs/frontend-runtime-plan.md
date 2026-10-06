# Frontend runtime implementation

Implements the direction in [the architecture review](frontend-architecture-review.md).
Keep feature-local services and view model classes; composition owns host policy.
Use composition rather than restoring the Aikami inheritance chain.

## Contracts and order

1. Transport: introduce `StreamingTransport.openStream`, share HTTP request/status/body
   normalization across JSON, bytes and streams, and enforce native bearer policy.
   Verify captured requests, HTML errors, malformed envelopes and body cancellation.
2. Runtime: add a single-use `ScreenScope` owning cancellation and late cleanup, and
   a reactive `AsyncOperation` with explicit single-flight or concurrent policy.
   Unmount disposes immediately. Verify deferred initialization and overlapping writes
   in real Svelte, not only stubbed-rune unit tests.
3. Features: migrate chat and notes to the runtime and narrow service contracts.
   Conversation creation returns tagged commit/navigation outcomes and refuses overlap.
   Notes renders actionable errors and forwards cancellation for every mutation.
4. Reconciliation: authoritative snapshots invalidate reads; preserve acknowledged local
   creates until observed, pending deletes until settled, and transcript drafts/queues.
   Defer transcript refresh while a turn is active, then merge by stable server identity.
5. Stream protocol: discriminated events, bounded incremental parser supporting LF/CRLF,
   reader cleanup, terminal-only retention by default and targeted reply updates.
6. Clarity: rename nonreactive clients, correct overstated comments, document placement
   and runtime rules, and enforce transport and feature dependency boundaries with fixtures.
7. Validation: unit suite, browser suite, typecheck, lint/format, guards, build/bundle,
   Worker and E2E lanes. Record missing prerequisites and exact remaining commands.
   Review the complete diff, commit and open a PR into main.

## Growth decisions

Cache, package extraction and animation-frame batching require measured consumers or
performance evidence. This change does not claim benchmark improvements. Pagination
must have a server/client contract and browser behavior; inspect current limits before
deciding whether a bounded follow-up is necessary. No unconditional retries for a lost
conversation-create response: cancellation/network failure can mean unknown commitment.

## Review focus

- Native null tokens and mixed-case authorization in all response modes.
- Body failures after headers; cancellation while waiting for stream chunks.
- Unmount before initialization settles and cleanup acquired after disposal.
- Successful create followed by rejected navigation, snapshot/read/write races.
- Refresh during streaming, same-conversation refresh, preserved unsent queue and drafts.

## Execution record

User authorized implementation and a new PR. Work proceeds inline on
`fix/frontend-runtime-contracts`; the original untracked review is included unchanged.
