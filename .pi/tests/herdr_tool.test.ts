// .pi/tests/herdr_tool.test.ts
//
// The Herdr tool, driven end-to-end against a fake CLI that speaks the real
// response shapes.
//
// Everything here goes through the production path — the extension's registered
// `execute`, `.pi/lib/herdr_cli.ts`, and the bounded runner in
// `.pi/lib/process.ts`. Only the binary is substituted.
//
// The three properties under test, each of which has a specific bad outcome:
//
//   1. **Ids come from responses.** A workspace id that appears in the output must
//      be the one the CLI returned. A predicted `w1` is how an agent ends up
//      operating on somebody else's workspace.
//   2. **Absence is distinguishable from failure.** "Not on PATH" and "exited 1"
//      are different answers, and only the second is worth retrying.
//   3. **Nothing destructive runs unasked.** No `--force`, no focus, no session
//      teardown — asserted on the argv the fake actually received.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import herdrExtension from '../extensions/herdr.ts';
import { fakeBin, scratchDir } from './fake_bin.ts';
import { fakeHerdr, WORKTREE_CREATED, WORKTREE_LIST } from './fake_herdr.ts';

/**
 * A `cwd` that really is a repository.
 *
 * The tool refuses a path with no `.git` in it, because Herdr resolves the target
 * from that path and a wrong one acts on a different checkout. So the fixture has
 * to be a repository rather than an arbitrary string: `.git` is a **file** in a
 * linked worktree and a **directory** in an ordinary checkout, and it is created
 * as a directory because that is what an ordinary clone looks like.
 */
const REPO = ((): string => {
  const dir = scratchDir('herdr-repo');
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
})();

