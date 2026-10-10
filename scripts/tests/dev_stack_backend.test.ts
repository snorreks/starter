// scripts/tests/dev_stack_backend.test.ts
//
// How `prepareDevStack` reads the caller's configuration.
//
// This exists because the gap was real. `prepareDevBackend` had a test for the
// E2E lane's shape — URL and anon key in the environment, service-role key in a
// vars file the caller owns — and `prepareDevBackend` kept that behaviour when it
// became a wrapper. `prepareDevStack`, which `main()` actually calls, was written
// afterwards, read only the environment, and had no test at all.
//
// The result was a green unit lane and a broken `bun run e2e`, failing with
// "SUPABASE_URL is set but the backend is incomplete" from inside a Playwright
// `webServer` process. That is the shape of failure this repository cares most
// about: not a red test, but a green suite and a command that does not work.
//
// Every case here injects the service factory, so none of them starts Docker.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { type DevStackDependencies, disposeDevStack, prepareDevStack } from '../src/dev-app.ts';
import type { LocalService, LocalServiceId } from '../src/local/service.ts';
import { prepareSupabaseService } from '../src/local/supabase_service.ts';
import { REPO_ROOT } from '../src/shared/paths.ts';

/**
 * The shape `apps/e2e/scripts/run_e2e.ts` produces, read from that file rather
 * than guessed: it starts its own Supabase, writes all three bindings into the
 * 0600 file it owns, and puts only the two non-secret ones in the environment —
 * because `publicToolEnvironment` strips the service-role key on its way to the
 * spawn. Getting this fixture wrong is how the stack looked healthy while the
 * Worker answered 503 for every binding.
 */
const E2E_CALLER_FILE = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'local-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'file-service-role',
};

const temporaries: string[] = [];

/** Also removed: the stack writes `.wrangler/runs/<runId>/stack.dev.vars` inside the checkout. */
const cleanupRunDirectories = async (runIds: string[]): Promise<void> => {
  await Promise.all(
    runIds
      .splice(0)
      .map((runId) =>
        rm(join(REPO_ROOT, '.wrangler', 'runs', runId), { recursive: true, force: true }),
      ),
  );
};

const producedRunIds: string[] = [];

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await cleanupRunDirectories(producedRunIds);
});

/** A vars file in the same encoding `writeOwnedVars` writes. */
const varsFile = async (contents: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'stack-vars-'));
  temporaries.push(dir);
  const path = join(dir, 'caller.vars');
  await writeFile(
    path,
    `${Object.entries(contents)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n')}\n`,
  );
  return path;
};

/**
 * Records what the stack asked each service for, and hands back services that
 * contribute nothing.
 *
 * The Supabase service is replaced with a recorder rather than started, so the
 * assertions are about *the merge this function performed* — which is the thing
 * that was wrong — and not about what a container does when it boots.
 */
const recorder = () => {
  const asked: { id: LocalServiceId; callerVars: Record<string, string | undefined> }[] = [];
  const dependencies: Partial<DevStackDependencies> = {
    // A fresh run id per call. The stack writes its vars file with `wx` into a
    // directory keyed by this, so a shared id fails the second call with `EEXIST` —
    // a real behaviour, and the reason the launcher suffixes its run id with entropy.
    runId: `stack_test_${crypto.randomUUID().slice(0, 8)}`,
    createService: async (id, context): Promise<LocalService> => {
      asked.push({ id, callerVars: context.callerVars });
      return { id, label: id, owned: false, vars: {}, summary: [], dispose: async () => [] };
    },
  };
  return {
    asked,
    dependencies,
    /** The run id handed out, so teardown can remove the state it wrote. */
    runId: dependencies.runId as string,
  };
};

/**
 * The real reader, pointed at a real file.
 *
 * `parseEnv` is what `dev-app.ts` uses; reusing it keeps the encoding honest
 * rather than duplicating a parser in the test — a test that parsed a different
 * way would pass against a file the real reader mis-reads.
 */
const readFileVars = (): DevStackDependencies['readVars'] => (path: string) =>
  parseEnv(readFileSync(path, 'utf8'));

