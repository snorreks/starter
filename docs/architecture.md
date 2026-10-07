# Architecture

One application. One Worker. One origin. This document is the canonical record of
that, and of why each pin and each boundary exists.

The two things it is most useful for: deciding where new code goes, and knowing what
a local command actually proves.

## The shape

```
packages/shared/*     schemas, logger, utils      no project dependencies
packages/backend/*    database, auth, jobs        -> shared
packages/frontend/*   ui, platform, features      -> shared
apps/frontend/client  ONE SvelteKit app           browser + Worker in one package
apps/backend/jobs     the jobs Worker             workerd: Workflows, container, maintenance
apps/backend/media    the FFmpeg processor        Linux: a container image, reached over a port
apps/e2e              Playwright                  -> shared
scripts, .pi          tooling                     -> shared
```

### Why compute is a second Worker, and why it has no API

`starter-web` owns the public router, the session and the authorization check.
`starter-jobs` owns the Workflows, the container Durable Object and the hourly
sweep. The split is what makes the access boundary checkable:

* **The jobs Worker has no HTTP route.** Its default handler answers 404 to
  everything. The jobs API is `POST /api/jobs` on the *web* Worker, where the
  session exists, and it reaches the compute half through a cross-Worker workflow
  binding — no public path, no second origin, no second auth surface.
* **Compute cannot read a session.** The jobs Worker would need the session tables
  only to know whose job to run, and it gets that from the job row instead. Its
  maintenance step reads `sessions` and `rate_limits` by *bounded deletion*, which
  needs no identity.
* **The container holds nothing.** `EncodeContainer`'s type declares no `DB` and no
  `MEDIA`; the FFmpeg container it starts has no credential, no R2 key and no route.
  Bytes go out on a request and come back on a response.
* **The reusable parts are not owned by either.** `packages/backend/jobs` holds
  admission, fencing, the dispatch port and the maintenance services, so the web
  Worker and the jobs Worker both use them and neither imports the other.

The rule that keeps this from being aspirational: `bun run guard` classifies
`apps/backend/jobs/**` as worker plane and its `scripts/` and `tests/` as Node, and
refuses a jobs Worker that imports `apps/frontend/client/**`.

### One screen, two hosts, one composition root

`packages/frontend/features` holds the notes screen and the reusable half of the
account screen; `packages/frontend/platform` holds the four contracts a host
implements (`ApiTransport`, `Navigation`, `ExternalBrowser`, `SessionStore`). The
web application composes them in `apps/frontend/client/src/lib/composition/`; a
static native bundle will compose four different answers and change nothing else.

Three rules make that hold rather than merely sound true, each enforced twice:

- **A feature imports contracts, never a host.** `$app/*`, `@tauri-apps/*`, a
  Cloudflare binding, `apps/**` — refused by Biome's frontend override and by
  `bun run guard`.
- **A service validates its answers.** `parseDto(schema, body, …)` against the
  same Standard Schema contract the server validated with. `request<Note[]>` compiles
  identically whether the answer is notes or an HTML error page, and the mistake
  used to surface as "you have no notes yet".
- **Identity is per request, never module scope.** `SessionState` is constructed
  by the host's composition root, not by the shared package. A module-scope
  instance would be one object for the whole Worker isolate, so two concurrent
  SSR requests would render whichever arrived last.

Progressive enhancement stays where the server plane can reach it: the form
actions behind `/login`, `/forgot-password`, `/reset-password` and
`/verify-email`, their origin and rate checks, and the SSR redirects. `AuthView`
takes a `progressive` boolean so the same controls render with or without a form
action, rather than the shell pretending it has one.

### The roots the policy already owns

Four more roots are classified in `PLANE_PLACEMENTS` before they hold a file, because
this round adds them next:

| Root | Plane | What makes it different |
|---|---|---|
| `packages/frontend/features/**` | browser | The View / ViewModel / service layers, in a package two hosts share. The role rules match it and the web app's own feature directory with one pattern, so a file cannot be a View in one and a plain module in the other |
| `packages/frontend/platform/**` | browser | Contracts and injected transports. No component, no screen state, so no feature role is claimed — and no platform implementation leaks into `packages/shared` |
| `apps/frontend/native/**` | browser under `src/`, Node elsewhere | A static SvelteKit bundle. Its `src/lib/platform/**` is the `native-bridge` role, the one place `@tauri-apps/*` may be named |
| `apps/backend/jobs/**` | worker | A scheduled Worker reached through bindings, not through a route adapter |

