# Secrets

Two rules, and everything else follows from them.

1. **Examples are committed. Real values never are.**
2. **Prefer a value the server derives over a value you store.**

## What never goes in the repository

- `.env`, `.dev.vars` — real values
- `secrets/*.enc.*` — SOPS ciphertext is encrypted to *specific* recipients, so
  committing it here would either be useless to you or a leak to someone else
- `*.pem`, `*.key`, `*.agekey`, `id_ed25519` — key material, no exceptions
- `.dev.vars`, `.dev.vars.*` — same as `.env`, and the exception list does not
  cover them by accident
- Browser profiles, SQLite files, `.wrangler/` local state

`.gitignore` enforces this, and `bun run guard` fails the build if it ever stops
covering a source file.

## Local development

```bash
cp .env.example .env
# or, per app:
cp apps/backend/api/.env.example apps/backend/api/.env
```

`.env` is read automatically by Bun and by Wrangler (as `.dev.vars` for the
Worker). `bun run setup` writes these for you and tells you which values are still
placeholders.

Nothing above needs a secret. The local Worker runs on local D1, and
`--mode local` log queries read a file.

## What actually needs a secret

| Value | Where | Used for |
|---|---|---|
| `BETTER_AUTH_SECRET` | Worker binding | Signing session cookies |
| `CLOUDFLARE_API_TOKEN` | your shell | `deploy:check`, `deploy` |
| `TRUSTED_ORIGINS` | Worker binding | Which origins may send credentials |
| Age identity | your machine | Decrypting SOPS files |

`BETTER_AUTH_SECRET` is the only one the application cannot do without. Locally it
falls back to a development value, with a warning; remotely it is required and the
Worker refuses to start without it.

## Where a secret comes from, in order of preference

**1. Don't store it.** If the server can derive it, it should. `ownerId` comes
from the session, not the body. A secret you do not store cannot leak.

**2. A Cloudflare Worker binding.** Set with `wrangler secret put NAME`. It never
appears in a file, in a build, or in a deploy payload.

**3. Your shell, not the repository.** Export it in your profile, or use
`direnv` (below).

**4. SOPS, for what must be shared.** Encrypted per-recipient, decrypted locally,
never committed in plaintext.

## direnv

`.envrc` is plain bash — no Nix, no framework. It loads `.env` if it exists and
nothing if it does not:

```bash
# .envrc
if [ -f .env ]; then
  dotenv .env
fi
```

`layout dotenv` also manages PATH. Run `direnv allow` once per clone.

`.envrc` is committed; `.env` is not. `.envrc.local` is ignored, for the per-machine
extras.

## SOPS

For a secret that genuinely has to be shared — a third-party API key a collaborator
also needs.

```bash
bun run setup:secrets            # doctor: what is installed, what is configured
```

Every operation below runs the real `sops` binary and reports **its** exit status.
The tool refuses rather than guessing, and says which refusal applied.

### Getting started

```bash
mkdir -p .age secrets                         # local input and identity directories
age-keygen -o .age/key.txt                     # your PRIVATE key. Never committed.
grep -o 'age1.*' .age/key.txt                  # your PUBLIC key
bun run secrets:init -- age1…                  # writes .sops.yaml with one recipient

printf 'API_TOKEN=replace-with-your-token\n' > secrets/app.enc.env
bun run secrets:encrypt -- secrets/app.enc.env # encrypt the plaintext in place
bun run secrets:decrypt -- secrets/app.enc.env # to stdout; nothing written
```

`secrets:init` never generates a key for you. `age-keygen` writes a private key and
this tooling has no business creating one; you supply the public half, which is the
only part that belongs in a repository.

It also **refuses to overwrite an existing `.sops.yaml`**. Replacing one silently
drops every other person's recipient, and their files become unreadable to them.

### Running a command with a secret

```bash
bun run secrets:exec --env CLOUDFLARE_API_TOKEN=<ciphertext> -- ./scripts/deploy.sh
```

The value reaches the process's environment and never reaches a file. If any value
fails to decrypt, **nothing is executed** — a process started with some of its
secrets missing fails in a way that blames the program rather than the missing
secret.

A ciphertext decrypts to a whole JSON *document*, not to a bare value, so the key is
extracted from it. Using sops' stdout directly would put `{"TOKEN":"…"}` into the
environment — a secret that is subtly wrong in a way nothing notices until something
tries to authenticate with it.

### Adding a colleague

```bash
bun run secrets:update-recipients -- age1…
```

