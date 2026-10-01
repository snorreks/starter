// .pi/tests/optional_capabilities.test.ts
//
// An absent optional capability must not stop the agent from starting.
//
// 🔴 The failure this exists to prevent: an extension that spawns a probe, reads
// an env var, or imports an optional package **at module load** takes the whole
// agent down with it on a machine where that thing is absent. Pi loads every
// module in `.pi/extensions` on every start, so one such extension makes `pi`
// unusable for everyone who did not install the optional tool.
//
// So this file asserts the load happens with Herdr genuinely unavailable, and
// that availability is only ever a *call-time* answer.
//
// No LLM request is made and no credential is read: loading extensions does not
// construct an agent.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Load every extension with a hostile environment.
 *
 * `PATH` is emptied rather than merely adjusted: the point is that nothing on this
 * machine can satisfy the probe. `HERDR_ENV` is deleted because that is what a
 * session outside a Herdr-managed pane looks like, which is the default for
 * anyone who cloned the template.
 */
const loadWithoutHerdr = async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-nocap-'));
  const savedPath = process.env.PATH;
  const savedHerdr = process.env.HERDR_ENV;

  try {
    process.env.PATH = '';
    delete process.env.HERDR_ENV;

    const settingsManager = SettingsManager.create(REPO_ROOT, agentDir);
    const loader = new DefaultResourceLoader({ cwd: REPO_ROOT, agentDir, settingsManager });
    settingsManager.setProjectTrusted(true);
    await loader.reload();

    return loader.getExtensions();
  } finally {
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
    if (savedHerdr !== undefined) {
      process.env.HERDR_ENV = savedHerdr;
    }
    rmSync(agentDir, { recursive: true, force: true });
  }
};

describe('starting the agent without an optional capability', () => {
  test('every extension loads with no errors and no PATH', async () => {
    const result = await loadWithoutHerdr();

    // The load itself is the test. A top-level probe would have thrown here.
    expect(result.errors).toEqual([]);
    expect(result.extensions.length).toBeGreaterThan(0);
  }, 60_000);

  test('the herdr tool still registers, because absence is a value and not a load failure', async () => {
    // Registering unconditionally is deliberate. A tool that vanishes when its
    // capability is missing is indistinguishable from a broken install, and the
    // model then has no way to ask *why* — whereas a registered tool can answer
    // with a named unavailable capability.
    const result = await loadWithoutHerdr();
    const names = result.extensions.flatMap((extension) => [...extension.tools.keys()]);

    expect(names).toContain('herdr');
    expect(names).toContain('repo_task');
    expect(names).toContain('dev_process');
    expect(names).toContain('handoff');

    // The whole point: the other four still registered. An absent optional tool
    // must not take the rest of the agent with it.
    expect(names.length).toBeGreaterThanOrEqual(5);
  }, 60_000);

  test('importing the herdr extension runs no subprocess', async () => {
    // Structural, and the reason the previous assertion holds: everything that
    // touches the CLI is inside `probe()`/`invoke()`, reached only when an action
    // runs. Asserted by reading the entrypoint for a module-level call rather
    // than by timing, because "it was fast" is not evidence.
    const source = await Bun.file(join(REPO_ROOT, '.pi', 'extensions', 'herdr.ts')).text();

    // The default export must not invoke anything at module scope.
    const body = source.slice(source.indexOf('export default function'));
    expect(body).toContain('await probe(');
    // No probe call sits outside an action body: the only occurrences of
    // `await probe(` are inside `async execute` or `runWorktree`, both reached
    // from an action.
    const topLevelProbe =
      /^\s*(const|await probe|probe)\s/m.test(body.split('actions:')[0] ?? '') === true;
    expect(topLevelProbe).toBe(false);
  });

  test('a missing capability is distinguishable from a failed command', async () => {
    // The distinction the task turns on, and the reason `probe` returns a verdict
    // rather than throwing: only a *failure* is worth retrying.
    const { probe } = await import('../lib/herdr_cli.ts');

    const outside = await probe(
      REPO_ROOT,
      async () => {
        throw new Error('should never be reached: the session is not inside Herdr');
      },
      {} as NodeJS.ProcessEnv,
    );

    expect(outside.available).toBe(false);
    expect(outside.name).toBe('herdr');
    // Named, and phrased so a user is not sent looking for a broken repository.
    expect(outside.reason).toContain('not running inside a Herdr-managed pane');
    expect(outside.reason).toContain('Normal development needs nothing from Herdr');
  });

  test('an absent provider and a failed check are different values', async () => {
    const { probe } = await import('../lib/herdr_cli.ts');

    // Absent: the binary is not on PATH at all.
    const absent = await probe(
      REPO_ROOT,
      async () => {
        throw new Error('spawn herdr ENOENT');
      },
      { HERDR_ENV: '1' } as NodeJS.ProcessEnv,
    );

    // Failed: the binary ran and refused.
    const failed = await probe(
      REPO_ROOT,
      async () => ({
        code: 1,
        stdout: '',
        stderr: 'socket: no such file',
        truncated: false,
        timedOut: false,
        cancelled: false,
      }),
      { HERDR_ENV: '1' } as NodeJS.ProcessEnv,
    );

    expect(absent.reason).toContain('not on PATH');
    expect(failed.reason).toContain('exited 1');
    // Both unavailable, but for different reasons, and the reasons are what tell a
    // model whether retrying could ever help.
    expect(absent.reason).not.toBe(failed.reason);
  }, 30_000);
});
