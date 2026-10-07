# Herdr worktrees and local environment

Use one bootstrap command after creating a checkout. In a terminal, enter the
checkout and run:

```bash
direnv allow                 # once, only after reviewing this repository's .envrc
direnv exec . bun run worktree:bootstrap
```

`worktree:bootstrap` installs the lockfile dependencies and checks the browser.
When Nix is installed it runs setup inside this repository's pinned `nix develop`
shell, so it does not depend on the parent terminal having activated `.envrc`.
On a non-Nix host it uses the Bun already on `PATH`. Herdr's project Pi tool runs
this command after a real worktree is created; bootstrap failure leaves the
checkout in place and reports the exact retry command.

Noninteractive children must activate the shell explicitly. `.envrc` is an
interactive direnv integration and is not inherited by arbitrary child processes:

```bash
nix develop --command bun run worktree:bootstrap
nix develop --command bun run e2e
```

From a trusted settings file outside the checkout, an operator may import only
optional visual-review settings:

```bash
direnv exec . bun run worktree:bootstrap --from "$HOME/.config/starter/worktree.env"
```

The source path must be absolute. Accepted names are `E2E_VISION_PROVIDER`,
`E2E_VISION_MODEL`, `E2E_VISION_BASE_URL`, `E2E_VISION_API_KEY`, the bounded
`E2E_VISION_*` tuning values, and `OPENROUTER_API_KEY`. Unsupported names are
refused by name; values are never included in errors. Files accept a deliberately
small dotenv grammar: blank lines, full-line comments, `NAME=value`, single or
double quoted values, and trailing comments on unquoted values. Duplicate keys,
`export`, shell substitutions and malformed quotes fail closed. The importer
creates `.env.e2e` with mode 0600 and refuses to replace an existing file. It
does not copy ignored files, symlink environment files, or import deploy or hosted
service credentials.

Environment sources and consumers are deliberately narrow:

| Source | Precedence | Permitted consumer |
|---|---|---|
| Existing local `.env` and setup defaults | Existing file wins; setup creates only missing local defaults | Local development only |
| Inherited process environment | Per key, overrides `.env.e2e` | The command that explicitly needs that setting |
| `.env.e2e` | Fallback for unset inherited visual settings | Visual capture/review configuration; capture itself needs no credential |
| `E2E_VISION_API_KEY` | Wins over `OPENROUTER_API_KEY`; inherited value wins over file value | Visual review HTTP client only |
| `E2E_VISION_MODEL` | Explicit setting required; no default model is invented | Visual review HTTP client only |
| Run-owned Supabase vars file | Generated for one uncached run; path is passed to Wrangler with `--env-file` | That run's preview Worker and integration fixture; service-role key stays out of Moon and browser processes |
| `.env.deploy` | No local-test precedence; loaded only by deployment commands | Explicit deploy/preflight/provision/apply commands |

Generic builds and Moon tasks remove deploy, hosted Auth/mail, Supabase
service-role and visual-review credentials from their child environments. Secret
values stay out of argv and command output. Browser bundles are checked by
`check:bundle`; screenshots and reports contain no environment values.

Development ports derive from the checkout path, and E2E ports, logs, state,
browser output and Supabase projects are owned by a worktree/run scope. A busy
dev listener is refused rather than reused; Supabase probes its complete local
port block and selects the next free block before startup. Supabase preview runs create
`.wrangler/runs/<run-id>/supabase.dev.vars` privately; a user `.dev.vars` is
neither read nor changed, and cleanup removes only the unchanged file created by
that run. The live Supabase Worker lane also passes with a conflicting `.dev.vars`
fixture present, then verifies its bytes are unchanged. The local project identity and all exposed service ports are unique per
worktree and run. Startup errors, cancellation and teardown errors remain failures
with ownership evidence preserved for diagnosis.

Visual capture and review currently support the legacy backend only. The suite has
no deterministic Supabase visual fixture set, so an unsupported backend is refused
before a browser starts. Supabase Worker and browser E2E have their own real local
Auth/Postgres/Mailpit harness. Its email verification is fetched in Node request
context because Chromium cannot resolve the GoTrue loopback callback reliably;
the browser then navigates the app's real callback URL to redeem the code and
establish its session. This covers local email delivery, callback navigation and
browser cookie establishment. It does not exercise hosted Auth or external SMTP.
Jobs dispatch remains disabled pending Prompt 06.

Pi's `herdr` worktree action also needs a project-trusted `.pi` extension. Review
the repository before accepting project trust; the tool then invokes the same
bootstrap entrypoint used by terminals and noninteractive agents.
