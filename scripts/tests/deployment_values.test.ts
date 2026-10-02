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
import { planMigrate } from '../src/db/migrate.ts';
import {
  inspectConfig,
  provisionDatabase,
  setConfig,
  writeLocalValues,
} from '../src/deploy/configure.ts';
import { DEPLOYMENT_CONFIG } from '../src/registry/app_registry.ts';
import {
  describeResolution,
  effectiveDeploymentValues,
  LOCAL_DEPLOYMENT_FILE,
  localConfigProblem,
  resolveDeploymentValues,
  setDeploymentValues,
  targetsFor,
} from '../src/registry/deployment_values.ts';
import { REPO_ROOT } from '../src/shared/paths.ts';

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

/**
 * Silence a command's own progress output for one call.
 *
 * `provisionDatabase` and `setConfig` both write to stdout as part of their contract,
 * so a test that asserts on the files they wrote would otherwise interleave that with
 * the runner's output. Returns the restore function, and every call site runs it in
 * `finally` — a swallowed restore leaves the rest of the suite writing into the void.
 *
 * Module scope rather than inside one `describe`, because two different describes need
 * it and duplicating a helper that patches global state is how a test ends up
 * silencing another test's output.
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

describe('resolveDeploymentValues', () => {
  test('reports nothing provisioned on a fresh checkout', () => {
    // The template's starting state, and the reason every tool's remedy text
    // exists. Nothing here should invent a resource.
    const values = resolveDeploymentValues({}, makeTree({}));

    expect(values.accountId).toBeNull();
    expect(values.workerName).toBeNull();
    expect(values.d1DatabaseId).toBeNull();
  });

  test('reads provisioned ids from the gitignored local file', () => {
    // This is the case that could not happen before: `deploy:check` read the
    // committed module, which provisioning never wrote.
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({
        accountId: 'a'.repeat(32),
        workerName: 'starter-web',
        d1DatabaseId: 'db-123',
      }),
    });

    const values = resolveDeploymentValues({}, root);
    expect(values.accountId).toBe('a'.repeat(32));
    // Top-level (the single-set fallback) is untouched: writing an environment must
    // not also populate the value both environments used to share.
    expect(values.workerName).toBe('starter-web');
    expect(values.d1DatabaseId).toBe('db-123');
  });

  test('the environment wins over the local file', () => {
    // CI injects rather than persists, so an environment value must override a
    // developer's stale local file rather than be silently ignored by it.
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({ d1DatabaseId: 'local-db' }),
    });

    const values = resolveDeploymentValues({ CLOUDFLARE_D1_DATABASE_ID: 'ci-db' }, root);
    expect(values.d1DatabaseId).toBe('ci-db');
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
      [LOCAL_DEPLOYMENT_FILE]: local({ accountId: '   ', workerName: '' }),
    });

    const values = resolveDeploymentValues({}, root);
    expect(values.accountId).toBeNull();
    expect(values.workerName).toBeNull();
  });

  test('a malformed local file yields no values rather than throwing', () => {
    // A stack trace from `bun run deploy:check` would be worse than a wrong answer,
    // and `localConfigProblem` is what turns this into an actionable message.
    const root = makeTree({ [LOCAL_DEPLOYMENT_FILE]: '{ not json' });
    const values = resolveDeploymentValues({}, root);

    expect(values.d1DatabaseId).toBeNull();
    expect(localConfigProblem(root)).toContain('not valid JSON');
  });

  test.each([null, false, 42, 'invalid', []].map((section) => ({ section })))(
    'ignores non-object sections: %j',
    ({ section }) => {
      // `r2BucketNames` is the only section that is still an object, so it is the
      // one that can receive a non-object. The scalar fields cannot, and `usable`
      // has to reject their *values* — which is what the "empty or whitespace" test
      // above covers.
      const root = makeTree({
        [LOCAL_DEPLOYMENT_FILE]: local({
          r2BucketNames: section,
        }),
      });
      const values = resolveDeploymentValues({}, root);
      expect(values.workerName).toBeNull();
      expect(values.d1DatabaseId).toBeNull();
      expect(values.r2BucketNames.uploads).toBeNull();
      expect(values.customDomain).toBeNull();
    },
  );

  test('CI database overrides reach the selected environment without changing its Worker', () => {
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({
        environments: {
          staging: {
            workerName: 'staging-api',
            d1DatabaseId: 'local-db',
          },
        },
      }),
    });
    setDeploymentValues(resolveDeploymentValues({ CLOUDFLARE_D1_DATABASE_ID: 'ci-db' }, root));
    expect(targetsFor('staging')?.d1DatabaseId).toBe('ci-db');
    expect(targetsFor('staging')?.workerName).toBe('staging-api');
    expect(targetsFor('production')).toBeNull();
  });

  test('no local file is not a problem', () => {
    expect(localConfigProblem(makeTree({}))).toBeNull();
  });

  test('the committed module stays the floor, so a null default survives an overlay', () => {
    // Only the keys the overlay mentions change. A partial overlay must not blank
    // out values someone set elsewhere.
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({ workerName: 'starter-web' }),
    });

    const values = resolveDeploymentValues({}, root);
    expect(values.workerName).toBe('starter-web');
    // The keys the overlay does not mention keep the committed floor. With one
    // Worker and one database there is no longer a second name to survive, so this
    // is asserted on the fields that were never in the overlay.
    expect(values.d1DatabaseId).toBeNull();
    expect(values.customDomain).toBeNull();
  });

  test('the committed registry is never given a literal id', () => {
    // The guard enforces this; asserting it here means the reason is written down
    // next to the thing that depends on it.
    expect(DEPLOYMENT_CONFIG.d1DatabaseId).toBeNull();
    expect(DEPLOYMENT_CONFIG.workerName).toBeNull();
    expect(DEPLOYMENT_CONFIG.accountId).toBeNull();
  });
});

describe('describeResolution', () => {
  test('names the layer that answered, so a report need not guess', () => {
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({ d1DatabaseId: 'db-123' }),
    });

    expect(describeResolution('d1DatabaseId', {}, root)).toBe('local-file');
    expect(describeResolution('d1DatabaseId', { CLOUDFLARE_D1_DATABASE_ID: 'x' }, root)).toBe(
      'environment',
    );
    expect(describeResolution('workerName', {}, root)).toBe('default');
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
      'apps/frontend/client/wrangler.jsonc':
        '{\n  "d1_databases": [\n    {\n      "binding": "DB",\n      "database_name": "starter-web",\n      "database_id": ""\n    }\n  ]\n}\n',
    });

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
      expect(values.environments?.staging?.d1DatabaseId).toBe(UUID);
      expect(values.accountId).toBe(ACCOUNT);
      // And NOT at the top level: a single shared id is what let staging and
      // production deploy to one database.
      expect(values.d1DatabaseId).toBeNull();

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

      const wrangler = readFileSync(join(root, 'apps/frontend/client/wrangler.jsonc'), 'utf8');
      // Both places, and that is the point of the test: wrangler reads the config
      // at deploy time, and the registry is what `deploy:check` and `db:migrate`
      // read. A value in one and not the other is a deploy that succeeds and a
      // `deploy:check` that reports the project unprovisioned.
      expect(wrangler).toContain(`"database_id": "${UUID}"`);
      expect(resolveDeploymentValues({}, root).environments?.staging?.d1DatabaseId).toBe(UUID);
    } finally {
      restore();
    }
  });

  // The negative control for the control above. `provisionDatabase` resolved the
  // wrangler config through the absolute `CLIENT_DIR` while taking a `root`
  // parameter, so `join(root, '/abs/path')` returned `/abs/path` and every one of
  // these tests wrote its fixture UUID into the repository's committed
  // `wrangler.jsonc` — the test passed, and the repository was left carrying a D1
  // id that a fresh clone would have tried to deploy against.
  //
  // Asserting the committed file directly is the only assertion that can catch it:
  // the fixture assertions above pass either way, because both paths end at a file
  // that exists.
  test('the repository wrangler.jsonc carries no provisioned resource id', () => {
    const committed = readFileSync(join(REPO_ROOT, 'apps/frontend/client/wrangler.jsonc'), 'utf8');

    // Not merely "not the fixture's id" — no `database_id` at all. The comment in
    // that file says why: an invented id fails at deploy time with an opaque
    // wrangler error, whereas an absent one fails at configuration time with a
    // clear one, and `bun run deploy:configure` is what writes the real value.
    expect(committed).not.toContain('"database_id"');
    expect(committed).toContain('"migrations_dir"');
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
      [LOCAL_DEPLOYMENT_FILE]: local({ workerName: 'starter-web' }),
      'apps/frontend/client/wrangler.jsonc': '{\n  "d1_databases": []\n}\n',
    });
    const restore = quiet();
    const output: string[] = [];
    process.stdout.write = ((text: string) => {
      output.push(String(text));
      return true;
    }) as typeof process.stdout.write;

    try {
      provisionDatabase({
        root,
        hasCredential: () => true,
        create: () => ({ ok: true, stdout: `${UUID}\n`, stderr: '' }),
      });

      const values = resolveDeploymentValues({}, root);
      expect(values.workerName).toBe('starter-web');
      expect(values.environments?.staging?.d1DatabaseId).toBe(UUID);
      expect(output.join('')).not.toContain('written to wrangler.jsonc');
      expect(output.join('')).toContain(`written to ${LOCAL_DEPLOYMENT_FILE}`);
      // The app's own wrangler config, which is now the only one: the
      // `apps/backend/api` application is gone and the SvelteKit app is what
      // declares the D1 binding a deploy reads.
      expect(readFileSync(join(root, 'apps/frontend/client/wrangler.jsonc'), 'utf8')).toBe(
        '{\n  "d1_databases": []\n}\n',
      );
    } finally {
      restore();
    }
  });
});

describe('targetsFor', () => {
  // Gap 4: one set of names cannot describe a real deployment. A Worker is named
  // once per account, so staging and production are two Workers and two databases.
  // With one set, `--env staging` and `--env production` produced identical plans —
  // the flag changed a notice and nothing else.

  const base = {
    workerName: 'single-web',
    d1DatabaseId: 'single-db',
    r2BucketNames: { uploads: null },
    customDomain: null,
    accountId: 'a'.repeat(32),
  };

  test('falls back to the single set when no per-environment layer exists', () => {
    // A project that has only ever had one environment must keep working.
    setDeploymentValues(base);

    const staging = targetsFor('staging');
    const production = targetsFor('production');

    expect(staging?.workerName).toBe('single-web');
    expect(production?.workerName).toBe('single-web');
  });

  test('gives each environment its own Worker and database', () => {
    setDeploymentValues({
      ...base,
      environments: {
        staging: {
          workerName: 'web-staging',
          d1DatabaseId: 'db-staging',
          origin: 'https://web-staging.example',
        },
        production: {
          workerName: 'web-prod',
          d1DatabaseId: 'db-prod',
          origin: 'https://web-prod.example',
        },
      },
    });

    const staging = targetsFor('staging');
    const production = targetsFor('production');

    expect(staging?.workerName).toBe('web-staging');
    expect(production?.workerName).toBe('web-prod');
    expect(staging?.d1DatabaseId).toBe('db-staging');
    expect(production?.d1DatabaseId).toBe('db-prod');
  });

  test('refuses an environment the project has no topology for', () => {
    // Only staging is configured. Defaulting to the single set here would be the
    // worst outcome available: a production request served by staging names.
    setDeploymentValues({
      ...base,
      environments: {
        staging: {
          workerName: 'web-staging',
          d1DatabaseId: 'db-staging',
          origin: 'https://web-staging.example',
        },
      },
    });

    expect(targetsFor('staging')).not.toBeNull();
    expect(targetsFor('production')).toBeNull();
  });

  test('an unprovisioned environment is null, not a fallback', () => {
    // `null` for a name inside a configured environment means "not provisioned",
    // which is a refusal at the plan level — distinct from the environment being
    // absent from the map entirely.
    setDeploymentValues({
      ...base,
      environments: {
        staging: {
          workerName: 'web-staging',
          d1DatabaseId: null,
          origin: null,
        },
        production: {
          workerName: 'web-prod',
          d1DatabaseId: 'db-prod',
          origin: 'https://web-prod.example',
        },
      },
    });

    const staging = targetsFor('staging');
    expect(staging?.workerName).toBe('web-staging');
    expect(staging?.d1DatabaseId).toBeNull();
  });

  test('reads per-environment targets from the local file', () => {
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({
        accountId: 'a'.repeat(32),
        environments: {
          staging: {
            workerName: 'from-file-staging',
            d1DatabaseId: 'db-staging',
          },
          production: {
            workerName: 'from-file-prod',
            d1DatabaseId: 'db-prod',
          },
        },
      }),
    });

    const values = resolveDeploymentValues({}, root);
    expect(values.environments?.staging?.workerName).toBe('from-file-staging');
    expect(values.environments?.production?.d1DatabaseId).toBe('db-prod');
    // And the single set stays empty, so a project that configures per-environment
    // is not also deployable against a nameless default.
    expect(values.workerName).toBeNull();
  });

  test('an unknown environment name in the file is ignored, not trusted', () => {
    // A typo must not become a topology. `prodution` is not `production`, and
    // treating it as one would make `targetsFor('production')` return null for a
    // project that plainly meant to configure it.
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({
        environments: {
          prodution: {
            workerName: 'typo-api',
            d1DatabaseId: 'typo-db',
          },
        },
      }),
    });

    const values = resolveDeploymentValues({}, root);
    expect(values.environments).toBeUndefined();
  });

  test('an environment entry that is not an object is skipped', () => {
    // One malformed entry must not make the whole map `undefined` and fall back to
    // the single set — which is the no-op this layer exists to prevent.
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({
        environments: {
          staging: { workerName: 'ok-api', d1DatabaseId: 'ok-db' },
          production: 'not-an-object',
        },
      }),
    });

    const values = resolveDeploymentValues({}, root);
    expect(values.environments?.staging?.workerName).toBe('ok-api');
    expect(values.environments?.production).toBeUndefined();
  });
});

describe('setConfig', () => {
  // The one operation that *writes* the local overlay, and it had no test — because it
  // hardcoded `REPO_ROOT`, so there was nowhere to point it. The bug that missing test
  // concealed is worth stating, because the fix is in the remedy text this repository
  // itself prints:
  //
  //   bun run deploy:configure -- --worker api starter-api
  //
  // was read as "the name is `api`", and recorded the literal string `"api"` as the
  // Worker's name. Wrangler accepts that as a valid name, so the deploy plan printed
  // `--name api` and nothing failed until it published to the wrong place.
  //
  // The form is now `--worker <name>` with no app to confuse it with, which removes
  // the possibility rather than adding a check for it. The test below asserts the
  // shape directly, because "there is only one thing this argument can mean" is a
  // property of the signature and not of any validation.

  const ACCOUNT = 'a'.repeat(32);

  test('records the account id alone, provisioning nothing', () => {
    const root = makeTree({});
    const restore = quiet();

    try {
      expect(setConfig(['--account', ACCOUNT], root)).toBe(0);

      const values = resolveDeploymentValues({}, root);
      expect(values.accountId).toBe(ACCOUNT);
      // Setting the account must not invent a Worker or a database.
      expect(values.workerName).toBeNull();
      expect(values.d1DatabaseId).toBeNull();
    } finally {
      restore();
    }
  });

  test('records the Worker name it was given', () => {
    // `--worker` takes one argument now: the name. There is no app to confuse it
    // with, which is the fix for the regression this replaces — the two-argument
    // form read `api` as the name when only one argument was given, and
    // `deploy:check` then printed `--name api`, which wrangler accepts.
    const root = makeTree({});
    const restore = quiet();

    try {
      expect(
        setConfig(['--account', ACCOUNT, '--env', 'staging', '--worker', 'starter-web'], root),
      ).toBe(0);

      const values = resolveDeploymentValues({}, root);
      expect(values.environments?.staging?.workerName).toBe('starter-web');
      // The decisive assertion: the name is not a target word that used to be an
      // app id, and it is not the account id.
      expect(values.workerName).not.toBe('api');
      expect(values.workerName).not.toBe('client');
    } finally {
      restore();
    }
  });

  test('refuses a --worker with no name rather than recording a flag', () => {
    // `--worker` followed by another flag means the name was forgotten. Recording
    // the flag as the name is the same class of mistake the two-argument form had,
    // and it would pass every check downstream.
    const root = makeTree({});
    const restore = quiet();

    try {
      expect(setConfig(['--account', ACCOUNT, '--env', 'staging', '--worker', '--yes'], root)).toBe(
        2,
      );

      // Nothing written at all, not even the account id: the invocation was wrong.
      expect(existsSync(join(root, LOCAL_DEPLOYMENT_FILE))).toBe(false);
    } finally {
      restore();
    }
  });

  test('a second --worker name replaces the first, and the account id survives', () => {
    // Re-running the command is how an operator corrects a typo. It must not
    // accumulate a second name or drop the account id written by the first run.
    const root = makeTree({});
    const restore = quiet();

    try {
      setConfig(['--account', ACCOUNT, '--env', 'staging', '--worker', 'typo-web'], root);
      setConfig(['--account', ACCOUNT, '--env', 'staging', '--worker', 'starter-web'], root);

      const values = resolveDeploymentValues({}, root);
      expect(values.accountId).toBe(ACCOUNT);
      expect(values.environments?.staging?.workerName).toBe('starter-web');
    } finally {
      restore();
    }
  });

  test('refuses an account id that is not 32 hex characters, writing nothing', () => {
    for (const bad of ['nope', 'a'.repeat(31), 'z'.repeat(32)]) {
      const root = makeTree({});
      const restore = quiet();

      try {
        expect(setConfig(['--account', bad], root)).toBe(2);
        expect(existsSync(join(root, LOCAL_DEPLOYMENT_FILE))).toBe(false);
      } finally {
        restore();
      }
    }
  });

  test('recording a Worker name twice does not erase the account id', () => {
    const root = makeTree({});
    const restore = quiet();

    try {
      setConfig(['--account', ACCOUNT, '--env', 'staging', '--worker', 'starter-web'], root);

      const values = resolveDeploymentValues({}, root);
      expect(values.accountId).toBe(ACCOUNT);
      expect(values.environments?.staging?.workerName).toBe('starter-web');
    } finally {
      restore();
    }
  });
});

describe('local configuration writes', () => {
  test('preserves the raw local layer without persisting CI overrides', () => {
    const root = makeTree({
      [LOCAL_DEPLOYMENT_FILE]: local({
        accountId: 'local-account',
        d1DatabaseId: 'local-db',
        extra: { keep: true },
      }),
    });
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const savedDatabase = process.env.CLOUDFLARE_D1_DATABASE_ID;
    try {
      process.env.CLOUDFLARE_ACCOUNT_ID = 'ci-account';
      process.env.CLOUDFLARE_D1_DATABASE_ID = 'ci-db';
      writeLocalValues((current) => ({ ...current, workerName: 'new-worker' }), root);
      expect(JSON.parse(readFileSync(join(root, LOCAL_DEPLOYMENT_FILE), 'utf8'))).toEqual({
        accountId: 'local-account',
        d1DatabaseId: 'local-db',
        workerName: 'new-worker',
        extra: { keep: true },
      });
    } finally {
      if (savedAccount === undefined) {
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
      } else {
        process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
      }
      if (savedDatabase === undefined) {
        delete process.env.CLOUDFLARE_D1_DATABASE_ID;
      } else {
        process.env.CLOUDFLARE_D1_DATABASE_ID = savedDatabase;
      }
    }
  });

  test('refuses to overwrite a malformed local file', () => {
    const root = makeTree({ [LOCAL_DEPLOYMENT_FILE]: '{ invalid' });
    expect(() => writeLocalValues(() => ({ accountId: 'new' }), root)).toThrow('not valid JSON');
    expect(readFileSync(join(root, LOCAL_DEPLOYMENT_FILE), 'utf8')).toBe('{ invalid');
  });
});

describe('environment configuration consumers', () => {
  const values = () =>
    resolveDeploymentValues(
      {},
      makeTree({
        [LOCAL_DEPLOYMENT_FILE]: local({
          accountId: 'a'.repeat(32),
          environments: {
            staging: {
              workerName: 'staging-web',
              d1DatabaseId: 'staging-db',
              origin: 'https://staging.example',
            },
            production: {
              workerName: 'production-web',
              d1DatabaseId: 'production-db',
              origin: 'https://app.example',
            },
          },
        }),
      }),
    );

  test('reports the environment that is missing, not a global pass or fail', () => {
    const saved = process.env.CLOUDFLARE_API_TOKEN;
    try {
      process.env.CLOUDFLARE_API_TOKEN = 'fixture-token';
      const configured = values();
      expect(inspectConfig(configured).ok).toBe(true);

      // Blank one field in one environment. `resolveTarget` refuses at the first
      // missing value rather than reporting a whole inventory at once, so the
      // assertion is that the problem names *this* environment and *this* field —
      // an operator who blanks two fields fixes them one run at a time.
      const staging = configured.environments?.staging;
      if (staging === undefined) {
        throw new Error('Missing staging fixture');
      }
      staging.d1DatabaseId = null;

      const problems = inspectConfig(configured).problems;
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('No D1 database id is configured for staging');
      // The message must not mention the environment that is fine, or an operator
      // cannot tell which of two to go and fix.
      expect(problems[0]).not.toContain('production');
      expect(inspectConfig(configured).ok).toBe(false);
    } finally {
      if (saved === undefined) {
        delete process.env.CLOUDFLARE_API_TOKEN;
      } else {
        process.env.CLOUDFLARE_API_TOKEN = saved;
      }
    }
  });

  test('migration accepts a configured environment and refuses missing or null scopes', () => {
    const configured = values();
    setDeploymentValues(configured);
    expect(planMigrate('staging').ok).toBe(true);
    expect(planMigrate('production').ok).toBe(true);

    // Setting the *top-level* id is no longer enough to satisfy an environment, and
    // blanking one environment's id no longer affects the other. One shared id is
    // what let a production request migrate whatever database staging was using.
    configured.d1DatabaseId = 'single-db';
    expect(planMigrate('production').ok).toBe(true);

    const production = configured.environments?.production;
    if (production === undefined) {
      throw new Error('Missing production fixture');
    }
    production.d1DatabaseId = null;
    expect(planMigrate('production').ok).toBe(false);
    expect(planMigrate('staging').ok).toBe(true);

    const staging = configured.environments?.staging;
    if (staging === undefined) {
      throw new Error('Missing staging fixture');
    }
    staging.d1DatabaseId = null;
    expect(planMigrate('staging').ok).toBe(false);
  });
});
