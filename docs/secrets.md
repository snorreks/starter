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

### `secrets:encrypt` and `secrets:decrypt` are not implemented yet

Both commands exist, and both currently print the raw `sops` invocations and **exit
3**. They do not read, write or encrypt anything.

```bash
bun run secrets:encrypt -- secrets/production.env
# NOT IMPLEMENTED. Nothing was read, written or encrypted.
#   sops -e secrets/production.enc.env   > secrets/production.enc.env.new
#   sops -d secrets/production.enc.env   > apps/backend/api/.dev.vars
```

They used to print the same guidance and exit 0. That is worse than not having the
commands: anything wrapping `bun run secrets:encrypt` — a script, a CI step — saw
success and concluded a file had been encrypted.

Real `init`, `doctor`, `edit`, `encrypt`, `decrypt`, `exec` and `update-keys`
arrive with the phase that also wires direnv. Until then, run `sops` directly and
keep the target path explicit.

### What the template ships

The doctor reports the real state on a fresh clone: `sops` and `age` availability,
whether `.sops.yaml` exists, and how many recipients it names.

The template ships **no `.sops.yaml`, no `.age/recipients.txt` and no ciphertext**,
because recipients identify the people who ran the extraction, not you. Create
`.sops.yaml` with your own public age recipient before encrypting anything.

`secrets/*.enc.*` is gitignored in this template. For an initialised project,
whether ciphertext belongs in the repository is your call — SOPS ciphertext is
designed to be committed — but note that a committed encrypted file still discloses
its recipient set and filename, which is often enough to identify who holds what.

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

That last one is enforced by guard 5, which fails the build if a resource id
becomes a literal — so a template cannot acquire somebody else's account.