describe('a backend split across the environment and a caller own file is complete', () => {
  // The shape `bun run e2e` and `bun run test:browser` both use: the URL and anon
  // key in the environment, the service-role key in the file the lane owns.
  test('the service-role key is read from the file rather than demanded of the environment', async () => {
    const rec = recorder();
    producedRunIds.push(rec.runId);
    await prepareDevStack(
      ['supabase'],
      'http://127.0.0.1:5173',
      {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: 'local-anon',
        STARTER_DEV_VARS_PATH: await varsFile({ SUPABASE_SERVICE_ROLE_KEY: 'file-role' }),
      },
      { ...rec.dependencies, readVars: readFileVars() },
    );

    // Before the fix the stack saw two of the three bindings, concluded the
    // backend was incomplete and refused — because nobody had read the file.
    const asked = rec.asked[0]?.callerVars ?? {};
    expect(asked.SUPABASE_URL).toBe('http://127.0.0.1:54321');
    expect(asked.SUPABASE_ANON_KEY).toBe('local-anon');
    expect(asked.SUPABASE_SERVICE_ROLE_KEY).toBe('file-role');
  });

  test('an unset environment value does not shadow a real one in the file', async () => {
    // `SUPABASE_URL=""` is a name set to nothing. Letting it override the file
    // turns a working configuration into "incomplete" — the same refusal by a
    // different route.
    const rec = recorder();
    producedRunIds.push(rec.runId);
    await prepareDevStack(
      ['supabase'],
      'http://127.0.0.1:5173',
      {
        SUPABASE_URL: '',
        SUPABASE_ANON_KEY: 'local-anon',
        STARTER_DEV_VARS_PATH: await varsFile({
          SUPABASE_URL: 'http://127.0.0.1:54321',
          SUPABASE_SERVICE_ROLE_KEY: 'file-role',
        }),
      },
      { ...rec.dependencies, readVars: readFileVars() },
    );

    expect(rec.asked[0]?.callerVars.SUPABASE_URL).toBe('http://127.0.0.1:54321');
  });

  test('a set environment value wins over the file', async () => {
    // A caller who points at staging must not be silently served the file's
    // development URL.
    const rec = recorder();
    producedRunIds.push(rec.runId);
    await prepareDevStack(
      ['supabase'],
      'http://127.0.0.1:5173',
      {
        SUPABASE_URL: 'https://from-env.supabase.co',
        STARTER_DEV_VARS_PATH: await varsFile({ SUPABASE_URL: 'http://127.0.0.1:54321' }),
      },
      { ...rec.dependencies, readVars: readFileVars() },
    );

    expect(rec.asked[0]?.callerVars.SUPABASE_URL).toBe('https://from-env.supabase.co');
  });
});

describe('the stack file carries the caller bindings, not just the services own', () => {
  // The second half of the same regression. Reading the caller's file is not
  // enough: the Worker reads credentials from whatever `--env-file` names, so a
  // stack file built only from service bindings *replaces* the caller's channel and
  // every binding the caller supplied disappears. That presented as the Worker
  // answering 503 with "Supabase configuration is incomplete" for all three keys
  // while the launcher reported a perfectly healthy stack.
  test('a caller binding survives into the file the Worker is pointed at', async () => {
    const { readFileSync } = await import('node:fs');
    const rec = recorder();
    producedRunIds.push(rec.runId);

    const run = await prepareDevStack(
      ['supabase'],
      'http://127.0.0.1:5173',
      {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: 'local-anon',
        STARTER_DEV_VARS_PATH: await varsFile(E2E_CALLER_FILE),
      },
      { ...rec.dependencies, readVars: readFileVars() },
    );

    const written = parseEnv(readFileSync(run.varsPath, 'utf8'));
    expect(written.SUPABASE_URL).toBe('http://127.0.0.1:54321');
    expect(written.SUPABASE_ANON_KEY).toBe('local-anon');
    expect(written.SUPABASE_SERVICE_ROLE_KEY).toBe(E2E_CALLER_FILE.SUPABASE_SERVICE_ROLE_KEY);
    expect(written.DEPLOYMENT_ENV).toBe('local');
    expect(written.APP_ORIGIN).toBe('http://127.0.0.1:5173');
  });

  test("the caller's own file is neither rewritten nor removed", async () => {
    // The run removes only what it wrote. A teardown that deleted the caller's file
    // would drop the service-role key the E2E lane needs for the *next* run too.
    const { readFileSync } = await import('node:fs');
    const rec = recorder();
    producedRunIds.push(rec.runId);

    const callerPath = await varsFile(E2E_CALLER_FILE);
    const before = readFileSync(callerPath, 'utf8');
    const run = await prepareDevStack(
      ['supabase'],
      'http://127.0.0.1:5173',
      {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: 'local-anon',
        STARTER_DEV_VARS_PATH: callerPath,
      },
      { ...rec.dependencies, readVars: readFileVars() },
    );

    await disposeDevStack(run);

    expect(readFileSync(callerPath, 'utf8')).toBe(before);
    // And the stack's own file is gone, so a credential does not outlive the run.
    expect(existsSync(run.varsPath)).toBe(false);
  });

  test('a service claiming a binding the caller set is refused, naming both', async () => {
    // The "two owners, one value" defect `mergeServiceVars` refuses between
    // services is identical when the second owner is the caller. It should be
    // unreachable — a caller with a complete configuration is why a service
    // deliberately starts nothing — which is why it gets a loud failure.
    const rec = recorder();
    producedRunIds.push(rec.runId);

    await expect(
      prepareDevStack(
        ['supabase'],
        'http://127.0.0.1:5173',
        {
          SUPABASE_URL: '',
          STARTER_DEV_VARS_PATH: await varsFile({ STRIPE_SECRET_KEY: 'sk_file' }),
        },
        {
          ...rec.dependencies,
          readVars: readFileVars(),
          // A service that insists on a binding the caller already owns.
          createService: async (id): Promise<LocalService> => ({
            id,
            label: id,
            owned: false,
            vars: { STRIPE_SECRET_KEY: 'sk_service' },
            summary: [],
            dispose: async () => [],
          }),
        },
      ),
    ).rejects.toThrow(/already configured/);
  });
});

