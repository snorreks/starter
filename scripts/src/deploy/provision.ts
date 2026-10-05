// scripts/src/deploy/provision.ts
//
// Everything that must exist before the first `apply`, and nothing that belongs
// to one.
//
// The split matters. `apply` is ordered by *dependency* — schema, storage, image,
// jobs, web — because each step needs the previous one. `provision` is ordered by
// *precondition*: the resources `apply` will later bind have to exist, the fixture
// has to be in the bucket, and the runtime secrets have to be installed. Running
// it twice changes nothing, which is the property that makes it safe to call
// before every apply rather than once by hand.
//
// ── Why idempotency is asserted rather than hoped for ─────────────────────────
//
// Every step below is written as *read, then maybe write*. `r2 bucket create` on an
// existing bucket is a provider error; `d1 create` for a name that exists is
// another. Both would abort a provisioning run halfway and leave the operator with
// a partially-created environment and no record of which half. So the existence
// check comes first, and a step that finds its resource reports `ok` with the word
// `already` in its detail rather than pretending it created something.
//
// ── Secrets never reach argv, a log line or an artifact ────────────────────────
//
// `wrangler secret put NAME` reads the value from stdin. Passing it as an
// argument (`--text`, or a shell variable expanded into a command) puts it in the
// process table, in `ps` output, and — on a CI runner — in the debug log that
// records the command. This module therefore builds argv containing *names only*,
// and passes values through the child's stdin. `assertNoSecretInArgv` is the
// negative control that would fail loudly if a future edit broke that.
//
// The source of a value is one of three, and each is explicit:
//   * `env`     — the operator has it exported (a local machine, a CI secret);
//   * `sops`    — a committed encrypted file, decrypted through `secrets/sops.ts`;
//   * `skip`    — do not install; record that the secret is still missing.
//
// `sops` is not the default, because a template cannot carry a recipient. It is
// here because a project that has configured `.sops.yaml` should not need a second
// mechanism.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mediaFixtureKey, PROCESSOR_FIXTURE_ID } from '@starter/schemas/jobs';
import {
  DEPLOY_CREDENTIAL_NAME,
  REQUIRED_TOKEN_SCOPES,
  RUNTIME_SECRET_NAMES,
} from '../registry/app_registry.ts';
import { CLIENT_DIR, REPO_ROOT } from '../shared/paths.ts';
import { runBoundedSync } from '../shared/run_bounded.ts';
import { wranglerBin } from '../shared/tools.ts';
import { remoteConfigPath } from './remote_config.ts';
import type { ResolvedTarget } from './target.ts';

/** The fixture the jobs Workflow fetches by key. Built by `bun run --cwd apps/backend/media`. */
export const FIXTURE_KEY = mediaFixtureKey(PROCESSOR_FIXTURE_ID);

export interface ProvisionStep {
  name: string;
  /** One line, safe to print. Never contains a secret value. */
  description: string;
  /** `already` means the step found its resource and changed nothing. */
  outcome: 'created' | 'already' | 'installed' | 'skipped' | 'failed';
  detail: string;
  /** The argv a reviewer can check. Contains secret *names*, never values. */
  argv: string[];
}

export interface ProvisionResult {
  ok: boolean;
  steps: ProvisionStep[];
  stoppedAt: string | null;
}

/** What actually ran, for a report. Never a value. */
export type CapturedCommand = (args: readonly string[]) => {
  ok: boolean;
  stdout: string;
  stderr: string;
};

/** A mutating invocation that takes a value on stdin, or none at all. */
export type MutatingCommand = (
  args: readonly string[],
  options: { cwd: string; stdin?: string },
) => { ok: boolean; detail: string };

/**
 * Refuse any argv that could carry a credential.
 *
 * Exported so the negative control in the test suite is the same check the module
 * runs, rather than a second implementation of "does this look like a secret".
 * The patterns are the ones Cloudflare, Resend and Better Auth actually use; the
 * check is about *shape*, because a token this repository does not know about is
 * still a token.
 */
export const secretInArgvProblem = (args: readonly string[]): string | null => {
  for (const arg of args) {
    const value = arg.includes(':') ? arg.slice(arg.indexOf(':') + 1) : arg;
    if (/^(v1\.0-|re_[A-Za-z0-9]|ey[A-Za-z0-9_-]{10})/.test(value)) {
      return (
        `Refusing to run: "${arg}" looks like a credential.\n` +
        '  Secret values travel on stdin and never in argv, which the process table and\n' +
        '  a CI debug log can both read. Pass the name and let wrangler prompt.'
      );
    }
  }
  return null;
};