`packages/backend/jobs` (the D1 job state, its admission budgets, its attempt
fencing, and bounded maintenance) is classified by the existing `^packages/backend/`
row rather than a new one. It is a backend package rather than a folder inside the
web application because the jobs Worker that will run the maintenance sweep — a
project that does not exist yet — has to reach this code without importing
SvelteKit, and the web app is the only thing that would drag it in. Its README
states the state machine, the fencing rules, and which half is still missing.

Two properties are deliberate. There is **no** blanket entry for an application
directory, so an application nobody has heard of is reported as unclassified rather
than inheriting a plane from where it sits. And the Tauri API is confined by *role*,
not added to the browser plane's capabilities — a static bundle and the web app run
the same JavaScript in different hosts, and only one composition root of one
application has the API object.

Rust is outside the TypeScript graph by construction: the source extensions are `.ts`,
`.tsx` and `.svelte`. A crate is a *project* — it owes a README — and its source is
validated by Cargo in its own lane. Full details and the measured guard cost are in
[docs/lint.md](lint.md).

The dependency direction is one-way, and two independent mechanisms enforce it:
Biome checks import statements as written, and `bun run guard` resolves the real module
graph and checks what those imports actually reach. Neither is sufficient alone — Biome
cannot see through a re-export, and a guard cannot see a `// TODO` in a comment.

**The rule behind it: shared code must be portable.** It runs in a Worker, in a
browser, and in Node tooling. The moment `packages/shared/utils` imports
`drizzle-orm`, that import is either dead code in two of those three places or a
runtime failure in one.

**And a workspace boundary is a declaration, not a folder.** A relative path that
leaves its own package skips the `exports` map and the dependency list at once, so
`../../scripts/src/shared/paths.ts` is refused: publish the subpath, declare the
dependency, import by name. The rule is stated over runtime edges, and the reason is
written down rather than implied — TypeScript erases an `import type`, so a type-only
edge cannot reach a bundle; the compile-time coupling it does create is owned by the
server-type-only rule.

Exactly two pairs are exempt, each declared with its reason in
`CROSS_WORKSPACE_RELATIVE_EXEMPTIONS`, and each checked for staleness: `apps/e2e` ->
`scripts`, because the Playwright harness and the tooling it configures are one Bun
process and the harness should exercise the real path resolution rather than a copy;
and `apps/frontend/client` -> `scripts`, because the Vitest config resolves the
browser executable before any application module is loaded, in Node. Delete the last
import that uses a row and the guard reports the row, the same way a Node-only
declaration is reported when its subpath stops being published. The plane rules narrow
both rows further — a shipped browser module reaching `scripts/` is already a
`plane-reachability` violation — so nothing unsafe is granted by the exemption itself.

### Two runtimes in one package

`apps/frontend/client` is the only application, and it holds two runtimes:

| Half | Runs in | Reached by |
|---|---|---|
| Components, ViewModels, client services | the browser | `src/lib/**`, `+page.svelte`, `+layout.svelte` |
| Routes, services, auth, D1 | workerd | `src/lib/server/**`, `+server.ts`, `+*.server.ts`, `hooks.server.ts` |

The boundary between them is a path, and `PLANE_PLACEMENTS` in
`scripts/src/guards/policy.ts` is the single place that says which path is which. The
Worker half is `src/lib/server/**`, `src/hooks.server.ts`, and the three route adapter
shapes SvelteKit compiles into the Worker. Everything else in `src/**` is browser code,
and a `+page.svelte` is deliberately not on the list, so the components beside a
`+page.server.ts` keep the browser-only permission set.

### How the guard enforces it

Five files, one responsibility each:

