// scripts/src/deploy/credentials.ts
//
// The credential modes this tooling supports, and the ones it refuses.
//
// There is exactly one supported mode. That is a finding, not an omission: an
// earlier version of this tooling claimed two (`wrangler login`'s OAuth state and
// an API token) while actually reading only the environment variable, so an
// operator who ran `wrangler login` was told "no credential" and an operator whose
// token had expired was told nothing at all. A capability the CLI names but the
// code does not implement is worse than an absent one, so the mode list here is
// the contract and `hasCloudflareCredential` is what implements it.
//
// What is deliberately *not* supported:
//
//   * **`wrangler login` OAuth state.** Reading a developer's global wrangler
//     configuration from a script makes behaviour depend on machine state that
//     appears nowhere in review, and in CI it does not exist at all. The remedy
//     says so rather than silently failing.
//   * **A token on the command line.** `wrangler --api-token <value>` and
//     `--var NAME:value` both place a secret in a process's argv, where it is
//     visible to every other process on the machine and recorded in CI logs.
//     `refusesSecretInArgv` is the check that keeps the CLI from ever producing
//     one, and it is a refusal rather than a rewrite: silently moving a caller's
//     argument somewhere else would be a different command than the one they
//     asked for.

/** The credential modes this tooling documents. One, deliberately. */
export const SUPPORTED_CREDENTIAL_MODES = ['env-api-token'] as const;

export type CredentialMode = (typeof SUPPORTED_CREDENTIAL_MODES)[number];

/** Where a credential would be read from, named without ever reading it. */
export interface CredentialState {
  mode: CredentialMode | null;
  /** Variable name when a credential is present. Never the value. */
  source: string | null;
  problem: string | null;
  remedy: string | null;
}

/** The variable the supported mode reads. Named so a report can say where to look. */
export const CREDENTIAL_ENV_VAR = 'CLOUDFLARE_API_TOKEN';

/**
 * Describe the credential situation without touching the secret.
 *
 * Returns the *name* of the environment variable and never its length, prefix or
 * hash. A preflight report gets printed into CI output and pasted into tickets;
 * anything derived from the value would end up in all three.
 */
export const describeCredential = (env: NodeJS.ProcessEnv = process.env): CredentialState => {
  const value = env[CREDENTIAL_ENV_VAR];

  if (typeof value === 'string' && value.trim() !== '') {
    return { mode: 'env-api-token', source: CREDENTIAL_ENV_VAR, problem: null, remedy: null };
  }

  return {
    mode: null,
    source: null,
    problem: `No Cloudflare credential. ${CREDENTIAL_ENV_VAR} is not set.`,
    remedy:
      `  export ${CREDENTIAL_ENV_VAR}=<token>   # never on a command line\n` +
      '  Create one at https://dash.cloudflare.com → My Profile → API Tokens, scoped to\n' +
      '  the account and the Worker/D1 edit permissions this deployment needs.\n\n' +
      '  `wrangler login` does not work here by design: this tooling does not read the\n' +
      '  OAuth credentials wrangler writes to a per-user directory, because behaviour that\n' +
      '  depends on hidden machine state cannot be reviewed and does not exist in CI.',
  };
};

/** Is a credential present? Cheap; never prints or returns the value. */
export const hasApiToken = (env: NodeJS.ProcessEnv = process.env): boolean =>
  describeCredential(env).mode !== null;

/**
 * Refuse any argv that would put a secret where another process can read it.
 *
 * Checked before a plan is rendered rather than before it is executed, so a
 * command that *would* have leaked cannot reach the point of leaking.
 */
export const secretInArgvProblem = (args: readonly string[]): string | null => {
  for (const [index, token] of args.entries()) {
    if (token === '--api-token' || token === '--api-key' || token === '--token') {
      return (
        `"${token}" would place a secret in this process's argv, where every other ` +
        'process on the machine can read it and CI records it verbatim.\n' +
        `  Set ${CREDENTIAL_ENV_VAR} in the environment instead.`
      );
    }

    // `--var NAME:value` is the other route, and it is easy to miss because the
    // value is not obviously a credential on its own line.
    if (token.startsWith('--var') && token.includes('SECRET')) {
      return (
        `"${token}" would place a secret in this process's argv.\n` +
        `  Secrets go through \`wrangler secret put\` (prompting, never argv), and the ` +
        'names this environment requires are listed by `bun run deploy:check`.'
      );
    }

    // A bare `--var NAME value` pair: the value is the *next* token.
    if (token === '--var' && args[index + 1]?.includes('SECRET') === true) {
      return (
        "`--var` with a secret-bearing name would place a secret in this process's argv.\n" +
        '  Secrets go through `wrangler secret put` (prompting, never argv).'
      );
    }
  }

  return null;
};
