# SOPS ciphertext for this project

Two files, one per environment. Each holds that environment's two runtime secrets
and nothing else:

| File | State | Installs into |
|---|---|---|
| `staging.enc.env` | **committed** | the `staging` Worker |
| `production.enc.env` | **not yet created** | the `production` Worker |

Two files rather than one because a deploy reads exactly one. A single file holding
both environments means the staging job's process holds the production values, which
is a credential handed to a job that has no reason to have it.

`production.enc.env` has to be created before a SOPS-backed production run, the same
way `staging.enc.env` was — and its absence is a refusal, not a fallback:

```
::error::secrets/production.enc.env is not in this revision. See secrets/README.md.
```

Nothing falls back to the GitHub environment secrets behind your back. If a
production deploy needs its secrets today, run it with `secrets_source: github`.

Each file holds exactly the two **runtime** secrets the Workers need, and nothing
else:

```
BETTER_AUTH_SECRET=ENC[…]
RESEND_API_KEY=ENC[…]
```

`CLOUDFLARE_API_TOKEN` is deliberately **not** here. It is a deployment credential
scoped to an account, it belongs to the `staging` GitHub environment rather than to
this repository's history, and it is never a runtime secret. Putting it here would
give every developer who can read this file a working Cloudflare token.

## Creating one

The order matters, because `bun run secrets:encrypt` refuses a path git is not
ignoring — and these paths are deliberately *not* ignored:

```bash
# 1. values in, never in a shell history or a chat message
umask 077
$EDITOR secrets/staging.enc.env          # BETTER_AUTH_SECRET=…, RESEND_API_KEY=…

# 2. encrypt in place with sops itself
sops --encrypt --in-place secrets/staging.enc.env
```

`sops --encrypt --in-place` rather than `bun run secrets:encrypt`, because the
wrapper refuses a committable path: it protects you from encrypting something named
like a plain env file, and `staging.enc.env` is already named correctly. Once the
file is committed, `sops secrets/staging.enc.env` is how it is edited — which is
what `bun run secrets:edit` says when it refuses to exist (exit 4).

For a file that should stay local and uncommitted — a developer's own token, a
throwaway value — use the wrapper instead. It is the better tool there:

```bash
printf 'API_TOKEN=…\n' > secrets/local.enc.env    # secrets/*.enc.env is gitignored
bun run secrets:encrypt -- secrets/local.enc.env
bun run secrets:decrypt -- secrets/local.enc.env   # to stdout; writes nothing
```

## Reading one

```bash
export SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"   # or .age/key.txt
sops exec-env secrets/staging.enc.env 'bun run deploy:secrets --env staging --yes --install'
```

`sops exec-env`, **not** `exec-file`: this store is dotenv, and `exec-file` runs the
command without exporting anything into its environment, so the values arrive empty
and the failure looks like a missing secret rather than a wrong command.

The values reach the child's environment and no file. `deploy:secrets --install`
reads `BETTER_AUTH_SECRET` and `RESEND_API_KEY` by name from the environment and
passes them to `wrangler secret put` on **stdin**, so a value never reaches argv, a
log line or an artifact.

## Recipients

[`.age/recipients.txt`](../.age/recipients.txt) is the roster; `.sops.yaml` at the
repository root is what sops reads. `bun run setup:secrets` reports the real state.
Adding a recipient does **not** re-key existing files — `yes | sops updatekeys
secrets/<file>.enc.env` is a per-file decision, because every holder of the data key
can read every secret in it.