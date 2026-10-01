// .pi/lib/herdr_cli.ts
//
// The boundary to Herdr, expressed as a named capability that can be absent.
//
// 🔴 Three rules, from Herdr's own agent guide rather than from taste:
//
//   1. **Absence is a named value, not an exception.** A machine without `herdr`
//      is the normal case for anyone who cloned this template, and an extension
//      that throws at import time takes the whole agent down with it. So nothing
//      here runs at module load, and `probe()` returns a verdict rather than
//      throwing. Pi starts either way.
//
//   2. **Identifiers are read, never predicted.** Workspace, tab and pane ids
//      are opaque handles the server allocates. `wPH:p2` in a test and a
//      workspace id that changes on every restart are both normal. Every id this
//      module accepts comes from a previous command's JSON.
//
//   3. **Never touch what the user owns.** This session's own workspace, tab and
//      pane are read through the inherited `HERDR_*` context and are never
//      closed, stopped, reloaded or detached. Worktree creation defaults to
//      `--no-focus` so an agent starting a workspace does not steal the user's
//      keyboard focus mid-sentence.
//
// The flags below were read from `herdr worktree <sub> --help` on the installed
// binary. They are not a guess, but they are also not a promise: `capabilityHelp()`
// re-reads them from the installed CLI so an upgrade surfaces as text the model
// can see rather than as an unknown-flag error.

import type { BoundedRunResult } from './process.ts';

export type HerdrRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; maxBytes: number },
) => Promise<BoundedRunResult>;

/** The binary name, resolved from PATH by the spawner. Never a hardcoded path. */
export const HERDR_BIN = 'herdr';

/** The env var Herdr injects into a managed pane. `1` means "you are inside". */
export const HERDR_ENV_VAR = 'HERDR_ENV';

export const BOUNDS = { timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024 } as const;

/**
 * Whether this session is running inside a Herdr-managed pane.
 *
 * Herdr's guide is explicit that an agent outside a managed pane should not
 * inspect or control the focused session "from outside Herdr" — it would be
 * operating on somebody else's terminal. So this is checked before any control
 * action, not just reported.
 */
export const insideHerdr = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[HERDR_ENV_VAR] === '1';

/** The inherited caller context. This session's own ids, read-only. */
export interface HerdrContext {
  inside: boolean;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
}

export const sessionContext = (env: NodeJS.ProcessEnv = process.env): HerdrContext => ({
  inside: insideHerdr(env),
  ...(env.HERDR_WORKSPACE_ID === undefined ? {} : { workspaceId: env.HERDR_WORKSPACE_ID }),
  ...(env.HERDR_TAB_ID === undefined ? {} : { tabId: env.HERDR_TAB_ID }),
  ...(env.HERDR_PANE_ID === undefined ? {} : { paneId: env.HERDR_PANE_ID }),
});

/**
 * The verdict for an optional external capability.
 *
 * `available: false` is a legitimate, reportable state — not a failure and not a
 * silent skip. The requirement is that a model can tell "Herdr is not installed"
 * apart from "the command I ran failed", because only the second one is worth
 * retrying.
 */
export interface Capability {
  name: 'herdr';
  available: boolean;
  /** One line, phrased for the user. */
  reason: string;
  version?: string;
}

const UNAVAILABLE = (reason: string): Capability => ({ name: 'herdr', available: false, reason });

/**
 * Ask the installed CLI whether it is there and how old it is.
 *
 * `herdr --version` is the one invocation that cannot mutate anything, so it is
 * safe to use as the liveness probe — unlike `herdr` with no arguments, which
 * launches or attaches the TUI.
 */
export const probe = async (
  cwd: string,
  run: HerdrRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Capability> => {
  if (!insideHerdr(env)) {
    return UNAVAILABLE(
      `${HERDR_ENV_VAR} is not 1, so this session is not running inside a Herdr-managed pane. ` +
        'Herdr deliberately does not let an outside agent inspect or control a session, so the ' +
        'capability is unavailable here rather than failed. Normal development needs nothing from Herdr.',
    );
  }

  let result: BoundedRunResult;
  try {
    result = await run(HERDR_BIN, ['--version'], { cwd, ...BOUNDS });
  } catch (error) {
    return UNAVAILABLE(
      `\`${HERDR_BIN}\` is not on PATH (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  if (result.code !== 0) {
    return UNAVAILABLE(
      `\`${HERDR_BIN} --version\` exited ${result.code}. ` +
        `${(result.stderr.trim() || 'no stderr').slice(0, 300)}`,
    );
  }

  return {
    name: 'herdr',
    available: true,
    reason: 'the herdr CLI is installed and this session is inside a Herdr-managed pane',
    version: (result.stdout || result.stderr).trim().split('\n')[0] ?? '',
  };
};

/**
 * The subset of a Herdr JSON response this module reads.
 *
 * Every id is optional on purpose. An unrecognised shape then degrades to "no id
 * in the response", which the callers report, rather than a property access that
 * throws deep inside an extension.
 */
export interface HerdrEnvelope {
  id?: string;
  result?: {
    workspace?: {
      workspace_id?: string;
      worktree?: { checkout_path?: string; repo_root?: string; repo_name?: string };
      active_tab_id?: string;
    };
    worktree?: {
      path?: string;
      branch?: string;
      open_workspace_id?: string;
      is_linked_worktree?: boolean;
    };
    worktrees?: Array<{
      path?: string;
      branch?: string;
      open_workspace_id?: string;
      is_linked_worktree?: boolean;
    }>;
    type?: string;
  };
}

/**
 * Parse a Herdr response.
 *
 * Returns `undefined` for anything unparseable, with the reason, because the
 * alternative — treating garbage as an empty result — reports "no worktrees" for
 * a command that actually failed.
 */
export const parseEnvelope = (
  raw: string,
): { ok: true; envelope: HerdrEnvelope } | { ok: false; reason: string } => {
  const text = raw.trim();
  if (text === '') {
    return { ok: false, reason: 'herdr returned no output' };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    // `Array.isArray` is checked as well as `typeof object`, because an array
    // passes the latter. Accepting `[]` would report "no worktrees" for a
    // response that never had the expected shape.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: 'herdr returned JSON that is not an object' };
    }
    return { ok: true, envelope: parsed as HerdrEnvelope };
  } catch {
    return { ok: false, reason: `herdr returned non-JSON output: ${text.slice(0, 300)}` };
  }
};