| File | Owns |
|---|---|
| `scripts/src/guards/policy.ts` | The architecture as data: four planes, the 4×4 reachability matrix, runtime capabilities and the roles that may hold them, the declared exemptions, and the generation policy. Every row carries the reason it exists. |
| `scripts/src/guards/module_graph.ts` | The real graph. TypeScript parses `.ts`, Svelte locates the script blocks in `.svelte` and TypeScript reads those, and every specifier is resolved through the owning project's own `tsconfig.json` and through each workspace package's `exports` map. Also the source walk, and the one predicate that needs I/O: a Cargo target directory, recognised by the manifest beside it rather than by its name. |
| `scripts/src/guards/guard_architecture.ts` | Seventeen rules over that graph, each producing a diagnostic that names the source, the target, the dependency chain, the rule, and the ownership the code should move to. |
| `scripts/src/guards/project_discovery.ts` | Which directories are projects: Bun workspace globs, Moon projects, and first-party `Cargo.toml` files. Imported by the README guard *and* by `guardDocumentedPaths`, so "a project" is one definition rather than two. |
| `scripts/src/guards/guard_readmes.ts` | That each of them answers the five questions a README owes. |

The rule added this round is the one the others were blind to. `ruleDeclaredDependencies` and `rulePackageExports` both read a package's
declarations, and both are written against *package* specifiers — so a relative path
out of a workspace skipped both of them simultaneously. It is a rule about the
boundary rather than about relative paths: within one package a relative import is
how modules are written, and every other rule still checks those edges.

What this replaced, and why it mattered: the previous guard read import statements out
of source text with a regular expression and matched the resulting specifiers against a
list of package names. It could not see a re-export, a relative path that climbed out
of its own layer, a subpath that bypassed a package's `exports`, or a resolved alias —
so a boundary documented as uncrossable was crossable four ways, and the list had no
way to report that.

The properties worth knowing:

- **Transitive, not just direct.** A browser module that imports a portable barrel which
  re-exports a server module is reaching the server module. The diagnostic prints the
  chain, and it is the shortest one available.
- **Capabilities travel with the dependency.** `@starter/utils/process` lives in a
  portable package, so a plane check alone sees a legal edge. The Node requirement
  travels through it to `node:child_process`, and the browser half does not have Node.
- **Type-only edges are erased, and one exception is deliberate.** An `import type` is
  not reachability — except `@starter/database`, `@starter/auth` and `@starter/jobs`,
  which a browser
  module may not import even as a type. The Drizzle schema is a private server entity;
  a DTO belongs in `@starter/schemas`. `src/app.d.ts` is exempt because declaring
  `App.Locals` is the framework's own type channel and emits no code.
- **Failure to read is a violation.** A file that will not parse, a specifier that will
  not resolve, a project whose tsconfig cannot be read, a source file no placement row
  covers, and a graph that discovered no modules at all are each reported. A guard that
  skips unreadable input and prints `ok` is not a weaker guard; it is a guard that lies.
- **Non-literal dynamic imports are bounded, not waved through.** `import(variable)`
  cannot be resolved statically, so the guard does not claim it was checked. Application
  code may not contain one; test modules may, because a test ships nothing. The
  repository's one such import is `apps/frontend/client/scripts/dev_ports.test.ts`.

### What it does not claim

- **Not a proof about cross-request state.** `guardRequestState` matches module-level
  declarations by name. That is a lint on shape, not a proof that no request state
  leaks; behaviour tests own that claim.
- **Not a substitute for the build.** `scripts/tests/build_enforces_the_boundary.test.ts`
  injects a component importing `#lib/server/container.ts` and asserts that the real
  `vite build` fails with SvelteKit's `server_only_import`. Both gates are needed,
  because they do not overlap completely: a manual observation found that importing
  `cloudflare:workers` into a component **passes** the production build and lands in the
  client chunk. That behavior is not covered by this test. The graph guard catches that
  import; the bundler does not.
- **Not a rule about *unrelated* relative paths between tooling packages.** The guard
  does have a rule for a relative import that leaves its workspace — it is the one that
  made `apps/e2e` -> `scripts` a *declared exemption* rather than a smell stated and
  forgotten. What it still does not claim is anything about the dependency's
  *declaration* between two private packages that are built together: the failure mode
  `ruleDeclaredDependencies` exists for is a dependency that resolves only because a
  hoister provided it, and that does not arise here. The exemption is a decision with a
  reason and a staleness check, which is a different thing from not looking.

