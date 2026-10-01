// scripts/tests/deployment_values.test.ts
//
// Where a provisioned resource id actually comes from.
//
// The bug these cover: `deploy:configure --provision` created a D1 database and
// wrote the id into `wrangler.jsonc`, which is one of two files the tooling
// reads. `deploy:check`, `db:migrate` and the log adapters read the registry, which
// stayed `null` forever — so provisioning could never complete and every deploy
// test passed while doing it. The documented remedy pointed at a module the
// `registry-valid` guard rejects.
//
// So there are three layers and this file pins the order, because the order is the
// feature: a value in more than one place is a value nobody can tell is in effect.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  describeResolution,
  effectiveDeploymentValues,
  LOCAL_DEPLOYMENT_FILE,
  localConfigProblem,
  resolveDeploymentValues,
  setDeploymentValues,
} from '../src/registry/deployment_values.ts';
import { DEPLOYMENT_CONFIG } from '../src/registry/app_registry.ts';
import { provisionDatabase } from '../src/deploy/configure.ts';

const created: string[] = [];

const makeTree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-deploy-values-'));
  created.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }
  return root;
};

afterEach(() => {
  setDeploymentValues(null);
  for (const root of created.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const local = (values: unknown): string => JSON.stringify(values);

describe('resolveDeploymentValues', () => {
  test('reports nothing provisioned on a fresh checkout', () => {
    // The template's starting state, and the reason every tool's remedy text
    // exists. Nothing here should invent a resource.
    const values = resolveDeploymentValues({}, makeTree({}));

    expect(values.accountId).toBeNull();
    expect(values.workerNames.api).toBeNull();
    expect(values.d1DatabaseIds.api).toBeNull();
    expect(values.workerNames.client).toBeNull();
  });

  test('reads provisioned ids from the gitignored local file', () => {
    // This is the case that could not happen before: `deploy:check` read the
    // committed module, which provisioning never wrote.
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({
        accountId: 'a'.repeat(32),
        workerNames: { api: 'starter-api' },
        d1DatabaseIds: { api: 'db-123' },
      }),
    });

    const values = resolveDeploymentValues({}, root);
    expect(values.accountId).toBe('a'.repeat(32));
    expect(values.workerNames.api).toBe('starter-api');
    expect(values.d1DatabaseIds.api).toBe('db-123');
  });

  test('the environment wins over the local file', () => {
    // CI injects rather than persists, so an environment value must override a
    // developer's stale local file rather than be silently ignored by it.
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({ d1DatabaseIds: { api: 'local-db' } }),
    });

    const values = resolveDeploymentValues({ CLOUDFLARE_D1_DATABASE_ID: 'ci-db' }, root);
    expect(values.d1DatabaseIds.api).toBe('ci-db');
  });

  test('the environment supplies an account id with no local file at all', () => {
    const root = makeTree({});
    const values = resolveDeploymentValues({ CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32) }, root);
    expect(values.accountId).toBe('b'.repeat(32));
  });

  test('an empty or whitespace value counts as unset, not as an id', () => {
    // Otherwise `--account ""` would satisfy `!== null` and every later check would
    // treat the project as provisioned with an account that does not exist.
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({ accountId: '   ', workerNames: { api: '' } }),
    });

    const values = resolveDeploymentValues({}, root);
    expect(values.accountId).toBeNull();
    expect(values.workerNames.api).toBeNull();
  });

  test('a malformed local file yields no values rather than throwing', () => {
    // A stack trace from `bun run deploy:check` would be worse than a wrong answer,
    // and `localConfigProblem` is what turns this into an actionable message.
    const root = makeTree({ [LOCAL_DEPLOYMENT_FILE]: '{ not json' });
    const values = resolveDeploymentValues({}, root);

    expect(values.d1DatabaseIds.api).toBeNull();
    expect(localConfigProblem(root)).toContain('not valid JSON');
  });

  test('no local file is not a problem', () => {
    expect(localConfigProblem(makeTree({}))).toBeNull();
  });

  test('the committed module stays the floor, so a null default survives an overlay', () => {
    // Only the keys the overlay mentions change. A partial overlay must not blank
    // out values someone set elsewhere.
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({ workerNames: { api: 'starter-api' } }),
    });

    const values = resolveDeploymentValues({}, root);
    expect(values.workerNames.api).toBe('starter-api');
    expect(values.workerNames.client).toBeNull();
    expect(values.customDomains.api).toBeNull();
  });

  test('the committed registry is never given a literal id', () => {
    // The guard enforces this; asserting it here means the reason is written down
    // next to the thing that depends on it.
    expect(DEPLOYMENT_CONFIG.d1DatabaseIds.api).toBeNull();
    expect(DEPLOYMENT_CONFIG.workerNames.api).toBeNull();
    expect(DEPLOYMENT_CONFIG.accountId).toBeNull();
  });
});

describe('describeResolution', () => {
  test('names the layer that answered, so a report need not guess', () => {
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({ d1DatabaseIds: { api: 'db-123' } }),
    });

    expect(describeResolution('d1DatabaseIds.api', {}, root)).toBe('local-file');
    expect(describeResolution('d1DatabaseIds.api', { CLOUDFLARE_D1_DATABASE_ID: 'x' }, root)).toBe(
      'environment',
    );
    expect(describeResolution('workerNames.api', {}, root)).toBe('default');
  });
});