/** Every resource the target binds, and the argv that creates it if absent. */
export interface ProvisionDefinition {
  name: string;
  description: string;
  /** Null when creation assigns a new identity that must be configured/re-planned. */
  create: string[] | null;
  /** A read-only listing. A nonzero exit here means *cannot tell*, never *absent*. */
  exists: string[];
  /** How to answer "is it there?" from a successful read's output. */
  present: (stdout: string) => boolean;
  cwd: string;
}

export const provisionSteps = (target: ResolvedTarget): ProvisionDefinition[] => {
  const steps: ProvisionDefinition[] = [
    {
      name: 'database',
      description: `D1 database ${target.d1DatabaseId}`,
      // A *list*, not `d1 info <id>`.
      //
      // `d1 info` reports a database that does not exist by exiting nonzero — the
      // same signal it gives for a revoked token or the wrong account. An exit code
      // cannot separate those, so "absent" could not be told from "cannot tell", and
      // the second one creates a duplicate. Listing makes presence a question about
      // the *data*, and a nonzero exit unambiguously means "could not tell".
      exists: ['d1', 'list', '--json'],
      present: (stdout) => databaseExists(stdout, target.d1DatabaseId),
      create: null,
      cwd: REPO_ROOT,
    },
  ];

  const bucket = target.compute.mediaBucketName;
  if (target.compute.enabled && bucket !== null) {
    steps.push({
      name: 'bucket',
      description: `private R2 bucket ${target.compute.mediaBucketName}`,
      // Read-only, and the read is the whole idempotency check: a bucket that is
      // listed needs no create, and one that is not listed needs one.
      exists: ['r2', 'bucket', 'list', '--json'],
      present: (stdout) => bucketExists(stdout, bucket),
      create: ['r2', 'bucket', 'create', bucket],
      cwd: REPO_ROOT,
    });
  }

  return steps;
};

/**
 * Whether a bucket name appears in `r2 bucket list --json`.
 *
 * Parsed rather than substring-matched: `grep`-ing a JSON document for a name
 * would also match `my-bucket-staging` when asked about `my-bucket`, and the
 * create that followed would then fail on a name that was never the problem.
 */
/**
 * The array a Wrangler `--json` result carries, in either of its two spellings.
 *
 * Duplicated from `preflight.ts` rather than imported: this module is imported by
 * `preflight.ts`, and a two-function shared helper would be the only reason the two
 * have a cycle. One screen of code is the cheaper trade.
 */
const arrayFromWrangler = (parsed: unknown): unknown[] => {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const result = (parsed as { result?: unknown }).result;
    if (Array.isArray(result)) {
      return result;
    }
  }
  return [];
};

/**
 * Whether a database id appears in `d1 list --json`.
 *
 * Same contract as {@link bucketExists}: parsed, never substring-matched, and
 * unparseable output is "cannot tell" rather than "absent".
 */
export const databaseExists = (stdout: string, id: string): boolean => {
  const entries = arrayFromWrangler(safeParse(stdout));
  return entries.some((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return false;
    }
    const record = entry as Record<string, unknown>;
    return record.uuid === id || record.database_id === id;
  });
};

const safeParse = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

export const bucketExists = (stdout: string, name: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const entries = arrayFromWrangler(parsed);

    return entries.some(
      (entry) =>
        typeof entry === 'object' && entry !== null && (entry as { name?: unknown }).name === name,
    );
  } catch {
    // Unparseable output is "cannot tell", and "cannot tell" must not become
    // "create it": a second bucket with a similar name is a real, billable,
    // invisible mistake.
    return false;
  }
};

/**
 * The fixture upload argv.
 *
 * The bytes come from the crate that generates them, and the key is a constant
 * rather than a value the caller supplies — a fixture key is a contract the
 * Workflow looks up by name, so accepting one from argv would let a deploy upload
 * a different sample than the one the schema admits.
 */
