// .pi/tests/pi_loader.test.ts
//
// Exercise the *actual pinned Pi resource loader* against this project's real
// `.pi/` layout.
//
// Why this test exists: the repository had `.pi/extensions/logs.test.ts`. Pi
// discovers `.pi/extensions` and loads every module it finds there as an
// extension. A file importing `bun:test` fails that load, so starting the agent
// in this project produced an extension error on every run. Nothing in the unit
// suite noticed, because `bun test .pi/extensions` passed.
//
// A test that only proves "the tests pass" cannot catch a layout defect. This one
// drives `DefaultResourceLoader` from the installed `@earendil-works/pi-coding-agent`,
// with an isolated `agentDir` under a temporary directory, and asserts on what the
// loader reports.
//
// Two properties are checked:
//   1. the real `.pi/extensions` directory loads with **zero** errors
//   2. a deliberately misplaced module — written into a temporary extensions
//      directory during the test, never committed here — *is* reported, so the
//      check above cannot pass vacuously
//
// No LLM request is made and no credentials are read: loading extensions does
// not construct an agent.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PI_DIR = join(REPO_ROOT, '.pi');
const EXTENSIONS_DIR = join(PI_DIR, 'extensions');

/**
 * Load a project's extensions through Pi's own loader.
 *
 * `agentDir` is a throwaway directory so the loader cannot pick up the developer's
 * own `~/.pi` configuration — a machine where the project happens to be trusted
 * would otherwise produce a different result from CI's.
 *
 * `reload()` rather than the internal `loadCurrentExtensionSet()`: the public
 * surface is what a real Pi start uses, and calling a private method would make
 * this test pass against a shape Pi does not expose.
 */
const loadExtensions = async (cwd: string, agentDir: string) => {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });

  // Trust the throwaway project so `reload()` does not resolve project trust from
  // the real user's configuration. Nothing is executed here; extensions are only
  // imported and their register* functions called.
  settingsManager.setProjectTrusted(true);
  await loader.reload();

  return loader.getExtensions();
};

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-loader-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('Pi extension discovery', () => {
  test('the real .pi/extensions directory loads with no errors', async () => {
    await withTempDir(async (agentDir) => {
      const result = await loadExtensions(REPO_ROOT, agentDir);

      expect(result.errors).toEqual([]);
      expect(result.extensions.length).toBeGreaterThan(0);
      expect(result.extensions.map((extension) => extension.path)).toContain(
        join(EXTENSIONS_DIR, 'logs.ts'),
      );
    });
  }, 60_000);

  test('each registered tool appears exactly once', async () => {
    // Duplicates are what a double-loaded extension looks like from the model's
    // side: the tool is offered twice and the second definition wins, so a change
    // to the first appears to do nothing.
    await withTempDir(async (agentDir) => {
      const result = await loadExtensions(REPO_ROOT, agentDir);

      const tools = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
      expect(tools).toContain('read_logs');
      expect(new Set(tools).size).toBe(tools.length);
    });
  }, 60_000);

  // The negative control. Without it, "no errors" could mean "nothing was
  // loaded" or "the loader ignores this directory".
  test('a misplaced module in the discovery tree IS reported as an error', async () => {
    await withTempDir(async (agentDir) => {
      const projectDir = join(agentDir, 'project');
      const extensionsDir = join(projectDir, '.pi', 'extensions');
      mkdirSync(extensionsDir, { recursive: true });

      writeFileSync(
        join(extensionsDir, 'good.ts'),
        'export default function (pi: any): void { pi.registerCommand({ name: "noop", handler: async () => {} }); }\n',
      );

      // The exact defect this file's sibling test guards against.
      writeFileSync(
        join(extensionsDir, 'stray.test.ts'),
        "import { describe, test } from 'bun:test';\ndescribe('x', () => { test('y', () => {}); });\n",
      );

      const result = await loadExtensions(projectDir, agentDir);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.map((error) => error.path)).toContain(
        join(extensionsDir, 'stray.test.ts'),
      );
      // And the good extension still loaded, so this is a per-file report rather
      // than the whole directory being abandoned.
      expect(result.extensions.map((extension) => extension.path)).toContain(
        join(extensionsDir, 'good.ts'),
      );
    });
  }, 60_000);

  test('helpers and tests are outside the discovery tree', async () => {
    // A structural assertion, so the layout is checked as well as its effect.
    const { readdirSync } = await import('node:fs');

    const entries = readdirSync(EXTENSIONS_DIR);
    expect(entries.filter((name) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(name))).toEqual([]);
    expect(entries.every((name) => !name.includes('__'))).toBe(true);
  });
});
