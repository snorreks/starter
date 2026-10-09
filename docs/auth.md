# Authentication and accounts

Supabase Auth is the only application identity provider. Supabase owns password verification, sessions, refresh tokens, email verification and recovery. Application user ids are UUIDs; old non-UUID account identifiers do not authenticate.

## Web requests

The web Worker verifies the access token on each request and creates a request scoped Supabase user client. Data API calls carry that token and rely on row level security. The Worker constructs the application identity from the verified Supabase user, never from a caller supplied owner id or user metadata.

Administrative operations use a separate server only service role client. It is limited to internal RPCs and maintenance paths. The service role key, Google dispatcher credential and Resend API key are secrets; they are never returned in DTOs, exposed in browser/native bundles or written to argv and logs.

Registration returns an unverified account, not an authenticated session. Verification
and recovery redeem local Auth links through PKCE callbacks. Password recovery
requires a verified session and a short-lived, HTTP-only marker bound to that same
user; a URL token alone cannot enable the form. Updating the password consumes the
marker and revokes refresh sessions globally. Already-issued access JWTs remain
valid until expiry; global sign-out is not immediate access-token revocation.

## Native requests

Native sign-in uses Supabase PKCE through the external browser and an exact callback allowlist. Bearer tokens are attached by the native transport. Credential persistence is opt in through the platform vault; otherwise the session is held in memory. Refresh is single flight, scoped to project and API origin, and logout prevents an in flight refresh from publishing credentials again. The former RFC 8628 device flow is removed; existing users must authenticate with the new Supabase identity.

## Authorization and abuse limits

RLS and transactional SQL enforce owner boundaries even when callers bypass the Worker and use the Data API directly. Chat and job admission counters update in transactions, so concurrent requests cannot overspend limits. Job attempts are fenced by attempt ids; stale retries cannot publish results. The local database lane tests two synthetic users, direct Data API denial, concurrent admission and retries.

## Email and local setup

Supabase Auth uses the configured mail provider for verification and recovery. Local Supabase captures mail in its Mailpit service, so tests can redeem real local links without external delivery. Hosted Resend delivery is an operator live check and remains NOT RUN until credentials and a hosted project are available.

Use `bun run setup:doctor -- --profile database` and `bun run test:database` for local prerequisites and verification. See [database package](../packages/backend/database/README.md), [docs/native.md](native.md), and [docs/secrets.md](secrets.md).
