# Authentication

Email and password, and nothing else. One provider, one credential, one session.
This document is the scope note for that: what the account lifecycle does, what it
refuses, and where each decision is enforced.

It is a *guide*, not a reference for the library. Better Auth's own documentation
describes Better Auth. What follows is the part a reader of this repository cannot
get anywhere else: which of its behaviours this application depends on, and what
happens when one of them changes.

## The lifecycle

| Step | Route | What happens |
|---|---|---|
| Sign up | `/login` (`?mode=sign-up`) | Account created, **no session**, verification mail sent |
| Verify | `/verify-email` | Address confirmed. **Not** a sign-in |
| Sign in | `/login` | Session cookie set |
| Recover | `/forgot-password` | Recovery mail sent, to any address |
| Reset | `/reset-password?token=` | Password replaced, **every session revoked** |
| Sign out | any page | Session deleted |

Two of those are deliberate and both are load-bearing.

**Sign-up does not sign anyone in.** `autoSignIn` is off, because the address is
unconfirmed and an unverified account that can reach the notes screen is a product
that says "we will confirm your address" and then does not.

**Verification does not sign anyone in either.** A verification link proves control
of an address; it is not a credential. `/verify-email` therefore never establishes a
session, and the user signs in afterwards like anyone else.

## Where each rule is enforced

Ownership is a *server* rule. The browser is not trusted with it, and a client that
lets you pick a note's owner would be a client whose counterpart has to be guessed.

| Rule | Enforced in | How |
|---|---|---|
| The caller is signed in | `src/lib/server/request_context.ts`, via `hooks.server.ts` | Session resolved per request into `locals.user` |
| A note belongs to its owner | `src/lib/server/notes_service.ts` | `ownerId` is a parameter, never part of the input; the predicate is in the query |
| A body cannot name its owner | `api/notes/+server.ts` | `additionalProperties: false`; a client-sent `ownerId` is a 400 |
| Verification is required | `packages/backend/auth/src/lib/better_auth.ts` | `requireEmailVerification: true`, unconditionally |

The last row has no flag. An earlier draft had one, so that a deployment could turn
verification off. A setting whose value changes whether accounts work, that exists
only so somebody can make accounts not work, is a setting nobody will audit.

`locals.user` is rebuilt from the request on **every** request. A Worker isolate
serves many concurrent requests, so anything cached at module scope is one user's
identity leaking into another's response. `bun run guard` fails a module-level
`let user`/`session`/`env` for exactly this.

## Rate limiting

The limiter is a D1 table, not a map in the isolate, because an isolate-local map
gives every user their own bucket and resets on every deploy.

`rateLimit.storage: "database"` — Better Auth's own database mode — **does not work
in this version**, and the reason is worth recording so nobody "simplifies" it back:

- its generated `rateLimit` table has no primary key;
- `@better-auth/drizzle-adapter`'s `incrementOne` returns `null` for a row with no id;
- Better Auth's `consume` recurses on that `null` without a bound.

So the storage is `customStorage`, implemented in
`packages/backend/database/src/lib/d1_rate_limit.ts` as **one** statement:

```sql
INSERT INTO rate_limits (key, count, last_request) VALUES (?, 1, ?)
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN last_request < ? THEN 1 ELSE count + 1 END,
  last_request = CASE WHEN last_request < ? THEN excluded.last_request ELSE last_request END
RETURNING count, last_request
```

One statement, because a read-then-write is a race: two concurrent requests both
read `count = 4`, both write `5`, and one of five attempts is never recorded. D1
serializes writes to a row, so the compare-and-set has to happen *in* the statement.

Two details in that SQL are decisions, not formatting:

- **A refused attempt still increments.** The verdict is `count <= max`, so refusing
  at `count === max` and refusing at `count === max + 1` are the same answer — but the
  row has to say which one it was, or the boundary is unobservable.
- **`last_request` is not advanced on a refusal.** Otherwise hammering extends one's
  own lockout, and the window never closes while someone is still trying.