export const fixtureUploadStep = (
  target: ResolvedTarget,
): {
  argv: string[];
  cwd: string;
  /** Repository-relative. Generated, never committed — it is video bytes. */
  source: string;
} | null => {
  if (!target.compute.enabled || target.compute.mediaBucketName === null) {
    return null;
  }

  const source = join('apps', 'backend', 'media', 'fixtures', 'media', 'sample-v1.mp4');
  return {
    source,
    cwd: REPO_ROOT,
    argv: [
      'r2',
      'object',
      'put',
      `${target.compute.mediaBucketName}/${FIXTURE_KEY}`,
      `--file=${source}`,
      '--remote',
    ],
  };
};

/**
 * The secret installation steps, as *plans*.
 *
 * Names only. The value is read at execution time from the operator's environment
 * or from a SOPS-decrypted file, and is written to the child's stdin; it is never
 * a field of this structure, so it cannot be logged by accident from here.
 */
export type SecretSource = 'env' | 'sops' | 'skip';

export const secretPlan = (
  target: ResolvedTarget,
  source: SecretSource,
): { name: string; workerName: string; envVar: string; source: SecretSource; argv: string[] }[] =>
  RUNTIME_SECRET_NAMES.map((name) => ({
    name,
    workerName: target.workerName,
    envVar: name,
    source,
    argv: [
      'secret',
      'put',
      name,
      '--name',
      target.workerName,
      '--config',
      remoteConfigPath({ target }),
    ],
  }));

/** The runtime secrets present in the environment, by name. Values never read. */
export const availableSecrets = (env: NodeJS.ProcessEnv = process.env): string[] =>
  RUNTIME_SECRET_NAMES.filter(
    (name) => typeof env[name] === 'string' && (env[name] as string).trim() !== '',
  );

/**
 * Run provisioning, stopping at the first failure.
 *
 * `capture` and `run` are injected so every branch — including "already exists"
 * and "the fixture is missing" — is reachable without an account. That is not a
 * convenience: this function's entire value is what it does *against a real
 * account*, so a test against a runner that always says yes proves only that the
 * function returns.
 */