## Versions, and why each is pinned

Read off `apps/frontend/client/package.json`; every one was checked against the
registry rather than assumed.

| Package | Version | Why this one |
|---|---|---|
| `@sveltejs/kit` | `3.0.0` | Stable, released 2026-10-01. Takes its whole configuration inline — there is no `svelte.config.js`. Peer-requires `vite ^8.0.12`, `svelte ^5.57.1`, `typescript ^6.0.0`, `@sveltejs/vite-plugin-svelte ^7.0.0`, which is what fixes the four below. |
| `@sveltejs/adapter-cloudflare` | `8.0.0` | Stable, released 2026-10-01. Peer-requires `wrangler ^4.118.0`. Owns the Wrangler contract for the build. |
| `svelte` | `5.57.1` | The floor Kit 3 declares. |
| `vite` | `8.3.1` | Kit 3's peer range. |
| `@sveltejs/vite-plugin-svelte` | `7.3.1` | Kit 3's peer range. |
| `typescript` | `6.0.3` | Kit 3's peer range, and what `svelte-check` runs. |
| `wrangler` | `4.142.0` | Adapter 8's peer floor is `^4.118.0`. The lockfile pins exactly this; `bunx wrangler` resolves to whatever the registry served that day (observed: 4.144.0), which is why `scripts/src/shared/tools.ts` resolves the workspace binary instead. |
| `@cloudflare/workers-types` | `5.20260929.1` | Types the `D1Database` binding and the platform globals. Listed explicitly in `tsconfig.json`, because under `skipLibCheck` an undiscovered binding type is `any` and the binding contract would be typed by nothing. |

### The adapter, not `@cloudflare/vite-plugin`

This is the load-bearing choice, and it was made by reading the installed
`@sveltejs/adapter-cloudflare@8.0.0` source rather than by trusting a doc snippet.

**What the adapter does, verified in its source:**

- Owns `main`, `assets.directory` and `assets.binding` in the emitted Wrangler
  contract, and emits `.svelte-kit/cloudflare/_worker.js`.
- Supplies `cloudflare:workers` in `vite dev` and `vite preview` through wrangler's
  `getPlatformProxy`, reading **this project's own `wrangler.jsonc`** — D1 included.
  So local and deployed cannot disagree about what the binding is called.
- Takes `platform.env` and passes it straight into `server.init({ env })`.

**Why not the Vite plugin.** A Vite plugin owns the *build*, and a build-only
integration is exactly the thing that cannot be verified without deploying: nothing
in a test can observe it. The adapter owns both halves — the artifact and the dev
runtime — and its output can be started by `wrangler dev` and asserted against
without a network. That is the property the whole verification strategy rests on,
and the acceptance criterion for this change is stated in terms of it: a built
Worker with no Vite proxy must serve assets, SSR pages, sign-in, authenticated
notes and real 404s.

**Bindings come from `cloudflare:workers`, not `event.platform`.** The adapter
passes `env` into the server, and in `vite dev` `platform` is only
`vite.loadEnv(...)` — the build-time `.env`, with no bindings at all. Reading
`event.platform` in development would have given a server with no D1 and no auth
secret, which fails on the first request with an error that names neither.

## Routes and who owns what

| Route | Method | Owns |
|---|---|---|
| `/` | GET | Public landing page. SSR, no bindings read. |
| `/login` | GET | Sign-in form. Client-side submission to `/api/auth/*`. |
| `/notes` | GET | `+page.server.ts`: guard, then `listNotes()` **directly**. |
| `/api/notes` | GET, POST | `notes_service.ts` |
| `/api/notes/[id]` | PATCH, DELETE | `notes_service.ts` |
| `/api/auth/[...all]` | ALL | Better Auth handler. |
| `/api/telemetry` | POST | `telemetry_service.ts` |
| `/api/health` | GET | Config state, no secrets. Echoes `TEST_RUN_ID`. |
| `/api/*` unmatched | — | JSON 404 from `hooks.server.ts`. |

