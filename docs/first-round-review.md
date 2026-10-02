# First-round review

The findings from the first read of this repository, and where each one stands.

Kept because a finding that has been fixed is still worth being able to check, and
because the ones that are *not* fixed should not have to be rediscovered.

Two statuses only: **fixed** with the change that fixed it, or **open** with why.

Entries describe the state of the repository **at the time of the round**. Where a
later round (PR A native removal, PR B single-Worker merge) has since changed the
shape underneath a finding, the entry says so rather than being silently rewritten —
a finding whose wording no longer matches the tree is worse than no finding, because
it cannot be checked.

---

## Fixed in round one

### The E2E command was an echo

`bun run e2e` → `moon run e2e:test` → `echo "e2e is not a unit lane"`. CI applied
migrations, installed Chromium, printed that and went green. The 17 Playwright tests
never ran. `e2e:test` also reported `cached`, because its inputs were `src/**/*` and
`apps/e2e` has no `src/`.

**Fixed:** `e2e:test-e2e` runs the real suite; `apps/e2e`'s file groups match its
actual layout; the lane is uncached. Verified by a deliberately failing assertion
making `bun run e2e` exit 1, and by three consecutive runs with no leaked process.

### The browser lane ran twice

The client's `test` was `test:unit && test:browser`, so `moon run :test` ran the
browser lane and root `test:all` ran it again explicitly.

**Fixed:** `client:test` is unit only; `client:test-browser` is separate;
`test:all` lists each lane once.

### `client:build` printed a message

Root `build` ran `moon run :build`, and the client's `build` was
`echo "nothing to build (TypeScript source)"`. A SvelteKit app produces a build,
which both the E2E lane and any deploy need.

**Fixed:** real `vite build`, plus `check:bundle` that inspects the artifact and
verifies the build *mode*. **PR B** changed what "the artifact" means: the output is
now `.svelte-kit/cloudflare/` — a Worker plus its assets — rather than a `build/`
directory of static files, and `check:bundle` asserts `_worker.js` is there.

### `database:db-generate` printed a message

`bun run db:generate` echoed. A schema change with no generated migration fails at
deploy time against a real D1.

**Fixed:** runs `drizzle-kit generate`, uncached, with the migration directory as
declared outputs.

### `e2e:capture-evidence` echoed

It pointed at a Moon task whose command was `echo`.

**Fixed:** invokes the real `capture_evidence.ts`.

### `client:tauri:build` and `client:check:bundle` pointed at nothing

Both named `scripts/*.ts` files that did not exist.

**Fixed:** both implemented, both with tests. `check:bundle` survives; the Tauri
half was removed with the native shell in **PR A**, and `check:bundle`'s
`native_import` rule now fails the build if a `@tauri-apps/*` import ever returns.

### `client:dev` did not exist

Root `dev` ran `moon run client:dev`, and the client's Moon file had no `dev` task.
Verified against the pinned Moon rather than assumed.

**Fixed:** a `dev` task using Moon\u0027s `server` preset.

### Two dev ports that disagreed

`vite.config.ts` defaulted to 5273; `src-tauri/tauri.conf.json` hard-coded
`devUrl` at 5173; the README said 5173. `tauri dev` opened a window on a port
nothing was listening on.

**Fixed:** one authority (`apps/frontend/client/dev_ports.ts`, default 5173) and a
test asserting `tauri.conf.json` agrees. The second authority is gone with
`src-tauri/`; the assertion the entry describes no longer has a second value to
compare against.

### Environment detection could enable development auth remotely

```ts
const isLocal = env.BETTER_AUTH_URL === undefined || env.BETTER_AUTH_URL.includes('localhost');
```

A Worker deployed without `BETTER_AUTH_URL` — the most likely binding to be missing —
was classified local, which relaxed the auth-secret rule and started it with the
shipped secret. `mylocalhostdev.example` also satisfied the substring.

**Fixed:** an explicit, validated `DEPLOYMENT_ENV` binding; missing or unrecognised
is an error; `BETTER_AUTH_URL` required and structurally validated in every
environment and `https` outside local; the development placeholder rejected remotely
even when supplied explicitly; a configuration failure is a 503 naming the binding.
Tested through the real `worker.fetch` entrypoint, and confirmed to fail when the old
heuristic is restored.