export const provision = (
  target: ResolvedTarget,
  options: {
    capture?: CapturedCommand;
    run?: MutatingCommand;
    env?: NodeJS.ProcessEnv;
    root?: string;
    /**
     * Which half to run.
     *
     * `both` is the default and is what `deploy provision` uses. The split exists
     * because `deploy secrets --install` used to run the *whole* provisioner: an
     * operator refreshing one runtime secret also created a database, a bucket and
     * uploaded the fixture. Those are separate authority — different reversibility,
     * different bill, different thing to be surprised by — and a command named
     * `secrets` must not perform them.
     */
    mode?: 'both' | 'resources' | 'secrets';
    /** Install runtime secrets. `false` records them as still missing. */
    installSecrets?: boolean;
    /** Where a secret's value comes from. `sops` is refused, with a remedy. */
    secretSource?: SecretSource;
  } = {},
): ProvisionResult => {
  const env = options.env ?? process.env;
  const root = options.root ?? REPO_ROOT;
  const run = options.run ?? runWranglerMutating;
  const steps: ProvisionStep[] = [];

  const stop = (name: string): ProvisionResult => ({ ok: false, steps, stoppedAt: name });

  // ── resources ──────────────────────────────────────────────────────────────
  const capture = options.capture;
  const mode = options.mode ?? 'both';
  const definitions = mode === 'secrets' ? [] : provisionSteps(target);

  for (const definition of definitions) {
    const argv = [...definition.exists];
    const leak = secretInArgvProblem(argv);
    if (leak !== null) {
      steps.push({
        name: definition.name,
        description: definition.description,
        outcome: 'failed',
        detail: leak,
        argv,
      });
      return stop(definition.name);
    }

    let alreadyPresent = false;
    let detail = '';

    if (capture === undefined) {
      // No capture injected means the caller is not running an authenticated
      // preflight; provisioning cannot tell whether the resource exists, so it
      // says so instead of guessing and creating a duplicate.
      detail =
        'Existence cannot be checked without a capture function. Run `bun run deploy:preflight` first, ' +
        'which is read-only.';
      steps.push({
        name: definition.name,
        description: definition.description,
        outcome: 'failed',
        detail,
        argv,
      });
      return stop(definition.name);
    }

    // Three answers, not two.
    //
    // This used to be `if (exists) skip else create`, which treats a *failed* read
    // as an absent resource: a revoked token, a network blip or a wrong account all
    // answered `!ok`, and the next line created a second database or a second bucket
    // under a name that already exists. Both are real, billable, and invisible.
    //
    // "Could not tell" is now its own outcome, and it stops the run with the remedy.
    const listed = capture(definition.exists);
    if (!listed.ok) {
      detail =
        `Could not read ${definition.description}, so this cannot tell whether it exists.\n` +
        '  Refusing to create it: an unreadable resource is not an absent one, and a\n' +
        '  duplicate database or bucket is a real cost under a name nobody was looking for.\n' +
        '  Fix the credential or the network, then re-run:\n' +
        `    bun run deploy:preflight --env ${target.environment}`;
      steps.push({
        name: definition.name,
        description: definition.description,
        outcome: 'failed',
        detail,
        argv,
      });
      return stop(definition.name);
    }

    alreadyPresent = definition.present(listed.stdout);

    if (alreadyPresent) {
      steps.push({
        name: definition.name,
        description: definition.description,
        outcome: 'already',
        detail: `already present; nothing was changed`,
        argv,
      });
      continue;
    }

    if (definition.create === null) {
      steps.push({
        name: definition.name,
        description: definition.description,
        outcome: 'failed',
        detail: `The configured D1 ID is absent. Refusing to create a replacement with a different ID. Run deploy:configure -- --env ${target.environment} --provision, then review a new plan.`,
        argv,
      });
      return stop(definition.name);
    }
    const created = run(definition.create, { cwd: definition.cwd });
    steps.push({
      name: definition.name,
      description: definition.description,
      outcome: created.ok ? 'created' : 'failed',
      detail: created.ok ? `created: ${definition.description}` : created.detail,
      argv: definition.create,
    });
    if (!created.ok) {
      return stop(definition.name);
    }
  }

  // ── fixture ────────────────────────────────────────────────────────────────
  // Gated with the resources: uploading the fixture is a write, and
  // `deploy secrets` must not perform one.
  const fixture = mode === 'secrets' ? null : fixtureUploadStep(target);
  if (fixture !== null) {
    const built = join(root, fixture.source);
    if (!existsSync(built)) {
      steps.push({
        name: 'fixture',
        description: `upload ${FIXTURE_KEY}`,
        outcome: 'failed',
        detail:
          `The sample fixture is not built at ${fixture.source}.\n` +
          '  It is generated, not committed, because it is video bytes:\n' +
          '    bun run --cwd apps/backend/media fixture\n' +
          '  Nothing was uploaded.',
        argv: fixture.argv,
      });
      return stop('fixture');
    }

    const uploaded = run(fixture.argv, { cwd: fixture.cwd });
    steps.push({
      name: 'fixture',
      description: `upload ${FIXTURE_KEY}`,
      // An overwrite of identical bytes: reported as `created` because the effect
      // the encode path depends on — the key exists with the right content — is
      // the same either way, and claiming "already" would require a read that
      // costs a full object download.
      outcome: uploaded.ok ? 'created' : 'failed',
      detail: uploaded.ok ? `uploaded ${FIXTURE_KEY}` : uploaded.detail,
      argv: fixture.argv,
    });
    if (!uploaded.ok) {
      return stop('fixture');
    }
  }

  // ── secrets ────────────────────────────────────────────────────────────────
  if (mode === 'resources') {
    // `deploy provision` without `--install` deliberately leaves the secrets alone and
    // says so, so the report cannot be read as "this release can sign someone in".
    steps.push({
      name: 'secrets',
      description: `install ${RUNTIME_SECRET_NAMES.join(', ')} on ${target.workerName}`,
      outcome: 'skipped',
      detail:
        'not installed by this command. `deploy provision` creates resources; it does not\n' +
        '  write credentials unless asked to:\n' +
        `    bun run deploy:secrets --env ${target.environment} --yes --install\n` +
        '  Nothing was installed.',
      argv: [],
    });
    return { ok: true, steps, stoppedAt: null };
  }

  if (options.secretSource === 'sops') {
    steps.push({
      name: 'secrets',
      description: `install ${RUNTIME_SECRET_NAMES.join(', ')} from SOPS`,
      outcome: 'failed',
      detail:
        'SOPS decryption is deliberately not done here.\n' +
        '  This module already handles a value without ever naming it, so the simpler\n' +
        '  composition is to let the existing SOPS runner decrypt and export, and install\n' +
        '  from the environment:\n' +
        '    bun run secrets:exec --env BETTER_AUTH_SECRET=<ct> --env RESEND_API_KEY=<ct> -- \\\n' +
        '      bun run deploy:secrets --env ' +
        target.environment +
        ' --install\n' +
        '  Nothing was installed.',
      argv: [],
    });
    return stop('secrets');
  }

  for (const plan of secretPlan(target, options.secretSource ?? 'env')) {
    if (options.installSecrets !== true) {
      steps.push({
        name: `secret:${plan.name}`,
        description: `install ${plan.name} on ${plan.workerName}`,
        outcome: 'skipped',
        detail:
          'not installed: pass --install-secrets with the value exported, or run\n' +
          `    bun run deploy:secrets --env ${target.environment} --yes --install`,
        argv: plan.argv,
      });
      continue;
    }

    const value = env[plan.envVar];
    if (typeof value !== 'string' || value.trim() === '') {
      steps.push({
        name: `secret:${plan.name}`,
        description: `install ${plan.name} on ${plan.workerName}`,
        outcome: 'failed',
        detail:
          `${plan.envVar} is not in the environment, so there is nothing to install.\n` +
          `  ${DEPLOY_CREDENTIAL_NAME} authorises this tooling; it is not the runtime secret and\n` +
          '  cannot stand in for one.',
        argv: plan.argv,
      });
      return stop(`secret:${plan.name}`);
    }

    // The value goes here and nowhere else.
    const installed = run(plan.argv, { cwd: CLIENT_DIR, stdin: `${value.trim()}\n` });
    steps.push({
      name: `secret:${plan.name}`,
      description: `install ${plan.name} on ${plan.workerName}`,
      outcome: installed.ok ? 'installed' : 'failed',
      detail: installed.ok ? `${plan.name} installed on ${plan.workerName}` : installed.detail,
      argv: plan.argv,
    });
    if (!installed.ok) {
      return stop(`secret:${plan.name}`);
    }
  }

  void availableSecrets;
  return { ok: true, steps, stoppedAt: null };
};