interface RegisteredTool {
  name: string;
  description: string;
  promptSnippet?: string;
  execute: (
    toolCallId: string,
    rawParams: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}

const fakes: FakeHerdrHandle[] = [];

/** Local alias so the cleanup array reads without importing the type twice. */
type FakeHerdrHandle = ReturnType<typeof fakeHerdr>;

afterEach(() => {
  restoreEnv();
  for (const fake of fakes.splice(0)) {
    fake.cleanup();
  }
});

/**
 * Load the extension's dispatcher and put a fake `herdr` first on PATH.
 *
 * PATH is mutated rather than the binary path injected, because that is the only
 * way to exercise the real `spawn('herdr', …)` lookup — which is precisely what
 * has to work when Herdr *is* installed.
 */
/**
 * The environment every test starts from, restored after each one.
 *
 * Restored rather than mutated in place because these tests change `PATH` and
 * `HERDR_ENV`, and bun runs a file's tests in one process: a test that leaks
 * either variable makes the *next* one pass or fail for the wrong reason. That
 * is not hypothetical — two of the failures during development were exactly a
 * previous test's `PATH` leaking into the next.
 */
const ENV_SNAPSHOT = {
  PATH: process.env.PATH,
  HERDR_ENV: process.env.HERDR_ENV,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

const restoreEnv = (): void => {
  for (const key of [
    'PATH',
    'HERDR_ENV',
    'OPENROUTER_API_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ] as const) {
    const value = ENV_SNAPSHOT[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

/**
 * Load the extension's dispatcher and put a fake `herdr` first on PATH.
 *
 * PATH is mutated rather than the binary path injected, because that is the only
 * way to exercise the real `spawn('herdr', …)` resolution — which is precisely
 * what has to work when Herdr *is* installed.
 */
const withTool = (fake: FakeHerdrHandle, env: { inside?: boolean } = {}) => {
  fakes.push(fake);

  const tools: RegisteredTool[] = [];
  const pi = { registerTool: (tool: RegisteredTool) => void tools.push(tool) };
  herdrExtension(pi as unknown as ExtensionAPI);

  const tool = tools[0];
  if (tool === undefined) {
    throw new Error('the herdr extension registered no tool');
  }

  process.env.PATH = `${fake.dir}:${ENV_SNAPSHOT.PATH ?? ''}`;
  // Herdr's own agent guide: only a pane Herdr manages may be controlled.
  if (env.inside === false) {
    delete process.env.HERDR_ENV;
  } else {
    process.env.HERDR_ENV = '1';
  }

  return { tool, call: (params: unknown) => tool.execute('t1', params) };
};

const text = (result: Awaited<ReturnType<RegisteredTool['execute']>>): string =>
  result.content.map((part) => part.text).join('\n');

const CREATE_ARGS = {
  cwd: REPO,
  branch: 'pr-f',
  base: 'main',
} as const;

describe('availability', () => {
  test('reports available with a version when the CLI answers', async () => {
    const fake = fakeHerdr({ version: 'herdr 0.9.1' });
    const { call } = withTool(fake);

    const result = await call({ action: 'status' });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('AVAILABLE');
    expect(text(result)).toContain('0.9.1');
    // `--version` only. A bare `herdr` launches the TUI and takes over the user's
    // terminal.
    expect(fake.calls()).toEqual(['--version']);
  }, 30_000);

  test('reports a named unavailable capability when the binary is absent', async () => {
    // Nothing on PATH at all. This is the normal case for anyone who cloned the
    // template, so it must be an answer rather than an error.
    const fake = fakeHerdr({});
    fakes.push(fake);
    process.env.PATH = '/nonexistent';
    process.env.HERDR_ENV = '1';

    const tools: RegisteredTool[] = [];
    herdrExtension({
      registerTool: (t: RegisteredTool) => void tools.push(t),
    } as unknown as ExtensionAPI);
    const tool = tools[0];
    if (tool === undefined) {
      throw new Error('the herdr extension registered no tool');
    }

    const result = await tool.execute('t1', { action: 'status' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('UNAVAILABLE');
    expect(text(result)).toContain('not on PATH');
    // And it must say development does not depend on it, or the model goes
    // looking for a broken repository.
    expect(text(result)).toContain('does not need Herdr');
  }, 30_000);

  test('a failing CLI is a failure, and says what it printed', async () => {
    // `--version` is answered successfully, so the tool gets past the capability
    // check and the *action* is what fails. Distinct from the binary being absent.
    const fake = fakeHerdr({
      exitCode: 1,
      stderr: 'socket: no such file',
      fallback: '{}',
    });
    const { call } = withTool(fake);

    const result = await call({ action: 'worktree_list', params: { cwd: REPO } });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('exited 1');
    expect(text(result)).toContain('socket');
  }, 30_000);

  test('a session outside a managed pane is refused before any CLI call', async () => {
    // Herdr does not let an outside agent inspect or control a session. Checking
    // first means nothing is spawned at all — asserted on the fake's call log.
    const fake = fakeHerdr({});
    const { call } = withTool(fake, { inside: false });

    const result = await call({ action: 'worktree_list', params: { cwd: REPO } });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not running inside a Herdr-managed pane');
    expect(fake.calls()).toEqual([]);
  }, 30_000);
});

describe('reading worktrees', () => {
  test('reports ids and paths exactly as the CLI returned them', async () => {
    const fake = fakeHerdr({
      responses: { [`worktree list --cwd ${REPO} --no-focus`]: JSON.stringify(WORKTREE_LIST) },
    });
    const { call } = withTool(fake);

    const result = await call({ action: 'worktree_list', params: { cwd: REPO } });

    expect(result.isError).toBeFalsy();
    // The ids, verbatim. A predicted id is how an agent operates on the wrong
    // workspace while reporting success.
    expect(text(result)).toContain('wPH');
    expect(text(result)).toContain('wPK');
    expect(text(result)).toContain('main');
    expect(text(result)).toContain('pr-f-agent-integration');
    // And the caution that ids are per-server and opaque.
    expect(text(result)).toContain('opaque');
  }, 30_000);

  test('an empty list is stated, not rendered as a blank table', async () => {
    const fake = fakeHerdr({
      responses: {
        [`worktree list --cwd ${REPO} --no-focus`]: JSON.stringify({
          id: 'cli:worktree:list',
          result: { type: 'worktree_list', worktrees: [] },
        }),
      },
    });
    const { call } = withTool(fake);

    const result = await call({ action: 'worktree_list', params: { cwd: REPO } });
    expect(text(result)).toContain('no worktree workspaces');
  }, 30_000);

  test('unparseable output is reported rather than read as no worktrees', async () => {
    // The distinction that matters: "there are none" and "the command failed" must
    // not look the same, or a broken Herdr reads as a clean repository.
    const fake = fakeHerdr({
      responses: { [`worktree list --cwd ${REPO} --no-focus`]: 'error: socket gone' },
    });
    const { call } = withTool(fake);

    const result = await call({ action: 'worktree_list', params: { cwd: REPO } });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('non-JSON');
    expect(text(result)).toContain('Nothing was listed');
  }, 30_000);
});

describe('creating a worktree', () => {
  test('returns the checkout path and workspace id from the response', async () => {
    const fake = fakeHerdr({
      responses: {
        [`worktree create --cwd ${REPO} --branch pr-f --base main --no-focus`]:
          JSON.stringify(WORKTREE_CREATED),
      },
    });
    const { call } = withTool(fake);

    const result = await call({ action: 'worktree_create', params: CREATE_ARGS });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('/tmp/x/.herdr/worktrees/starter/pr-f');
    expect(text(result)).toContain('wPK');
    // The fixture response names a checkout that does not exist on this host, so
    // the extension must state the real bootstrap command rather than claim it ran.
    expect(text(result)).toContain('bun run worktree:bootstrap');
  }, 30_000);

  test('a real new checkout is bootstrapped by the pinned shell without inheriting review credentials', async () => {
    const target = mkdtempSync(join(tmpdir(), 'herdr-created-checkout-'));
    mkdirSync(join(target, '.git'));
    const source = structuredClone(WORKTREE_CREATED);
    source.result.workspace.worktree.checkout_path = target;
    source.result.worktree.path = target;
    const herdr = fakeHerdr({
      responses: {
        [`worktree create --cwd ${REPO} --branch pr-f --base main --no-focus`]:
          JSON.stringify(source),
      },
    });
    const argsPath = join(target, 'nix-args.txt');
    const nix = fakeBin(
      'nix',
      `test -z "\${OPENROUTER_API_KEY:-}" || exit 91\ntest -z "\${SUPABASE_SERVICE_ROLE_KEY:-}" || exit 92\nprintf '%s\\n' "$@" > "${argsPath}"\nexit 0`,
    );
    const { call } = withTool(herdr);
    process.env.PATH = `${nix.dir}:${process.env.PATH ?? ''}`;
    process.env.OPENROUTER_API_KEY = 'private-review-fixture';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'private-admin-fixture';
    try {
      const result = await call({ action: 'worktree_create', params: CREATE_ARGS });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('bootstrapped with its pinned runtime');
      expect(readFileSync(argsPath, 'utf8')).toContain('worktree:bootstrap');
      expect(readFileSync(argsPath, 'utf8')).not.toContain('private-review-fixture');
      expect(readFileSync(argsPath, 'utf8')).not.toContain('private-admin-fixture');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }, 30_000);

  test('does not steal the user focus', async () => {
    const fake = fakeHerdr({
      responses: {
        [`worktree create --cwd ${REPO} --branch pr-f --base main --no-focus`]:
          JSON.stringify(WORKTREE_CREATED),
      },
    });
    const { call } = withTool(fake);

    await call({ action: 'worktree_create', params: CREATE_ARGS });

    // Asserted on the argv the CLI received, not on the tool's own flags.
    expect(fake.calls()).toEqual([
      '--version',
      `worktree create --cwd ${REPO} --branch pr-f --base main --no-focus`,
    ]);
    expect(fake.calls().join(' ')).toContain('--no-focus');
  }, 30_000);

  test('focus is passed only when explicitly requested', async () => {
    const fake = fakeHerdr({
      responses: {
        [`worktree create --cwd ${REPO} --branch pr-f --base main --focus`]:
          JSON.stringify(WORKTREE_CREATED),
      },
    });
    const { call } = withTool(fake);

    await call({ action: 'worktree_create', params: { ...CREATE_ARGS, focus: true } });
    expect(fake.calls().join(' ')).toContain('--focus');
  }, 30_000);
});

describe('refusals that protect the user', () => {
  test('remove without a workspace id runs nothing', async () => {
    const fake = fakeHerdr({});
    const { call } = withTool(fake);

    const result = await call({ action: 'worktree_remove', params: {} });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('--workspace');
    expect(text(result)).toContain('herdr worktree list');
    // The version probe ran; the destructive command did not.
    expect(fake.calls().join('\n')).not.toContain('worktree remove');
    expect(fake.calls().join(' ')).not.toContain('--force');
  }, 30_000);

  test('remove never passes --force unless asked', async () => {
    const fake = fakeHerdr({
      responses: {
        'worktree remove --workspace wPK --no-focus': JSON.stringify({
          id: 'cli:worktree:remove',
          result: { type: 'worktree_removed' },
        }),
      },
    });
    const { call } = withTool(fake);

    const result = await call({ action: 'worktree_remove', params: { workspace: 'wPK' } });

    expect(result.isError).toBeFalsy();
    expect(fake.calls().join(' ')).not.toContain('--force');
  }, 30_000);

  test('no action ever touches a session command', async () => {
    // `herdr session` controls persistent sessions; closing or restarting one
    // destroys whatever state the user has in it. This tool must never do that.
    const fake = fakeHerdr({});
    const { call } = withTool(fake);

    for (const action of ['status', 'worktree_list', 'help', 'worktree_open']) {
      await call({ action, params: { workspace: 'wPK' } });
    }

    const sent = fake.calls().join('\n');
    expect(sent).not.toContain('session');
    expect(sent).not.toContain('server stop');
    expect(sent).not.toContain('reload-config');
  }, 30_000);

  test('create without a branch or a path is refused before spawning', async () => {
    const fake = fakeHerdr({});
    const { call } = withTool(fake);

    const result = await call({ action: 'worktree_create', params: { cwd: REPO } });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('branch or an explicit path');
    expect(fake.calls().join(' ')).not.toContain('worktree create');
  }, 30_000);
});

describe('the repository is named, never guessed', () => {
  test('create without a cwd is refused before spawning anything', async () => {
    // The regression. With no `cwd`, Herdr resolves a repository itself, and the one
    // it picked was an unrelated dotfiles project: `worktree_create` returned its
    // real path and a real workspace id and reported success, so nothing looked
    // wrong until every later command ran against the wrong repository.
    const fake = fakeHerdr({});
    const { call } = withTool(fake);

    const result = await call({ action: 'worktree_create', params: { branch: 'pr-g' } });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('needs `cwd`');
    // The remedy names what to pass, because "add cwd" alone leaves a model
    // guessing what counts as a repository root.
    expect(text(result)).toContain('contains `.git`');
    // Nothing spawned: not the create, and not the version probe that would
    // otherwise have succeeded and made this look like a working call.
    expect(fake.calls().join(' ')).not.toContain('worktree create');
  }, 30_000);

  test('list without a cwd is refused too, though it only reads', async () => {
    // An inventory of the wrong repository's worktrees is a wrong answer that
    // looks like a right one, and the id it reports is then used to remove one.
    const fake = fakeHerdr({});
    const { call } = withTool(fake);

    const result = await call({ action: 'worktree_list' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('needs `cwd`');
    expect(fake.calls().join(' ')).not.toContain('worktree list');
  }, 30_000);

  test('open without a cwd is refused before spawning anything', async () => {
    const fake = fakeHerdr({});
    const { call } = withTool(fake);

    const result = await call({ action: 'worktree_open', params: { branch: 'main' } });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('needs `cwd`');
    expect(fake.calls().join(' ')).not.toContain('worktree open');
  }, 30_000);

  test('a cwd that is not a git repository is refused, naming the path', async () => {
    // Presence is not validity: every other check passes a typo'd path through,
    // and Herdr resolves the target from it.
    const fake = fakeHerdr({});
    const { call } = withTool(fake);

    const result = await call({
      action: 'worktree_create',
      params: { cwd: '/tmp', branch: 'pr-g' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('is not a git repository');
    expect(text(result)).toContain('/tmp');
    expect(fake.calls().join(' ')).not.toContain('worktree create');
  }, 30_000);

  test('remove needs no cwd: a workspace id already names its checkout', async () => {
    // Requiring one here would be wrong in the other direction. It is exempt from
    // the check and still reaches the fake, which is what proves the exemption is
    // deliberate rather than an oversight.
    const fake = fakeHerdr({
      responses: {
        'worktree remove --workspace wPK --no-focus': JSON.stringify({
          id: 'cli:worktree:remove',
          result: { type: 'worktree_removed', workspace_id: 'wPK' },
        }),
      },
    });
    const { call } = withTool(fake);

    const result = await call({ action: 'worktree_remove', params: { workspace: 'wPK' } });

    expect(result.isError).toBeFalsy();
    expect(fake.calls().join('\n')).toContain('worktree remove --workspace wPK');
  }, 30_000);

  test('a linked worktree is a valid cwd: .git is a file there, not a directory', async () => {
    // The stricter `isDirectory()` check refuses every worktree, which is the one
    // place this runs from.
    const linked = scratchDir('herdr-linked');
    writeFileSync(join(linked, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');

    const fake = fakeHerdr({
      responses: {
        [`worktree list --cwd ${linked} --no-focus`]: JSON.stringify(WORKTREE_LIST),
      },
    });
    const { call } = withTool(fake);

    const result = await call({ action: 'worktree_list', params: { cwd: linked } });

    expect(result.isError).toBeFalsy();
    expect(fake.calls().join('\n')).toContain('worktree list');
  }, 30_000);
});

describe('discovery', () => {
  test('help always requests help, so no command can execute', async () => {
    const fake = fakeHerdr({
      responses: {
        'worktree create --help': 'Usage: herdr worktree create [OPTIONS]',
        '--help': 'Usage: herdr [options]',
      },
    });
    const { call } = withTool(fake);

    const grouped = await call({ action: 'help', params: { group: 'worktree create' } });
    const top = await call({ action: 'help' });

    expect(text(grouped)).toContain('Usage: herdr worktree create');
    expect(text(top)).toContain('Usage: herdr [options]');
    // Herdr's guide is explicit: do not probe a mutating command by omitting its
    // arguments. `herdr workspace create` runs, with defaults.
    expect(fake.calls().every((call) => call.includes('--help'))).toBe(true);
  }, 30_000);

  test('the tool description states what the capability is and is not for', async () => {
    const fake = fakeHerdr({});
    const { tool } = withTool(fake);

    expect(tool.description).toContain('OPTIONAL');
    expect(tool.description).toContain('named unavailable capability');
    // The two prohibitions that matter.
    expect(tool.description).toContain('never predicted');
    expect(tool.description).toContain('belongs to you');
  }, 30_000);
});