### Duplicated `wrangler` in argv

`planDeploy` put `wrangler` in the step's args and `runWrangler` prepended it, so
the process that ran was `wrangler wrangler deploy`.

**Fixed:** `Step.args` holds subcommand arguments only. Asserted at the process
boundary, counting `wrangler` tokens in the rendered command.

### `--env local` built a remote command

It marked a step non-remote — skipping consent — while still building
`wrangler deploy`. Removing the duplicate token alone would have exposed this.

**Fixed:** rejected, with the message pointing at `bun run dev` and explaining
that a local *invocation* and the local *runtime* are different things.

### A typo deployed both apps

`parseTargets` filtered argv to valid target words and defaulted to both when none
survived, so `bun run deploy -- clientt` deployed the API *and* the client.

**Fixed:** strict parsing; an unknown word is an error. Asserted at the process
boundary: a typo spawns nothing.

### Consent was implied by an interactive terminal

`requireRemoteConsent` refused only a *non-interactive* session without `--yes`, so
a developer at a prompt got a silent remote deploy.

**Fixed:** `--yes` is required in every session.

### `bunx` ran an unpinned wrangler

`wrangler` is declared by one workspace package, so its binary is not in the root
`node_modules/.bin` and `bunx wrangler` from the repository root falls through to
the network. Lockfile: 4.142.0. `bunx wrangler --version`: 4.144.0.

**Fixed:** `scripts/src/shared/tools.ts` resolves the pinned copy, and every wrangler,
drizzle-kit, playwright and vite invocation goes through it. The deploy process
boundary test asserts the resolved path. (The native shell is gone as of PR A, so
there is no tauri invocation left to route.)

### Contract resume skipped failed stages

`contract run` and its resume protocol are gone — see the entry below. This finding
is kept because the defect class is the reason: completion was inferred from a
counter rather than from a status.

Completion was inferred from "the stage has an attempt count", and a failed stage
has one. Recorded reproduction: a run whose `implement` failed reached `accepted` on
the next invocation.

**Fixed:** explicit per-stage status; only `succeeded` is skipped; `blocked` is
resumable; the retry budget is per invocation with a lifetime invocation cap;
`maxStageMs` is enforced against the awaited adapter with a real abort signal; a dry
run ends in `dry_run`; acceptance additionally requires deterministic verification
evidence bound to the current source revision. `full` mode now actually contains the
critique and review stages its comments claimed. The recorded bug is reproduced
beside the fix in `contract/reproduction.test.ts`.

### The contract CLI always ran the dry adapter

`contract run` invoked the dry adapter regardless of `--dry-run`, printed the stages
and exited 0.

**Fixed:** a non-dry run reports that no execution adapter is available and exits 3.
The CLI derives the contract's real id and mode from its content, persists state
atomically, implements `status`, and wires `--resume`.

**Later removed, in the final integration.** The adapter that would have made a
real run possible was never written, so the whole surface stayed a claim the
repository could not keep: a stage machine, a resume protocol, a run manifest and
two CLI subcommands that produced no work. Rather than leave it dormant, the
runner, its manifest format and its tests are gone; what remains is the written
brief (`bun run contract new`) and a documented human workflow. `docs/contracts/`
now holds one template and that workflow, and `contract run` answers with what
happened instead of a stage list.

### `.pi/extensions/logs.test.ts` was loaded as an extension

Pi discovers `.pi/extensions` and loads every module there. A file importing
`bun:test` fails that load on every start. The unit suite passed, because `bun test`
does not care what Pi can load.

**Fixed:** `.pi/extensions` holds entrypoints only; helpers in `.pi/lib`, tests in
`.pi/tests`. `tests/pi_loader.test.ts` drives the real pinned Pi resource loader,
and includes a negative control that writes a misplaced module into a *temporary*
extensions directory and asserts the loader reports it.

### The log extension had no byte limit, timeout or cancellation