describe('setDeploymentValues', () => {
  test('the seam is what production reads through, so injecting changes the answer', () => {
    // This is the whole reason the deploy tests use the seam rather than mutating
    // `DEPLOYMENT_CONFIG`: if injecting had no effect on the value callers see,
    // every deploy test would be exercising a path that does not exist.
    const empty = resolveDeploymentValues({}, makeTree({}));
    expect(empty.accountId).toBeNull();

    setDeploymentValues({ ...empty, accountId: 'c'.repeat(32) });
    expect(effectiveDeploymentValues().accountId).toBe('c'.repeat(32));

    setDeploymentValues(null);
    expect(effectiveDeploymentValues().accountId).toBeNull();
  });
});
describe('provisionDatabase', () => {
  // This function had no test at all before, which is how the original bug
  // survived: the write it performed was never executed by anything, so nothing
  // could notice that it wrote the wrong file.

  const UUID = '11111111-2222-3333-4444-555555555555';
  const ACCOUNT = 'abcdef0123456789abcdef0123456789';

  const tree = (): string =>
    makeTree({
      'apps/backend/api/wrangler.jsonc':
        '{\n  "d1_databases": [\n    {\n      "binding": "DB",\n      "database_name": "starter-api",\n      "database_id": ""\n    }\n  ]\n}\n',
    });

  /**
   * Silence the command's own progress output for one call.
   *
   * `provisionDatabase` writes to stdout as part of its contract, so a test that
   * asserts on the files it wrote would otherwise interleave that with the runner's
   * output. Returns the restore function, and every call site runs it in `finally` —
   * a swallowed restore leaves the rest of the suite writing into the void.
   */
  const quiet = (): (() => void) => {
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    const swallow = (): boolean => true;

    process.stdout.write = swallow as unknown as typeof process.stdout.write;
    process.stderr.write = swallow as unknown as typeof process.stderr.write;

    return () => {
      process.stdout.write = out;
      process.stderr.write = err;
    };
  };

  test('records the id where the tooling reads it, not only in wrangler.jsonc', () => {
    const root = tree();
    const restore = quiet();

    try {
      const code = provisionDatabase({
        root,
        hasCredential: () => true,
        create: () => ({ ok: true, stdout: `${ACCOUNT}\n${UUID}\n`, stderr: '' }),
      });

      expect(code).toBe(0);

      // The regression. This assertion is the whole point of the file: it writes to
      // wrangler.jsonc too, so a test asserting only that would pass while the bug
      // was still present.
      const values = resolveDeploymentValues({}, root);
      expect(values.d1DatabaseIds.api).toBe(UUID);
      expect(values.accountId).toBe(ACCOUNT);

      // And the file the tooling reads is on disk, not merely in memory.
      expect(localConfigProblem(root)).toBeNull();
      expect(readFileSync(join(root, LOCAL_DEPLOYMENT_FILE), 'utf8')).toContain(UUID);
    } finally {
      restore();
    }
  });

  test('still writes wrangler.jsonc, because wrangler itself reads that one', () => {
    const root = tree();
    const restore = quiet();

    try {
      provisionDatabase({
        root,
        hasCredential: () => true,
        create: () => ({ ok: true, stdout: `${UUID}\n`, stderr: '' }),
      });

      const wrangler = readFileSync(join(root, 'apps/backend/api/wrangler.jsonc'), 'utf8');
      expect(wrangler).toContain(`"database_id": "${UUID}"`);
    } finally {
      restore();
    }
  });

  test('refuses without a credential and writes nothing at all', () => {
    const root = tree();
    const restore = quiet();

    try {
      const code = provisionDatabase({
        root,
        hasCredential: () => false,
        create: () => ({ ok: true, stdout: `${UUID}\n`, stderr: '' }),
      });

      expect(code).toBe(1);
      // The strongest form of "nothing has been changed": no file exists at all.
      expect(existsSync(join(root, LOCAL_DEPLOYMENT_FILE))).toBe(false);
    } finally {
      restore();
    }
  });

  test('reports an unparseable id instead of writing a blank one', () => {
    const root = tree();
    const restore = quiet();

    try {
      const code = provisionDatabase({
        root,
        hasCredential: () => true,
        create: () => ({ ok: true, stdout: 'created, but no id here\n', stderr: '' }),
      });

      expect(code).toBe(1);
      expect(existsSync(join(root, LOCAL_DEPLOYMENT_FILE))).toBe(false);
    } finally {
      restore();
    }
  });

  test('a failed create writes nothing', () => {
    const root = tree();
    const restore = quiet();

    try {
      const code = provisionDatabase({
        root,
        hasCredential: () => true,
        create: () => ({ ok: false, stdout: '', stderr: 'quota exceeded' }),
      });

      expect(code).toBe(1);
      expect(existsSync(join(root, LOCAL_DEPLOYMENT_FILE))).toBe(false);
    } finally {
      restore();
    }
  });

  test('provisioning does not erase values the operator already set', () => {
    // Read-modify-write, not overwrite: the local file also carries worker names,
    // and creating a database must not blank one out.
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({ workerNames: { api: 'starter-api' } }),
      'apps/backend/api/wrangler.jsonc': '{\n  "d1_databases": []\n}\n',
    });
    const restore = quiet();

    try {
      provisionDatabase({
        root,
        hasCredential: () => true,
        create: () => ({ ok: true, stdout: `${UUID}\n`, stderr: '' }),
      });

      const values = resolveDeploymentValues({}, root);
      expect(values.workerNames.api).toBe('starter-api');
      expect(values.d1DatabaseIds.api).toBe(UUID);
    } finally {
      restore();
    }
  });
});
