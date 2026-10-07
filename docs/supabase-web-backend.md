# Supabase web identity and application services

Prompt 03 adds an explicit local preview backend while retaining the legacy
Better Auth/D1 default. Prompts 04, 05 and 06 should consume these request context
and identity contracts instead of resolving identity or constructing database
clients independently.

## Frozen APIs

`@starter/auth/supabase` exports:

```ts
createSupabaseIdentityResolver(
  config: SupabaseIdentityConfig,
  fetcher?: SupabaseFetch,
): SupabaseIdentityResolver

interface SupabaseIdentityResolver {
  getVerifiedIdentity(request: Request, cookies: RequestCookies): Promise<VerifiedIdentity | null>
}
```

`VerifiedIdentity` is `{ backend: 'supabase'; user: { id, email, displayName,
emailVerified }; accessToken: string }`. The access token is server only. For a
bearer request, `auth.getUser(token)` validates the token with Auth. For SSR,
`auth.getUser()` validates the request cookie session before the user token is
used. Invalid, expired, malformed, or incomplete identities return `null`.

`apps/frontend/client/src/lib/server/supabase_context.ts` exports:

```ts
createApplicationServices(identity: VerifiedIdentity, config: SupabaseWebConfig): ApplicationServices
createSupabaseRequestContext(request: Request, cookies: Cookies, config: SupabaseWebConfig): Promise<SupabaseRequestContext>
createSupabaseAuthClient(config: SupabaseWebConfig, cookies: CookieMethodsServer): SupabaseClient
applySupabaseResponseHeaders(response: Response, headers: Headers): Response
```

The services graph is request scoped and contains user RLS clients for notes,
chat and jobs, a separate admin client for server-only operations, and the account
service. Composition rejects an identity whose `backend` is not `supabase` with
`Refusing to compose Supabase services from a different backend identity.` The
request hook records SSR refresh cookies and cache headers on that same response.
Authenticated pages and APIs are `private, no-store`.

The Supabase account service methods are `signUp({ email, password, name })`,
`signIn({ email, password })`, `signOut()`, `requestPasswordReset({ email,
redirectTo })`, `resetPassword({ newPassword })`, `sendVerificationEmail({ email
})`, `changeEmail({ email })`, and `deleteAccount(identity)`. Email changes use
Supabase `updateUser({ email })`; the local Auth configuration has
`double_confirm_changes = true`, so the old email remains active until both
confirmation messages are followed. Account deletion uses the separate
administrative Auth client and requires a Supabase identity.

## Backend selector and local mail

The legacy profile remains the default. Select preview with
`STARTER_BACKEND_PROFILE=supabase`; it requires `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Missing settings fail with
`Supabase preview configuration is incomplete: <names>.` An unknown profile fails
with `STARTER_BACKEND_PROFILE must be legacy or supabase`. The root wrapper
consumes `--backend legacy|supabase` before invoking Moon. Supabase selection is
accepted only for `client:test-worker` and `e2e:e2e`, and forces an uncached run.
Each run allocates an owned local Auth/Postgres/Mailpit stack; a lock serializes
the short-lived `.dev.vars` binding file when two preview commands overlap.

`/api/dev/mail?to=<address>` adapts Mailpit's local capture API and is only enabled
for the local deployment. It returns `{ inbox, messages: [{ id, to, subject,
text, capturedAt }] }`; capture lookup errors return a named `mail_unavailable`
response. Email verification and recovery links return through `/auth/callback`.
Only the exact relative destinations `/verify-email` and `/reset-password` are
accepted. Other callback destinations redirect to `/login?error=invalid_callback`.
Sign-up, verification resend and recovery-request responses do not disclose
whether an address exists.

## Jobs capability

Preview admission and status use Prompt 02's transactional Postgres admission
function and owner-scoped Supabase RPC reads. A newly admitted row is marked
`dispatch_failed` with `dispatch_disabled_pending_prompt_06`; the HTTP response
remains the existing `202` job DTO and status reads remain owner scoped. There is
no compute dispatch or output in this prompt. Prompt 06 owns enabling dispatch.

## Commands and verification status

```sh
bun run test:worker -- --backend supabase
bun run e2e -- --backend supabase
bun run test:database
```

The Worker command selects tests named `Supabase preview` in the built Worker
integration harness. The E2E command selects the browser notes/auth journey and
uses local captured verification mail. Stack resources are created and removed
under a run-specific ownership record. External SMTP and hosted Supabase Auth
checks are **NOT RUN**; this preview uses the local Auth and Mailpit stack only.