It accumulated stdout and stderr unbounded, and had no subprocess timeout. Its
`limit: 200` argument bounds lines, not bytes, and bounds what the CLI chooses to
emit — not what the process writes.

**Fixed:** `.pi/lib/process.ts` — byte budget with overflow spilled to a file and
reported, a real timeout with SIGTERM-then-SIGKILL, abort-signal support, and a
distinguished exit status for a timed-out process. Tested against real processes.

### Secrets commands printed instructions and exited 0

`secrets:encrypt` / `secrets:decrypt` printed the raw `sops` invocations and
returned 0, so a wrapper saw success.

**Fixed:** they now report NOT IMPLEMENTED on stderr and **exit 3**. The real
commands arrive with the phase that adds direnv. `docs/secrets.md` says so.

### The dev API launcher leaked a worker per run

`scripts/dev/api.sh` spawned wrangler with `setsid`, so it survived Playwright's
teardown. Each E2E run left a `workerd` on port 8788 and the *next* run refused with
"already used". The integration suite leaked the same way: `server.kill()` left
wrangler's `workerd` child holding its port.

**Fixed:** the shell launcher is replaced by `scripts/dev/api.ts`, which owns the
child, forwards signals, preserves the exit status, keeps a per-checkout PID file,
and walks the process tree. `killTree` lives in `@starter/utils/process` and is used
by both. Verified by three consecutive clean runs.

---

## Open

Named so they are not rediscovered as surprises. Most are later-phase scope.

### Cloudflare historical logging is a stub

`queryCloudflareHistory` never sends a provider request; it returns
`retrieval_failed` once configuration checks pass. It also conflates the Workers
Logs query API with Logpush. The Workers Observability REST API should be the default
source; Logpush is a separate optional capability. **Nothing here should be read as
evidence that Cloudflare log querying works.**

Live tail assumes each input line is an application `LogEvent` rather than
validating and extracting from the provider envelope, and has no coverage of its
process lifecycle or exit reporting. A non-indexed stream can still support bounded
client-side filters; where filtering happens should be stated rather than asserted.

### Deployment configuration is not yet environment-aware

- `deploy:configure` writes a D1 id to `wrangler.jsonc` but not to the registry that
  `deploy:check` reads, despite text claiming it updated both.
- the registry has one set of names and ids, not distinct staging/production targets
- Worker names are validated but are not consistently the source of the actual
  Wrangler destination
- provisioning uses a fixed database name with no environment model (renamed to
  `starter-web` in PR B, but the fixed name is still the gap)
- ~~no client Wrangler config exists for the advertised client deployment~~ closed in PR B: one `wrangler.jsonc`, one Worker, one `main`
- ~~the static frontend's local Vite API proxy has no production routing equivalent~~ closed in PR B: the frontend and the API are one origin, so there is no proxy to reproduce
- no no-op decision reconciles a fingerprint against the active Cloudflare
  deployment; a local cache hit cannot prove a deployment is active

### Cache inputs and guards

Moon file groups repeatedly select `src/**/*` where the executable code lives
elsewhere; `apps/e2e` has no `src/` at all. Whole-repository guards are declared
with inputs limited to `scripts` source, so an unrelated application edit can evade
their intended scope.

### Boundary guards

`scripts/src/guards/boundary.ts` uses regexes and hardcoded package names, so
relative imports crossing workspace boundaries and some import syntaxes evade it.
The regex half was fixed in round one (the scanner now blanks comments and strings
while preserving specifiers, and matches `require()` and template-literal
specifiers). **PR B** added a new half: `apps/frontend/client` now holds both a
browser runtime and a Worker, so the guard distinguishes them by five path shapes
rather than by directory. That list is narrow on purpose but it is a list, and a
list cannot see through a re-export; PR C replaces it with a
resolved-dependency check.
Registry validation is textual, and its ban on literal configured resources
conflicts with instantiating the template.

### Docs

`docs/` grew a `capability-matrix.md` and this file during this round because two
documents were teaching incorrect behaviour: the E2E command's real shape, and
whether deploy, historical logs, secret commands and native builds actually work.
Further prose cleanup belongs with the phase that consolidates the docs tree.