/**
 * The real mutating runner.
 *
 * Bounded in every dimension this repository insists on: output is captured rather
 * than inherited (a bucket name printed to a CI log is harmless; a token echoed by
 * a tool is not), the child is killed as a tree on timeout, and the value arrives
 * on stdin.
 */
export const runWranglerMutating: MutatingCommand = (args, options) => {
  const bin = wranglerBin();
  if (bin === null) {
    return {
      ok: false,
      detail: 'wrangler is not installed in this workspace. Run `bun install`.',
    };
  }

  const leak = secretInArgvProblem(args);
  if (leak !== null) {
    return { ok: false, detail: leak };
  }

  const result = runBoundedSync({
    command: bin,
    args,
    cwd: options.cwd,
    input: options.stdin ?? '',
    timeoutMs: 10 * 60_000,
  });

  if (result.code !== 0) {
    const raw = (result.stderr || result.stdout).trim();
    const value = options.stdin?.trim();
    const safe = value ? raw.replaceAll(value, '[REDACTED]') : raw;
    const detail = safe.split('\n').slice(0, 4).join('\n');
    return {
      ok: false,
      detail: detail === '' ? `wrangler exited ${String(result.code)}` : detail,
    };
  }

  return { ok: true, detail: 'ok' };
};

/** Render a provisioning run for a person. Never prints a value. */
export const renderProvision = (result: ProvisionResult): string => {
  const lines = ['Provisioning'];
  for (const step of result.steps) {
    let mark = 'ok  ';
    if (step.outcome === 'failed') {
      mark = 'FAIL';
    } else if (step.outcome === 'skipped') {
      mark = 'skip';
    }
    lines.push(`  ${mark} ${step.name.padEnd(18)} ${step.detail}`);
  }
  if (result.stoppedAt !== null) {
    lines.push(
      '',
      `Stopped at: ${result.stoppedAt}. Everything before it ran; nothing after it did.`,
    );
  }
  return lines.join('\n');
};

/**
 * The token scopes this pipeline needs, derived from the operations it performs.
 *
 * Printed by `plan` and `preflight` so an operator creating a scoped token reads the
 * requirement from the tool that needs it rather than from documentation that may
 * have drifted from the code.
 */
export const describeTokenScopes = (): string =>
  REQUIRED_TOKEN_SCOPES.map((scope) => `  ${scope.permission} — ${scope.neededBy}`).join('\n');