describe('an absent vars path is not itself a failure', () => {
  test('a developer with nothing configured still gets a stack', async () => {
    const rec = recorder();
    producedRunIds.push(rec.runId);
    await prepareDevStack(['supabase'], 'http://127.0.0.1:5173', {}, rec.dependencies);

    // No file, no bindings: the ordinary case, which must reach the service
    // factory rather than refusing on the way there.
    expect(rec.asked.map((entry) => entry.id)).toEqual(['supabase']);
  });

  test('an environment with no path at all is passed through untouched', async () => {
    const rec = recorder();
    producedRunIds.push(rec.runId);
    await prepareDevStack(
      ['stripe'],
      'http://127.0.0.1:5173',
      { STRIPE_SECRET_KEY: 'sk_test_1' },
      rec.dependencies,
    );

    expect(rec.asked[0]?.callerVars.STRIPE_SECRET_KEY).toBe('sk_test_1');
  });
});

describe('a genuinely incomplete backend is still refused', () => {
  // The merge must not become a reason to start a stack for a configuration the
  // operator named: that serves a different database than the one they asked for.
  test('a named project missing a key is refused, naming the keys', async () => {
    // Delegates to the real Supabase service so this cannot pass while the real
    // path fails: the point is that the merge feeds it a *complete* configuration
    // when one exists, and an incomplete one when it does not.
    await expect(
      prepareSupabaseService({
        origin: 'http://127.0.0.1:5173',
        callerVars: { SUPABASE_URL: 'https://abc.supabase.co' },
        autoSignIn: false,
        environment: { SUPABASE_URL: 'https://abc.supabase.co' },
      }),
    ).rejects.toThrow('SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY');
  });
});

for (const failure of ['merge', 'write'] as const) {
  test(`a post-start ${failure} failure disposes all services`, async () => {
    const rec = recorder();
    producedRunIds.push(rec.runId);
    const disposed: string[] = [];
    const dependencies: Partial<DevStackDependencies> = {
      ...rec.dependencies,
      createService: async (id, context): Promise<LocalService> => {
        if (failure === 'write') {
          const { mkdir } = await import('node:fs/promises');
          const dir = join(REPO_ROOT, '.wrangler', 'runs', context.runId);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, 'stack.dev.vars'), 'already owned');
        }
        return {
          id,
          label: id,
          owned: true,
          vars: failure === 'merge' ? { CONTESTED: id } : {},
          summary: [],
          dispose: async () => {
            disposed.push(id);
            return [];
          },
        };
      },
    };
    await expect(
      prepareDevStack(['supabase', 'stripe'], 'http://127.0.0.1:5173', {}, dependencies),
    ).rejects.toThrow();
    expect(disposed).toEqual(['stripe', 'supabase']);
  });
}
