import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleWorker } from '../src/artifacts/bundle_worker.ts';
import { buildEnvironment } from '../src/shared/build_environment.ts';
import type { runBounded } from '../src/shared/run_bounded.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const tree = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-closed-worker-'));
  roots.push(root);
  mkdirSync(join(root, 'apps/frontend/client/.svelte-kit/cloudflare'), { recursive: true });
  writeFileSync(
    join(root, 'apps/frontend/client/.svelte-kit/cloudflare/_worker.js'),
    'unbundled-input',
  );
  return root;
};
const workerOf = (root: string): string =>
  join(root, 'apps/frontend/client/.svelte-kit/cloudflare/_worker.js');
const ignoreOf = (root: string): string =>
  join(root, 'apps/frontend/client/.svelte-kit/cloudflare/.assetsignore');

/**
 * Read a published artifact, asserting it is there first.
 *
 * Without the assertion a moved output is an `ENOENT` from `readFileSync` rather
 * than a failure that names the path invariant it broke — which is the whole
 * question these reads are asked.
 */
const readArtifact = (path: string): string => {
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf8');
};
const runFixture = (
  options: { imports?: unknown[]; code?: number; empty?: boolean } = {},
): { root: string; run: typeof runBounded } => {
  const root = tree();
  return {
    root,
    run: async (command) => {
      expect(command.args).toContain('--dry-run');
      expect(command.args).not.toContain('--no-bundle');
      const stage = command.args[command.args.indexOf('--outdir') + 1];
      if (stage === undefined) {
        throw new Error('Missing staging output directory');
      }
      writeFileSync(join(stage, '_worker.js'), options.empty ? '' : 'closed-worker');
      writeFileSync(
        join(stage, 'bundle-meta.json'),
        JSON.stringify({
          outputs: {
            [join(stage, '_worker.js')]: {
              imports: options.imports ?? [{ path: 'cloudflare:workers', external: true }],
            },
          },
        }),
      );
      return { code: options.code ?? 0, stdout: '', stderr: '' };
    },
  };
};

test('build environment excludes credentials even when called from authenticated apply', () => {
  expect(
    buildEnvironment({
      PATH: '/bin',
      PUBLIC_LABEL: 'starter',
      CLOUDFLARE_API_TOKEN: 'fixture-token',
      BETTER_AUTH_SECRET: 'fixture-auth',
      RESEND_API_KEY: 'fixture-mail',
      SOPS_AGE_KEY: 'fixture-identity',
      OPENROUTER_API_KEY: 'fixture-review',
      E2E_VISION_API_KEY: 'fixture-vision',
      SUPABASE_SERVICE_ROLE_KEY: 'fixture-admin',
      SUPABASE_DB_PASSWORD: 'fixture-database',
    }),
  ).toEqual({ PATH: '/bin', PUBLIC_LABEL: 'starter' });
});

test('the bundler hands Wrangler no credential, not merely a filter that would remove one', async () => {
  const options = runFixture();
  const seen: NodeJS.ProcessEnv[] = [];
  await bundleWorker({
    ...options,
    env: {
      PATH: '/bin',
      PUBLIC_LABEL: 'starter',
      CLOUDFLARE_API_TOKEN: 'fixture-token',
      BETTER_AUTH_SECRET: 'fixture-auth',
      RESEND_API_KEY: 'fixture-mail',
      OPENROUTER_API_KEY: 'fixture-review',
      E2E_VISION_API_KEY: 'fixture-vision',
      SUPABASE_SERVICE_ROLE_KEY: 'fixture-admin',
    },
    run: async (command) => {
      seen.push(command.env ?? {});
      return options.run(command);
    },
  });

  // The unit test above proves the filter's output shape; this proves the
  // bundler *calls* it. A build environment that stopped being applied would
  // leave that test green while every credential reached `wrangler deploy`.
  expect(seen).toHaveLength(1);
  expect(seen[0]).toEqual({ PATH: '/bin', PUBLIC_LABEL: 'starter' });
});

test('build publishes the closed Worker instead of the adapter entry', async () => {
  const options = runFixture();
  expect(await bundleWorker(options)).toBe(0);
  expect(readArtifact(workerOf(options.root))).toBe('closed-worker');
  expect(readArtifact(ignoreOf(options.root))).toContain('**/*.map');
});
test('a leftover SSR import refuses the build and never overwrites its entry', async () => {
  const options = runFixture({ imports: [{ path: '../output/server/index.js', external: true }] });
  expect(await bundleWorker(options)).toBe(1);
  expect(readArtifact(workerOf(options.root))).toBe('unbundled-input');
});
test('a failed bundler stops before publishing its partial output', async () => {
  const options = runFixture({ code: 7 });
  expect(await bundleWorker(options)).toBe(7);
  expect(readArtifact(workerOf(options.root))).toBe('unbundled-input');
});
test('zero Worker bytes cannot be published as a successful build', async () => {
  expect(await bundleWorker(runFixture({ empty: true }))).toBe(1);
});