The prune cutoff is a flat 24 hours of row age, deliberately **not** `now - windowMs`.
A short rule reaping a long rule's row would let a burst on one endpoint reset
another endpoint's counter.

Per-path budgets come from `AUTH_RATE_LIMIT_MAX` and `AUTH_RATE_LIMIT_WINDOW`; sign-in
and sign-up are the two paths with their own rules, because they are the two worth
brute-forcing.

### Client addresses

The rate-limit key is the client IP, so the IP header is only trusted where it is
actually the ingress's. `resolveAuthRateLimitIngress` trusts **nothing** locally, and
in a deployed environment trusts `cf-connecting-ip` — adding `x-forwarded-for` only
when the operator names the proxies in `TRUSTED_PROXIES`. A forwarded header is a
claim made by whoever sent the request, so a per-IP limit keyed on a spoofable
address is a per-IP limit the caller chooses.

When no address can be resolved, Better Auth falls back to one shared per-path bucket
and logs a warning at startup. That warning is the fallback working, not a failure;
it is also the correct behaviour, since an unresolvable address must not become an
unlimited one.

## Mail

One capability, two transports, chosen by deployment mode:

| `DEPLOYMENT_ENV` | Transport | Requires |
|---|---|---|
| `local` | `capture_transport.ts` | nothing |
| anything else | `resend_transport.ts` | `RESEND_API_KEY` **and** `MAIL_FROM` |

**Local always captures, even if `RESEND_API_KEY` happens to be set.** A stray key in
a shell profile must not turn a developer's run into real mail; that is how a test
suite starts mailing real people.

**Non-local without both variables throws from `getContainer`.** Not a warning, not a
fallback to capture: the sign-up screen would otherwise report a successful sign-up
for an account whose verification mail was never sent. Failing at container
construction means the deploy is visibly broken instead of quietly unusable.

`/api/dev/mail` exposes the capture inbox. It is **local-only** — it answers `403`
outside a local environment, deliberately named rather than disguised as a 404, and it
is `GET`-only, so it cannot be used to make the application send anything. Every
response carries the `TEST_RUN_ID` it is scoped to, so a message from an earlier run
cannot be mistaken for a fresh one.

## What the tests do and do not prove

`bun run test:worker` drives the built Worker in real workerd against real local D1
(36 tests). `bun run e2e` drives a real browser against that Worker (26 tests),
including a context with **scripting disabled**, because the form action is the only
sign-in path available to a browser that never runs a script.

Three things are **not** verified, and the capability matrix says so too:

- **No real mail was sent.** Every message went to the capture inbox. Resend delivery,
  its SPF/DKIM posture and its error shape are unverified.
- **No rate limit was observed under genuine concurrency** beyond the parallel
  requests in `d1_rate_limit.test.ts`; the atomicity argument rests on D1's documented
  serialization, not on a load test.
- **`bun run test:browser` is blocked** by the runner's Chromium launch, which is not
  this feature's to fix. See the capability matrix for the exact requirement.

## Two things that will surprise you

**Verification tokens are replayable within their hour.** They are signed JWTs, and
Better Auth accepts a second use. Recovery tokens are single-use. Asserting
single-use verification would be asserting a behaviour the library does not have;
`auth_lifecycle.test.ts` asserts what actually happens instead — the replay is
idempotent and issues no session.

**`getSession` answers 200 with a literal `null` for a revoked session.** Revocation is
therefore asserted through `/api/notes` returning 401, because a null body and an
unauthenticated request look identical at the `getSession` boundary.

## Changing any of this

- Migrations have one authority: `packages/backend/database`, and `bun run
  db:generate` is the only way to make one. Do not edit an applied migration.
- `apps/frontend/client/src/lib/server/container.ts` is where auth, mail, the rate
  limiter and trusted origins are wired. It is the composition root for the server
  half; adding a dependency there means adding it deliberately, not transitively.
- The feature's browser half is `src/lib/features/auth/`. It is a plain class plus a
  composition function — see [adding-a-feature.md](adding-a-feature.md) for why there
  is no base class to extend.