Existing recipients are kept. A file encrypted **before** someone joined still
cannot be read by them — that is sops being correct, because every holder of the data
key can read every secret, so widening access is a decision a person makes per
file. There is deliberately no bulk re-key.

### What the commands refuse, and why

| Refusal | Exit | Reason |
|---|---|---|
| `secrets:edit` | 4 | Deliberate. `sops <file>` already edits in place; a wrapper would be a second code path to the same file. It says so. |
| Encrypting a path git tracks | 4 | Ciphertext belongs under a name that says so. Encrypting `.dev.vars` in place commits a file that reads as a plain env file. |
| `decrypt --out` into a tracked path | 4 | A decrypted secret in a tracked file is committed by the next `git add`. Asks `git check-ignore` rather than reimplementing ignore rules. |
| `encrypt` with no file | 2 | The target is never guessed. Encrypting the wrong file publishes it to your team. |
| Encrypt with no recipient configured | 3 | A file nobody can decrypt is not protected, it is lost. |
| `update-recipients` with no config | 3 | "Update" that silently creates is how a colleague's recipient list gets replaced by yours. |

`decrypt` with no `--out` writes **nothing** — the plaintext goes to stdout. That is
the safe default: `sops -d f > somewhere` is where secrets end up in files nobody
chose. With `--out` the file is created mode `600`.

### Two things about the config that are easy to get wrong

Both were found by running `sops`, not by reading its documentation carefully, and
both are asserted in `scripts/tests/secrets.test.ts` against a real ephemeral
`age-keygen` identity:

- **`age` must be a YAML list, not a folded scalar.** `age: >-` joins its lines
  with a space, so a *second* recipient becomes one 124-character token and every
  subsequent encrypt fails with `failed to parse input as age key … invalid
  character`. Verified by trying all four config shapes: only a list accepts more
  than one recipient.
- **`path_regex` is matched against the path as given on the command line**, not
  resolved and not absolute. A rule for `\.env$` does **not** match `.dev.vars`. The
  generated rules cover the names this repository uses.

### What the template ships

The doctor reports the real state on a fresh clone: `sops` and `age` availability,
whether `.sops.yaml` exists, and how many recipients it names. It exits `3` when
either tool is missing and `0` otherwise — an unconfigured recipient is the expected
state of a fresh clone, not a failure.

The template ships **no `.sops.yaml`, no `.age/recipients.txt` and no ciphertext**,
because recipients identify the people who ran the extraction, not you. Create
`.sops.yaml` with your own public age recipient before encrypting anything.

`secrets/*.enc.*` is gitignored in this template. For an initialised project,
whether ciphertext belongs in the repository is your call — SOPS ciphertext is
designed to be committed — but note that a committed encrypted file still discloses
its recipient set and filename, which is often enough to identify who holds what.

### What is verified, and what is not

**Verified** by the 16 tests in `scripts/tests/secrets.test.ts`, including 11
round-trip tests that drive the real binaries with an identity generated per run:
the encrypt/decrypt round trip returns the original bytes; a tracked `--out` is
refused and the file is untouched; a recipient added later cannot read what was
encrypted before they joined; `exec` hands the child a bare value; and each refusal
above leaves the file exactly as it was.

**NOT RUN:** these are round trips against a real `sops` in a temporary repository.
No ciphertext produced here is committed, and nothing has been exercised against a
real team's shared configuration.

## Checking before you publish

```bash
bun run setup:secrets --doctor
git ls-files | grep -E '\.env$|\.dev\.vars$|\.pem$|\.key$|\.agekey$'   # must be empty
git grep -lI -E 'ghp_|sk-[A-Za-z0-9]{20,}|sbp_|npm_[A-Za-z0-9]{20,}|AKIA|BEGIN.*PRIVATE KEY'
```

The last command is a backstop, not a scanner. It will miss things a proper
secret scanner catches, so run one of those too before publishing something you
did not write:

```bash
gitleaks detect --source . --no-git --redact
trufflehog filesystem . --no-update
```

Both belong in a pre-publish hook or in CI, not in someone's memory.

## What this repository ships

Nothing. Verified across every tracked file:

```
credential-shaped values : 0
private key blocks       : 0
real .env or .dev.vars   : 0
SOPS ciphertext          : 0
Cloudflare resource ids  : all null
```

That last one is enforced by the `registry-valid` guard, which fails the build if a
resource id becomes a literal in the committed registry — so a template cannot
acquire somebody else's account. Real ids live in the gitignored
`.starter/deployment.local.json` instead; see [cloudflare.md](cloudflare.md).