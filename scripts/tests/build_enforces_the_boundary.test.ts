// scripts/tests/build_enforces_the_boundary.test.ts
//
// The negative control the architecture guard cannot replace: the real production
// build, failing on a browser import of a server module.
//
// The guard checks a resolved module graph. The framework checks what the bundler is
// willing to put in a browser chunk. Both are gates, and the work that introduced this
// file is explicit that one is not a substitute for the other — so this proves the
// second gate is real, on the real build command, and then restores the tree.
//
// Why not a test runner. A test runner resolves imports with its own resolver, and
// whether the framework's server-only protection applies inside `bun test` depends on
// that runner rather than on the build. Asserting "the build catches it" with anything
// other than `vite build` would assert nothing.
//
// Why not `bun run build`. That is Moon's cached task, and the cache is the point: an
// injected source change is not in its declared inputs, so the task returned a warm hit
// and the build never ran. That is a real finding about the task graph rather than
// something to work around silently, and this file drives `vite build` directly so the
// assertion is about the bundler. Moon's task-graph inputs belong to a different change.
//
// Cost, stated plainly: this runs the production build twice, and that is most of the
// wall clock of this lane. It is here because a gate never observed to close is a
// belief rather than a gate.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardArchitecture } from '../src/guards/guard_architecture.ts';
import { CLIENT_DIR_RELATIVE, REPO_ROOT } from '../src/shared/paths.ts';

/**
 * The file a browser component will reach into.
 *
 * A `+page.svelte` is deliberately the browser half of the application's routes: the
 * guard's own policy excludes it from the Worker half precisely so a component keeps
 * the browser-only permission set. That makes it the right place to inject.
 */
const LANDING_PAGE = join(CLIENT_DIR_RELATIVE, 'src/routes/+page.svelte');

/**
 * A server module that a browser component must not reach.
 *
 * `getContainer` composes the D1 handle and the Better Auth instance. It is the most
 * sensitive module in the application, which makes it the right subject: if the build
 * tolerates a component importing *this*, it tolerates anything.
 */
const SERVER_MODULE = '#lib/server/container.ts';

const path = join(REPO_ROOT, LANDING_PAGE);
let original: string | undefined;

/**
 * Insert the import into the component's existing `<script>` block.
 *
 * Prepending a whole `<script>` element instead fails the build for the wrong reason —
 * Svelte rejects a duplicate top-level script — and the first version of this test did
 * exactly that. It still failed, which is the lesson: a negative control that only
 * asserts "the command exited nonzero" passes on any breakage at all. Asserting on the
 * framework's own error code is what makes the assertion specific.
 */
const inject = (source: string): string => {
  const open = source.indexOf('<script');
  if (open === -1) {
    throw new Error(`No <script> element in ${LANDING_PAGE}; the fixture needs one.`);
  }
  const insertAt = source.indexOf('>', open) + 1;
  return `${source.slice(0, insertAt)}\n  import { getContainer } from '${SERVER_MODULE}';${source.slice(insertAt)}`;
};

interface BuildResult {
  readonly code: number;
  readonly output: string;
}

/** The real production build, uncached. */
const build = (): BuildResult => {
  const result = Bun.spawnSync({
    cmd: ['bun', 'run', 'build'],
    cwd: join(REPO_ROOT, CLIENT_DIR_RELATIVE),
    // Bounded: a build that hangs must fail this test rather than hang the lane.
    timeout: 10 * 60 * 1000,
  });
  return {
    code: result.exitCode,
    output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
  };
};

beforeAll(() => {
  original = readFileSync(path, 'utf8');
});

afterAll(() => {
  if (original !== undefined) {
    writeFileSync(path, original, 'utf8');
  }
});

describe('the production build is a second gate', () => {
  test('the unmodified application builds', () => {
    // The positive half, and it comes first on purpose. A test that only ever asserts
    // failure cannot tell a build that rejects a server import from a build that
    // rejects everything, including the repository as committed.
    const result = build();
    expect(result.code, `build failed on a clean tree:\n${result.output}`).toBe(0);
  });

  test('rejects browser access to a server module, and restores the tree', () => {
    writeFileSync(path, inject(original ?? ''), 'utf8');

    try {
      const result = build();

      expect(
        result.code,
        'the production build accepted a server import in the browser half',
      ).not.toBe(0);
      // The framework's own error code, not merely "the build failed". Asserting on the
      // code is what distinguishes this from an unrelated breakage.
      expect(result.output).toContain('server_only_import');
      expect(result.output).toContain('container.ts');
    } finally {
      // Restored in a `finally`, so a failed assertion cannot leave a broken tree for
      // the next test or the next run. The whole point of injecting a fault is to undo
      // it.
      writeFileSync(path, original ?? '', 'utf8');
    }
  });

  test('the graph guard rejects the same import, on the same file, with no build', () => {
    // The two gates are independent, and this is why both exist. The guard catches it
    // from the source graph with no bundler involved; the build catches it from the
    // module its bundler resolved. Neither can stand in for the other.
    //
    // Same fault, same file, both gates in one place — so a reader can see they are not
    // the same check wearing two hats.
    writeFileSync(path, inject(original ?? ''), 'utf8');
    try {
      const forLanding = guardArchitecture(REPO_ROOT).violations.filter(
        (violation) => violation.file === LANDING_PAGE.split('\\').join('/'),
      );
      const rules = forLanding.map((violation) => violation.rule);

      expect(rules).toContain('plane-reachability');
      expect(forLanding.some((violation) => violation.message.includes('container.ts'))).toBe(true);
    } finally {
      writeFileSync(path, original ?? '', 'utf8');
    }
  });
});
