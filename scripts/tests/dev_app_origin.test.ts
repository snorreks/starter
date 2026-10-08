// scripts/tests/dev_app_origin.test.ts
//
// The local origin the launcher hands the Worker, and the vars it forwards.
//
// Asserted against `buildTarget`'s real argv rather than a helper's return value,
// because the thing that can be wrong is the argv: `--var` takes two elements, and a
// combined `"--var NAME:value"` string reaches wrangler's parser as an unknown flag.
//
// The behaviour worth protecting is `APP_ORIGIN`. `wrangler dev` serves the
// Worker on an internal port and rewrites both `event.url` and the `Host` header to
// `http://127.0.0.1` — verified against a running `dev:worker`, not assumed — so the
// application cannot derive its own public origin locally. This launcher knows the
// real port, so it states it.

import { describe, expect, test } from 'bun:test';
import { buildTarget, type Target } from '../src/dev-app.ts';
import { REPO_ROOT } from '../src/shared/paths.ts';
import { worktreePort } from '../src/shared/run_scope.ts';

/**
 * Re-read the module with `APP_ORIGIN` set to `value`.
 *
 * A cache-busting query is the only way to re-evaluate the module-scope constant
 * that `dev-app.ts` reads. Asserted through the real `buildTarget`, so what is
 * verified is the argv that would actually be spawned.
 */
const targetWithUrl = async (value: string): Promise<Target> => {
  const previous = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = value;
  try {
    const module: { buildTarget: (mode: 'app' | 'built') => Target } = await import(
      /* @vite-ignore */ `../src/dev-app.ts?url=${encodeURIComponent(value)}`
    );
    return module.buildTarget('built');
  } finally {
    if (previous === undefined) {
      delete process.env.APP_ORIGIN;
    } else {
      process.env.APP_ORIGIN = previous;
    }
  }
};

/** Every `--var NAME:value` pair in an argv, as a record. */
const varsOf = (args: readonly string[]): Record<string, string> => {
  const found: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--var') {
      continue;
    }
    const pair = args[index + 1];
    if (pair === undefined) {
      continue;
    }
    const separator = pair.indexOf(':');
    if (separator > 0) {
      found[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
  }
  return found;
};

describe('the local launcher states the origin the Worker cannot derive', () => {
  test('the built Worker mode declares an http origin on the port it serves', () => {
    // `built` is `wrangler dev`, which takes bindings as `--var`. `app` is
    // `vite dev`, which reads them from `wrangler.jsonc` instead and therefore has no
    // `--var` surface at all — so only `built` is asserted here, and the `app` mode is
    // covered by the port/`--strictPort` assertions below.
    //
    // The port is the entire point. An origin without one sends every verification and
    // recovery link to port 80.
    const vars = varsOf(buildTarget('built').args);
    const url = vars.APP_ORIGIN;

    expect(url, 'built mode did not forward APP_ORIGIN').toBeDefined();
    expect(new URL(url as string).protocol).toBe('http:');
    expect(new URL(url as string).port).not.toBe('');
  });

  test('the built Worker mode, which is what E2E and `dev:worker` use', () => {
    // Called out separately because this is the mode that broke: the E2E lane serves
    // on its own port, so a missing port there made every verification link a
    // connection refusal.
    const vars = varsOf(buildTarget('built').args);
    expect(vars.APP_ORIGIN).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('a caller-supplied value is kept, not overwritten', async () => {
    // Someone pointing a local run at a different origin must be believed; this is a
    // default, not an override.
    const vars = varsOf((await targetWithUrl('http://localhost:9999')).args);
    expect(vars.APP_ORIGIN).toBe('http://localhost:9999');
  });

  test('an empty value is treated as unset rather than forwarded as blank', async () => {
    // `--var APP_ORIGIN:` would reach the application as an empty string, which
    // `resolveDeploymentEnvironment` reads as a *configured but invalid* URL and
    // refuses — a far more confusing failure than the default.
    const vars = varsOf((await targetWithUrl('')).args);
    expect(vars.APP_ORIGIN).not.toBe('');
    expect(new URL(vars.APP_ORIGIN as string).port).not.toBe('');
  });
});

describe('both modes still serve the port the launcher advertises', () => {
  test('the vite dev mode passes the port and refuses to move', () => {
    // `--strictPort` is why `bun run dev` fails loudly rather than silently shifting
    // when its stable per-checkout port is taken: a shifted port would break every printed URL and, more
    // importantly, invalidate the origin the launcher just told the Worker about.
    const args = buildTarget('app').args;
    expect(args).toContain('--strictPort');
    expect(args[args.indexOf('--port') + 1]).toBe(
      process.env.PORT ?? String(worktreePort(5200, REPO_ROOT)),
    );
  });

  test('the built Worker mode passes the port to wrangler', () => {
    const args = buildTarget('built').args;
    expect(args[args.indexOf('--port') + 1]).toBe(
      process.env.PORT ?? String(worktreePort(5200, REPO_ROOT)),
    );
  });
});

describe('other forwarded vars stay opt-in', () => {
  test('nothing test-only is forwarded when the environment is clear', () => {
    // An ordinary `bun run dev` must not inherit a stale run id or a raised rate
    // limit from whatever ran before it in the same shell.
    const vars = varsOf(buildTarget('built').args);

    expect(vars.TEST_RUN_ID).toBeUndefined();
    expect(vars.AUTH_RATE_LIMIT_MAX).toBeUndefined();
    // Present because it is a real deployment decision, and it names what the
    // application was told to do. Never a secret: it is a name.
    expect(vars.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });

  test('every var is passed as two argv elements, never one combined string', () => {
    // `spawn` does no word splitting, so a combined element reaches wrangler as an
    // unknown flag and the dev server exits 1 with a usage dump.
    const args = buildTarget('built').args;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] !== '--var') {
        continue;
      }
      const value = args[index + 1];
      expect(value, `--var at index ${index} has no value`).toBeDefined();
      expect(value).not.toContain('--var');
    }
  });
});