**Server loads call the service; they never fetch.** `notes/+page.server.ts` calls
`listNotes()` as a function. It does not `fetch('/api/notes')` against its own
origin. The second shape would be a second, differently-authenticated path in front
of the same data, it would add a round trip to every page render, and in `vite dev`
it would exercise the emulated binding set through HTTP to reach the process that
already holds it.

**There is one mutation path.** Every write goes through `/api/*`. No form action,
no server action, no `+page.server.ts` `action`. One rule per write, so there is one
place to be right.

**`hooks.server.ts` is the composition root.** Three jobs, in this order, and the
order is the design:

1. **Bindings → container.** `getContainer(env, event.url.origin)`.
2. **Request → identity.** `locals.user` is resolved from the session on every
   request and lives nowhere else.
3. **Unrouted `/api/*` is a JSON 404.** SvelteKit's own fallback for an unmatched
   route is an HTML error page. An API client that asked for `/api/no-such-route`
   and got HTML has to guess why, and the two plausible guesses — wrong URL, or a
   broken deploy — are both expensive. `event.route.id === null` is the signal, so
   this is a fact about the routing table rather than a guess about the status.

A configuration failure is caught here and answered with a 503 naming the missing
binding. An uncaught throw reaches the caller as a generic 500 whose body says
nothing about which binding is missing, which is exactly what a misconfigured deploy
produces.

### The container, and why identity is not in it

`getContainer` memoizes on `(env, baseUrl)` via
`WeakMap<AppEnv, Map<string, Container>>`.

Bindings, the Drizzle handle and the Better Auth instance are derived from the
binding set, which is stable for an isolate's lifetime — memoizing them is correct
and cheap. **User identity is not**, and must not be: a Worker isolate serves many
concurrent requests, and a `setUserForRequest(env)`-style helper is routinely reused
to stash the caller, at which point the last writer wins for everybody. The resulting
bug — a user occasionally reading another user's data — is rare, timing-dependent,
and indistinguishable from an authorization bug while you are debugging it. So
identity is rebuilt per request, in `buildRequestContext`, from the request itself.

`baseUrl` is part of the key because the auth instance's `baseURL` is. In a deployed
environment there is exactly one origin per binding set, so the second level holds
one entry; locally it is the origin the request arrived on, which is the point of
serving HTML, API and cookies from one origin. `container.test.ts` asserts two
origins on one binding set get two containers.

`bun run guard` fails the build on a module-level `let env`, `let currentUser`, or a
`setEnvForRequest`-shaped helper anywhere under `apps/frontend/client/src` — the
whole `src` tree, not only `src/lib/server`, because a `let currentUser` written
into a component or a client service is the same defect. That is a check on shape,
not a proof that nothing leaks: `apps/frontend/client/tests/worker_integration.test.ts`
and the E2E lane's two-session assertions own that claim.

### Environment policy

`resolveDeploymentEnvironment(env, requestOrigin)` is pure and fails closed:

- `DEPLOYMENT_ENV` absent → error. Never "local".
- `DEPLOYMENT_ENV` unrecognised → error.
- Remote without `BETTER_AUTH_URL` → error.
- Remote whose `BETTER_AUTH_URL` is not https → error.
- Local without `BETTER_AUTH_URL` → the request's own origin, **but only if that
  origin is loopback http**.

It never inspects a hostname to decide locality. An earlier rule inferred it from
the shape of `BETTER_AUTH_URL` — absent, or containing `localhost` — and that is
exactly the value a misconfigured deploy is most likely to be missing, so a Worker
deployed without the binding was classified local and started with the *development
secret*. `evil-localhost.attacker.example` also satisfied it.

Deriving the origin from the request is safe here only because locality still comes
from `DEPLOYMENT_ENV` alone and the substituted value must be loopback. That is the
one place a request may influence configuration, and it is bounded on purpose.

## What crosses a boundary

**Serializable DTOs, chosen explicitly.** A route returns the wire shape from
`@starter/schemas`, not a database row and not a service object. `toWireNote` is one
function with one list of fields, and there is no path from `env`, `db`, `auth` or a
`Container` into a response body: `Container` is not serializable and nothing tries.
Session tokens, `BETTER_AUTH_SECRET` and binding objects never leave the Worker.

