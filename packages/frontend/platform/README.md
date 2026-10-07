# @starter/platform

The four capabilities a frontend host implements, and one reusable HTTP
transport that implements one of them.

## Purpose and runtime

`browser`-plane modules (`scripts/src/guards/policy.ts`). They load in a browser,
in a static SvelteKit bundle, and under Bun for the unit lane. They never run in
workerd, and nothing here may import `$app/*`, `@tauri-apps/*`, a Cloudflare
binding, or anything under `apps/` — `bun run guard` refuses each of those edges,
which is what lets a web page and a native shell consume the same feature package.

There is no state, no screen and no product logic here. Every export is either an
interface a host fulfils or a piece of mechanism more than one host needs:

| Export | What it is |
|---|---|
| `ApiTransport` | `request<T>(path, options)` — the seam between a service and the network |
| `HttpTransport` | The reusable implementation: base URL, headers, uniform `AppError` mapping |
| `parseDto` | Runtime validation of a response body against a Standard Schema contract |
| `Navigation` | `go(path)` — move the host to an application path |
| `ExternalBrowser` | `open(url)` — hand a URL to the user's own browser |
| `SessionStore`, `MemorySessionStore`, `SessionScope`, `SessionCredential` | Where a credential lives between launches |

## Setup and configuration

None. Nothing here reads an environment variable, and no host configures it:
`HttpTransport` is constructed by the composition root of the host that uses it —
`apps/frontend/client/src/lib/composition/transport.ts` today, a native
composition root later. Credentials mode, base URL and default headers are
constructor arguments, so the decision is visible where it is made rather than
implied by a module singleton.

## Commands

All run from `packages/frontend/platform`; the root `bun run <name>` reaches the
same script through Moon.

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # biome
bun run format      # biome, verified not applied
bun run fix         # biome --write
bun run test        # bun test
```

The tests here are the proof that this package needs no application runtime: they
construct a transport with an injected `fetch` and assert on recorded calls, and
nothing in the file imports Svelte, SvelteKit or a host bridge.

`SessionCredential` is the version 1 record: `accessToken`, `refreshToken`,
`expiresAt`, `accountId`, `supabaseProjectRef`, and `apiOrigin`. The store key
also includes the environment, so environment scope does not add another field to
the persisted record. `MemorySessionStore` remains the default and writes nothing
to browser storage.

## Validation and artifacts

`bun run test` is the lane. It covers the three claims a transport makes — uniform
error classification, credentials as a per-call decision, and what a call's options
actually put on the wire — plus the scope isolation a `SessionStore` promises. No
artifact is produced; this package compiles into its consumers.

## Boundaries

May import `@starter/schemas`, `@starter/utils` and `@standard-schema/spec`. May **not** import:

- `@sveltejs/kit`, `$app/*` — the host's router is injected as `Navigation`
- `@tauri-apps/*` — that belongs to a native composition root's bridge role
- `@starter/database`, `@starter/auth`, `drizzle-orm`, `better-auth` — server
  implementation, refused by Biome's frontend override
- `apps/**` or `scripts/**` — a package reaches an application through a published
  export or not at all

Ports live in `@starter/utils` (`AppError`, `errorTypeForStatus`, `BaseClass`),
because the CLI and the server classify errors the same way and three copies of a
status-code table would drift. Canonical guides: [docs/architecture.md](../../../docs/architecture.md),
[docs/testing.md](../../../docs/testing.md).