export type WorktreeAction = 'list' | 'create' | 'open' | 'remove';

export interface WorktreeParams {
  /** Herdr workspace id. Required for `remove`; optional to disambiguate elsewhere. */
  workspace?: string;
  /** Repository the worktree belongs to. */
  cwd?: string;
  branch?: string;
  /** Base ref for `create`, e.g. `main`. */
  base?: string;
  /** Explicit checkout path. */
  path?: string;
  label?: string;
  /** Whether to move the user's focus. Defaults to false — see rule 3. */
  focus?: boolean;
  /** `--force` on remove. Never defaulted on. */
  force?: boolean;
  /** `--trust-repository`, which Herdr requires before it acts on a checkout. */
  trustRepository?: boolean;
}

/**
 * Build argv for `herdr worktree <action>`.
 *
 * Flags are emitted only when supplied, except `--focus`/`--no-focus` and
 * `--trust-repository`, which Herdr's own guide requires be stated explicitly:
 * their absence is ambiguous, and an ambiguous trust decision is the one Herdr
 * is careful about.
 *
 * `remove` has no defaults at all — it is the only irreversible action here, so
 * it demands an explicit target and says so rather than guessing.
 */
export const buildWorktreeArgs = (
  action: WorktreeAction,
  params: WorktreeParams = {},
): string[] => {
  const args = ['worktree', action];

  const flag = (name: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') {
      args.push(name, value);
    }
  };

  flag('--workspace', params.workspace);
  flag('--cwd', params.cwd);
  flag('--branch', params.branch);
  flag('--base', params.base);
  flag('--path', params.path);
  flag('--label', params.label);

  // Stated explicitly in both directions. Never left implicit.
  args.push(params.focus === true ? '--focus' : '--no-focus');

  if (params.trustRepository === true) {
    args.push('--trust-repository');
  }

  // `--force` only ever when asked. A template that defaults to force-deleting a
  // checkout would be a foot-gun in a repository it does not own.
  if (action === 'remove' && params.force === true) {
    args.push('--force');
  }

  return args;
};

/**
 * Why an action cannot proceed, or `undefined` when it can.
 *
 * Returned rather than thrown so the tool can present a refusal the same way it
 * presents any other answer, and so a refusal has a reason attached.
 */
export const validateWorktreeParams = (
  action: WorktreeAction,
  params: WorktreeParams,
): string | undefined => {
  if (action === 'remove') {
    if (params.workspace === undefined || params.workspace === '') {
      return (
        'worktree remove needs an explicit --workspace id. Read it from ' +
        '`herdr worktree list` rather than guessing: removing the wrong workspace deletes a checkout.'
      );
    }
    return undefined;
  }

  if (action === 'create' && params.branch === undefined && params.path === undefined) {
    return 'worktree create needs a branch or an explicit path; Herdr will not invent either.';
  }

  if (
    action === 'open' &&
    params.workspace === undefined &&
    params.path === undefined &&
    params.branch === undefined
  ) {
    return 'worktree open needs a workspace id, a path or a branch to identify the checkout.';
  }

  return undefined;
};

/**
 * Read a command group's own help.
 *
 * Herdr's guide is emphatic that the installed binary is the authority for
 * syntax, and that the agent should print the relevant group rather than probe a
 * mutating command by omitting arguments. That is exactly what this does, so a
 * Herdr upgrade that renames a flag shows up as text instead of as a guess.
 *
 * `herdr <group>` with no subcommand prints help for read-only groups. This
 * always passes `--help`, which is unambiguous and cannot execute anything.
 */
export const buildHelpArgs = (group: string | undefined): string[] => {
  const trimmed = group?.trim() ?? '';
  // An absent or blank group means top-level help, never a bare group name. Herdr's
  // guide is explicit that a bare mutating subcommand runs with defaults, so
  // `--help` is stated in both branches rather than implied by omission.
  return trimmed === '' ? ['--help'] : [trimmed, '--help'];
};

/** Command groups whose bare form is safe and is the documented discovery path. */
export const HERDR_GROUPS = [
  'agent',
  'api',
  'config',
  'integration',
  'machine',
  'notification',
  'pane',
  'session',
  'tab',
  'workspace',
  'worktree',
] as const;