**`strictObject` on every application schema.** Valibot's Standard Schema
validation refuses unknown fields rather than silently dropping them, so the client
is not told a write succeeded when the contract rejected it.

**Ownership is enforced in the query**, not after it:

```ts
.where(and(eq(notes.id, params.id), eq(notes.ownerId, user.id)))
```

"Fetch, then check whether `row.ownerId === user.id`" has already handed the row to
a function that can log it.

**`ownerId` never appears in a create payload.** Ownership comes from the session.
The create schema rejects a body that carries one — refused, not ignored.

## Frontend conventions

```
route page  →  constructs a ViewModel, hands it to the view
ViewModel   →  state. $state, StaleGuard, a tagged-union status
service     →  I/O. Calls the injected ApiTransport, checks the answer, lets AppError propagate
component   →  formatting, and raising intents
```

- **`status` is a tagged union** — `loading | ready | error` — never a boolean plus a
  separate error field. Two independent fields admit the state where both are set,
  which is the state nobody handles.
- **`StaleGuard` for anything async.** It aborts the superseded request rather than
  ignoring it, so a user typing "a" then "ab" cannot have the "a" results arrive
  last and win.
- **No `as unknown as`, no `as any`.** When a cast is needed, the boundary is wrong.
  A review rule, not a compiler rule.
- **One API base URL, and it is `''`.** The API is this origin. `PUBLIC_API_BASE_URL`
  survives only to point a browser at a *different* deployment while debugging; the
  default it falls back to is no longer `http://127.0.0.1:8787`, which would have
  sent every browser request to a port nothing was listening on.

## Client bundles

`bun run check:bundle` asserts, on the built artifact:

- `.svelte-kit/cloudflare/_worker.js` exists and `.svelte-kit/cloudflare/` holds
  assets beside it.
- No `@tauri-apps/*` import survives (no native shell; see PR A).
- No server-only string reaches a client chunk.

That last check matches **minification-surviving identifiers**, not library names:
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `cloudflare:workers`, `notes_owner_id_idx`,
`notes_owner_updated_idx`, `device_codes`, `account_id`, `emailVerified`,
`email_verified`. A name-based list was measured and is not sufficient — a single
`import { notes } from '@starter/database'` in `notes_service.ts` produced a
green `vite build` and a green check while the client chunk carried
`notes_owner_id_idx`, because minification drops the library name and keeps the
index. `check_bundle.test.ts` locks that in with a negative control.

## Deliberate non-goals

- **No second production router.** One SvelteKit server owns the HTML and `/api/*`.
- **No Vite dev proxy.** It existed because the browser ran on one port and the API
  on another. A proxy left in place would hide exactly the class of bug this change
  is supposed to make impossible.
- **No SvelteKit server actions.** They would put a second, differently
  authenticated path in front of the same data, and the rules for them would not be
  the rules in this document.
- **No `ssr = false`.** It disabled the server renderer for the whole application,
  which is why the landing page was an empty shell. The app is SSR; `/` proves it.
- **No multi-tenancy.** One account owns its rows. An organization concept would
  change every query and every route, and should be designed rather than retrofitted.
- **No R2 binding.** Uploads are a documented future capability. A binding nobody
  reads is a resource somebody pays for.
- **No paid observability.** Local NDJSON plus Workers Observability already answers
  "what happened to this request".

## What to run, and what each proves

| Command | Proves | Does not prove |
|---|---|---|
| `bun run dev` | The server code works in Node against emulated bindings. Fast. | Anything about workerd or the bundle. |
| `bun run build && bun run check:bundle` | The artifact exists, is a Worker plus assets, and carries no server code. | That it serves correctly. |
| `bun run dev:worker` | The compiled `_worker.js` runs in **real workerd** on real D1. | Anything Node-specific — which is why `dev` exists. |
| `bun run test:worker` | The Worker answers over HTTP: health, auth, notes, ownership, 404 shapes. | Browser behaviour. |
| `bun run e2e` | Built client + real Worker + real browser, one origin, two sessions isolated. | Anything about a build this checkout did not make. |
| `bun run test:browser` | Real Svelte in Chromium. | The Worker. |
| `bun run test:compute` | The built jobs Worker runs real Workflows, a real Durable Object, real local D1/R2 and real FFmpeg. | Cloudflare's managed container runtime, or a natural cron firing — see [testing.md](testing.md). |
| `bun run guard` | The invariants in this document still hold, over the resolved module graph. | Anything about a build this checkout did not make. |
| `bun run deploy:check --env staging` | The offline plan names every resource an apply would touch, per environment, with no credential and no network. | That any of it exists, or that the account is the right one. |
| `bun run deploy:preflight --env staging` | The account, the database, the Worker, the bucket and the **names** of installed secrets, read-only. | Container entitlement (reported as unproven), and mail sender verification (reported as NOT CHECKED). |
| `bun run evidence` | The capability matrix and the evidence manifest agree. | Anything about a run that has not happened — those are `not-run` rows, with a reason. |

The dev modes exist because one mode would have to be wrong about something: `vite
dev` runs the server code in Node, where `cloudflare:workers` is a stub and an
import that resolves can still fail in the real runtime. `dev:worker` serves the
compiled artifact through `wrangler dev`, which *is* workerd. Everything that checks
the shipped code uses the second.

## Package resolution is the `exports` map, not a `paths` alias

Every workspace package's `package.json` declares `exports`, and every subpath import
in this repository goes through one of those entries. No `tsconfig.json` maps
`@starter/x/*` into a package's `src/` any more, and that is deliberate.

A wildcard `paths` entry resolves perfectly well, works in every tool, and still routes
around the map — which is how `@starter/utils/lib/process/index.ts` became reachable
next to the deliberate `@starter/utils/process`, and how the assertion "importing this
subpath means you are not a browser" could be bypassed without anyone changing a line
that looked like a boundary. `bun run guard` now reports such an import as
`package-exports`, names the map, and lists what it does publish.

## One deployment target, not one Worker

A deployment here is **four** resources that can change independently: the web Worker,
the jobs Worker, the D1 schema, and the container image — plus the R2 objects they
write. `resolveTarget(environment)` in `scripts/src/deploy/target.ts` resolves all of
them together, and every command that can reach a remote resource resolves its
destination through it.

That is a boundary decision, not a convenience. A plan that printed one Worker and one
database while `apply` went on to build an image and deploy a second Worker is not the
document an approval is given against, and the order is chosen so the *public* origin
is published last — the public origin is the only resource a user can see, and the one
whose failure is visible.

The consequence for rollback is in [deployment.md](deployment.md): a Worker rollback
restores **code** and nothing else. The schema is forward-only, the encoded media stays
where it is, and the image and the Workflows are a separate deploy.

## See also

- [deployment.md](deployment.md) — the resolved target, the pipeline order, and what a rollback does not undo
- [compute.md](compute.md) — what the second Worker demonstrates, and when to leave Cloudflare
- [testing.md](testing.md) — what each lane can and cannot tell you
- [cloudflare.md](cloudflare.md) — deploy, D1, credentials, and what was verified
- [capability-matrix.md](capability-matrix.md) — verified, fixture-verified, or not run
- [lint.md](lint.md) — what the linter enforces, and what it cannot
- [adding-a-feature.md](adding-a-feature.md) — the order that works, and why

## Frontend screen runtime

Features keep their views, view models and feature services together. Application
composition owns the host-specific transport, session, navigation and persistence
capabilities. JSON, bytes and streams use `@starter/platform` transport contracts;
feature services do not call global `fetch` or inspect credentials.

Each screen owns a single-use `ScreenScope`. Unmount closes it synchronously, aborting
loads and writes; cleanup registered after closure runs immediately. `AsyncOperation`
provides reactive pending/error state, while each caller chooses single-flight or
concurrent behavior explicitly. Mutation completion and follow-up navigation are
separate outcomes. A refreshed server snapshot invalidates older reads and merges by
stable identity while retaining drafts, queued writes and active streams.

Use `.svelte.ts` only for modules containing Svelte runes. Prefer narrow service
contracts at injection boundaries. Render operation errors beside the action that can
recover from them. Ordinary navigation uses links; imperative navigation after a
mutation reports navigation failure without claiming the mutation failed. See the
[frontend architecture review](frontend-architecture-review.md) and the canonical
chat and notes features for examples.
