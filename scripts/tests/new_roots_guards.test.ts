// scripts/tests/new_roots_guards.test.ts
//
// The runtime roots this round added, and the rules that make them real.
//
// Four roots arrived with the plan: `packages/frontend/features` and
// `packages/frontend/platform` for code two hosts share, `apps/frontend/native`
// for the static SvelteKit app and its Tauri shell, and `apps/backend/jobs` for the
// scheduled Worker. None of them exists yet, which is exactly why the policy has to
// be written against them now: a rule that appears with the first file in a directory
// is a rule nobody reviewed, and a `^apps/` prefix would have classified the fourth
// application this round does not know about without anybody deciding what it is.
//
// So each case here builds the tree the root will hold and asserts the guard's answer
// about it, in both directions. A positive control per rule is not decoration: a
// negative control alone is satisfied by a guard that refuses everything.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Violation } from '../src/guards/boundary.ts';
import { guardArchitecture } from '../src/guards/guard_architecture.ts';
import { buildModuleGraph } from '../src/guards/module_graph.ts';
import { type Plane, planeOf, type Role, roleOf } from '../src/guards/policy.ts';
import { BASE_PROJECT, type Member, type Project, writeProject } from './fixtures/architecture.ts';

const created: string[] = [];

const makeProject = (project: Project): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-roots-'));
  created.push(root);
  writeProject(root, project);
  return root;
};

/** The scaffold plus whatever members a case is about. */
const withMembers = (members: readonly Member[], rootFiles: Project['rootFiles'] = undefined) => ({
  members: [...BASE_PROJECT.members, ...members],
  rootFiles,
});

const run = (root: string): Violation[] => guardArchitecture(root).violations;

const firstOf = (violations: readonly Violation[], rule: string): Violation | undefined =>
  violations.find((violation) => violation.rule === rule);

afterAll(() => {
  for (const root of created) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * `@tauri-apps/api` as an installed package.
 *
 * Written into the fixture's `node_modules` because the guard resolves through the
 * project's own module resolution and reports an uninstalled third-party specifier as
 * unresolved. A capability rule that can only fire on an unresolvable specifier would
 * be a rule that never fires.
 */
const TAURI_API: Record<string, string> = {
  'node_modules/@tauri-apps/api/package.json':
    '{"name":"@tauri-apps/api","version":"2.0.0","type":"module","exports":{"./core":"./core.js"}}\n',
  'node_modules/@tauri-apps/api/core.js': 'export const invoke = () => Promise.resolve(null);\n',
};

// ── the shared feature package ───────────────────────────────────────────────

const featuresMember = (files: Record<string, string>): Member => ({
  name: '@starter/features',
  dir: 'packages/frontend/features',
  dependencies: { '@starter/schemas': 'workspace:*' },
  files,
});

const FEATURE_FILES: Record<string, string> = {
  'src/notes/notes_view_model.svelte.ts':
    "import type { Note } from '@starter/schemas/notes';\nimport { notesService } from './notes_service.ts';\nexport class NotesViewModel {\n  service = notesService;\n  list: () => Note[] = () => [];\n}\n",
  'src/notes/notes_service.ts':
    "import type { Note } from '@starter/schemas/notes';\nexport type NotesService = { list: () => Note[] };\nexport const notesService: NotesService = { list: () => [] };\n",
  'src/notes/note_card.svelte':
    '<script lang="ts">\n  import type { NotesViewModel } from \'./notes_view_model.svelte.ts\';\n  let { model }: { model: NotesViewModel } = $props();\n</script>\n<article>{model.list().length}</article>\n',
};

describe('roots: packages/frontend/features keeps the feature layers', () => {
  test('accepts View -> ViewModel -> service in a shared package', () => {
    // The positive control. A package that cannot hold the architecture's own layers
    // is a package the architecture will be broken around rather than enforced in.
    expect(run(makeProject(withMembers([featuresMember(FEATURE_FILES)])))).toEqual([]);
  });

  test('rejects a shared View that imports a service directly', () => {
    // The same inversion the web app's own feature directory rejects. If the rule
    // were left matching only `apps/frontend/client/src/lib/features/**`, the first
    // component extracted into the shared package would have been free to call
    // transport directly — which is the one thing the layers exist to prevent.
    const root = makeProject(
      withMembers([
        featuresMember({
          ...FEATURE_FILES,
          'src/notes/note_card.svelte':
            '<script lang="ts">\n  import { notesService } from \'./notes_service.ts\';\n</script>\n<article>{notesService.list().length}</article>\n',
        }),
      ]),
    );

    const violation = firstOf(run(root), 'feature-layer');
    expect(violation, 'expected feature-layer').toBeDefined();
    expect(violation?.file).toBe('packages/frontend/features/src/notes/note_card.svelte');
    expect(violation?.message).toContain('view');
    expect(violation?.message).toContain('service');
  });

  test('rejects a shared feature that reaches an application by relative path', () => {
    // The edge this extraction was most likely to take by accident. The web
    // application's composition root owns a transport; a feature that imports it
    // would compile, would pass its own tests, and would then be unreachable from
    // the second host — with nothing in the type system saying so.
    //
    // The remedy the diagnostic prints is the one that works: publish the contract
    // (`@starter/platform`) and take it as a constructor argument.
    const features = featuresMember({
      ...FEATURE_FILES,
      'src/notes/notes_service.ts':
        "import { notesService } from '../../../../../apps/frontend/client/src/lib/features/notes/notes_service.ts';\nexport const leaked = notesService;\n",
    });

    const violation = firstOf(
      run(makeProject(withMembers([features]))),
      'cross-workspace-relative-import',
    );
    expect(violation, 'expected cross-workspace-relative-import').toBeDefined();
    expect(violation?.file).toBe('packages/frontend/features/src/notes/notes_service.ts');
    expect(violation?.message).toContain('apps/frontend/client');
    expect(violation?.message).toContain('exports');
  });

  test('rejects the Tauri API inside a shared feature', () => {
    // A native bridge is the native composition root's job and lives in the
    // `native-bridge` role there. A shared feature that imports it would be a
    // component that only resolves inside a desktop shell — and it would still be
    // in the web bundle, where `@tauri-apps/api` does not exist at all. The web
    // build is the host that finds out last, which is why this has to be a guard
    // and not a review convention.
    const features = featuresMember({
      ...FEATURE_FILES,
      'src/notes/note_card.svelte':
        '<script lang="ts">\n  import { invoke } from \'@tauri-apps/api/core\';\n</script>\n<article>{invoke}</article>\n',
    });

    const violation = firstOf(run(makeProject(withMembers([features]))), 'runtime-capability');
    expect(violation, 'expected runtime-capability').toBeDefined();
    expect(violation?.file).toBe('packages/frontend/features/src/notes/note_card.svelte');
    expect(violation?.message).toContain('native-runtime');
    // The positive half of the same rule: an ordinary shared component is fine.
    expect(run(makeProject(withMembers([featuresMember(FEATURE_FILES)])))).toEqual([]);
  });
});

// ── the native application ───────────────────────────────────────────────────

describe('roots: apps/frontend/native', () => {
  test('rejects a native page that reaches the Worker half of the web app', () => {
    // The static bundle and the SSR Worker are different hosts reached from different
    // repositories. A native component importing `@starter/database` is the exact
    // edge that would make a desktop build fail in review and work locally, because
    // `vite dev` for the native app has no worker to contradict it.
    const native: Member = {
      name: '@starter/native',
      dir: 'apps/frontend/native',
      dependencies: { '@starter/database': 'workspace:*' },
      files: {
        'src/routes/+page.svelte':
          '<script lang="ts">\n  import { notes } from \'@starter/database\';\n</script>\n<article>{notes.table}</article>\n',
      },
    };

    const root = makeProject(withMembers([native]));
    const reach = firstOf(run(root), 'plane-reachability');
    expect(reach, 'expected plane-reachability').toBeDefined();
    expect(reach?.file).toBe('apps/frontend/native/src/routes/+page.svelte');
  });

  test('confines the Tauri API to the native platform bridge', () => {
    // Two cases in one tree, because the rule has two halves and both matter. The
    // bridge may name `@tauri-apps/*`; a page beside it may not, even though both are
    // `browser`-plane files in the same application. Granting the capability to the
    // plane would have granted it to every component the native app will ever have.
    const native: Member = {
      name: '@starter/native',
      dir: 'apps/frontend/native',
      files: {
        ...TAURI_API,
        'src/lib/platform/bridge.ts':
          "import { invoke } from '@tauri-apps/api/core';\nexport const openExternal = (url: string): Promise<unknown> => invoke('open', { url });\n",
        'src/routes/+page.svelte':
          '<script lang="ts">\n  import { invoke } from \'@tauri-apps/api/core\';\n</script>\n<article>{invoke}</article>\n',
      },
    };

    const root = makeProject(withMembers([native]));
    const graph = buildModuleGraph(root);
    expect(graph.modules.get('apps/frontend/native/src/lib/platform/bridge.ts')?.role).toBe(
      'native-bridge',
    );

    const capability = firstOf(run(root), 'runtime-capability');
    expect(capability, 'expected runtime-capability').toBeDefined();
    expect(capability?.file).toBe('apps/frontend/native/src/routes/+page.svelte');
    expect(capability?.message).toContain('native-runtime');
    expect(capability?.message).toContain('native-bridge');
    // The bridge itself is the positive half of the same assertion.
    expect(
      run(root).filter(
        (violation) => violation.file === 'apps/frontend/native/src/lib/platform/bridge.ts',
      ),
    ).toEqual([]);
  });

  test('lets a route consume the composition root the bridge feeds', () => {
    // The other half of the rule above, and the reason it is phrased the way it is.
    // The composition root exists so routes can consume it; a rule that reported
    // every screen for reaching it would be forbidding dependency injection, and the
    // thing it complained about would be the architecture working.
    //
    // Three hops, deliberately: route -> composition -> bridge. The capability is
    // named in exactly one file, and the guard has to find that one file rather than
    // stopping at the immediate target.
    const native: Member = {
      name: '@starter/native',
      dir: 'apps/frontend/native',
      files: {
        ...TAURI_API,
        'src/lib/platform/bridge.ts':
          "import { invoke } from '@tauri-apps/api/core';\nexport const openExternal = (url: string): Promise<unknown> => invoke('open', { url });\n",
        'src/lib/composition/session.ts':
          "import { openExternal } from '../platform/bridge.ts';\nexport const open = (url: string): Promise<unknown> => openExternal(url);\n",
        'src/routes/+page.svelte':
          "<script lang=\"ts\">\n  import { open } from '../lib/composition/session.ts';\n</script>\n<button onclick={() => open('https://example.test')}>open</button>\n",
      },
    };

    expect(run(makeProject(withMembers([native])))).toEqual([]);
  });

  test('leaves the shell, its Rust and its generated projects out of the graph', () => {
    // Three separate claims, one tree. `src-tauri/**` is Node tooling as far as the
    // TypeScript graph is concerned; `.rs` is not TypeScript and is validated by its
    // own Cargo lane; and the Android/iOS projects Tauri generates are build products,
    // not sources — a `.ts` file inside one must not be reported as an unclassified
    // file, which would make `bun run guard` fail after a native build.
    const root = makeProject(
      withMembers(
        [
          {
            name: '@starter/native',
            dir: 'apps/frontend/native',
            files: {
              'src/lib/platform/bridge.ts': 'export const openExternal = (): void => {};\n',
            },
          },
        ],
        {
          'apps/frontend/native/src-tauri/tauri.conf.json': '{}\n',
          'apps/frontend/native/src-tauri/gen/android/build/generated.ts':
            "import { notes } from '@starter/database';\nexport const generated = notes;\n",
          'apps/frontend/native/src-tauri/src/lib.rs': 'pub fn run() {}\n',
          // The narrowing of the generation policy, at the graph level: this is a
          // source directory inside the same crate, and it has no manifest beside it
          // declaring it build output. A bare-name pattern would drop it silently —
          // from the graph and from discovery, with no violation either way.
          'apps/frontend/native/src-tauri/src/vendor/adapter.ts':
            "export const adapter = (): string => 'vendor';\n",
        },
      ),
    );

    const graph = buildModuleGraph(root);
    expect(graph.unclassified).toEqual([]);
    expect([...graph.modules.keys()].some((file) => file.includes('/gen/android/'))).toBe(false);
    expect(graph.modules.has('apps/frontend/native/src/lib/platform/bridge.ts')).toBe(true);
    expect(graph.modules.has('apps/frontend/native/src-tauri/src/vendor/adapter.ts')).toBe(true);
    expect(run(root)).toEqual([]);
  });

  test('skips a Cargo target directory by the manifest beside it', () => {
    // The other side of the same predicate: `target` beside a `Cargo.toml` is build
    // output, and `src-tauri/target` is build output by its fixed layout. Both are
    // skipped; a `target` elsewhere is not.
    const root = makeProject(
      withMembers(
        [
          {
            name: '@starter/media',
            dir: 'apps/backend/media',
            files: { 'src/lib.rs': 'pub fn run() {}\n' },
          },
        ],
        {
          'apps/backend/media/Cargo.toml': '[package]\nname = "media"\n',
          'apps/backend/media/target/debug/build/probe/out/main.ts':
            "import { notes } from '@starter/database';\nexport const generated = notes;\n",
        },
      ),
    );

    const graph = buildModuleGraph(root);
    expect([...graph.modules.keys()].some((file) => file.includes('/target/'))).toBe(false);
    expect(graph.unclassified).toEqual([]);
  });
});

// ── the jobs Worker ──────────────────────────────────────────────────────────

describe('roots: apps/backend/jobs', () => {
  test('reaches the server packages and nothing an application owns', () => {
    const jobs: Member = {
      name: '@starter/jobs',
      dir: 'apps/backend/jobs',
      dependencies: { '@starter/database': 'workspace:*' },
      files: {
        'src/index.ts':
          "import { notes } from '@starter/database';\nexport const cleanup = (): void => void notes.table;\n",
      },
    };

    expect(run(makeProject(withMembers([jobs])))).toEqual([]);
  });

  test('rejects a jobs module that reaches into an application by path', () => {
    // "The jobs Worker does not import the web app" is a design statement, and a
    // design statement that nothing checks is a wish. The lawful route is a shared
    // package both may import — which is why the remedy in the diagnostic names the
    // `exports` map rather than "do not do that".
    const jobs: Member = {
      name: '@starter/jobs',
      dir: 'apps/backend/jobs',
      files: {
        'src/index.ts':
          "import { save } from '../../../frontend/client/src/lib/server/service.ts';\nexport const run = (): void => void save;\n",
      },
    };

    const root = makeProject(withMembers([jobs]));
    const violation = firstOf(run(root), 'cross-workspace-relative-import');
    expect(violation, 'expected cross-workspace-relative-import').toBeDefined();
    expect(violation?.file).toBe('apps/backend/jobs/src/index.ts');
    expect(violation?.message).toContain('Chain:');
    expect(violation?.message).toContain('exports');
  });

  test('discovers an unknown application and refuses to classify it', () => {
    // The property that keeps a blanket prefix out of the policy: `apps/backend/`
    // is *not* a plane. An application this round has never heard of is reported as
    // unclassified, with the instruction to say what it is, rather than inheriting
    // `worker` because of where it sits.
    const unknown: Member = {
      name: '@starter/analytics',
      dir: 'apps/backend/analytics',
      files: { 'src/index.ts': 'export const track = (): void => {};\n' },
    };
    const jobs: Member = {
      name: '@starter/jobs',
      dir: 'apps/backend/jobs',
      files: { 'src/index.ts': 'export const run = (): void => {};\n' },
    };

    const root = makeProject(withMembers([unknown, jobs]));
    const graph = buildModuleGraph(root);

    expect(graph.unclassified).toEqual(['apps/backend/analytics/src/index.ts']);
    expect(graph.modules.get('apps/backend/jobs/src/index.ts')?.plane).toBe('worker');
    expect(firstOf(run(root), 'unclassified-source')?.message).toContain(
      'PLANE_PLACEMENTS and ROLE_PLACEMENTS',
    );
  });
});

// ── cross-workspace relative imports ─────────────────────────────────────────

describe('roots: a relative path may not leave its workspace', () => {
  test('rejects a bypass between two packages on the same plane', () => {
    // The case the plane matrix cannot see. Both packages are `browser`, so the
    // reachability rules are satisfied, the `exports` map is never consulted and the
    // dependency list never gains an entry — and the edge keeps resolving after a
    // file move. Only a rule about the *declaration* catches it.
    const features = featuresMember({
      'src/index.ts': "export { Spinner } from '../../ui/src/index.ts';\n",
    });

    const root = makeProject(withMembers([features]));
    const violations = run(root);
    expect(violations.filter((violation) => violation.rule === 'plane-reachability')).toEqual([]);

    const bypass = firstOf(violations, 'cross-workspace-relative-import');
    expect(bypass, 'expected cross-workspace-relative-import').toBeDefined();
    expect(bypass?.message).toContain('packages/frontend/features');
    expect(bypass?.message).toContain('packages/frontend/ui');
  });

  test('accepts a type-only relative import and says why', () => {
    // The stated exemption, checked so it cannot quietly become a hole: TypeScript
    // erases the declaration, so this edge cannot reach a bundle. The compile-time
    // coupling it does create is owned by the server-type-only rule.
    const features = featuresMember({
      'src/index.ts':
        "import type { Spinner } from '../../ui/src/index.ts';\nexport type Card = typeof Spinner;\n",
    });

    expect(run(makeProject(withMembers([features])))).toEqual([]);
  });

  test('accepts the declared test-harness exemptions', () => {
    // `apps/e2e -> scripts` and `apps/frontend/client -> scripts` are in the policy
    // with their reasons, and both exist in the scaffold. If either were refused the
    // harness could not test the real tooling.
    expect(run(makeProject(BASE_PROJECT))).toEqual([]);
  });

  test('reports an exemption nobody uses any more', () => {
    // The half that stops the table growing by accident: remove the Vitest config and
    // the `apps/frontend/client -> scripts` row has no edge left to justify it.
    const withoutConfig: Project = {
      members: BASE_PROJECT.members.map((member) => {
        if (member.dir !== 'apps/frontend/client') {
          return member;
        }
        // Omitted rather than emptied: `writeProject` skips an empty file, so writing
        // `''` here would leave the config on disk with nothing in it.
        const { 'vitest.config.ts': _removed, ...files } = member.files ?? {};
        return { ...member, files };
      }),
    };

    const violation = firstOf(run(makeProject(withoutConfig)), 'stale-relative-import-exemption');
    expect(violation, 'expected stale-relative-import-exemption').toBeDefined();
    expect(violation?.message).toContain('apps/frontend/client -> scripts');
    // The row that is still in use is not reported.
    expect(
      run(makeProject(withoutConfig)).filter((entry) =>
        entry.message.includes('apps/e2e -> scripts'),
      ),
    ).toEqual([]);
  });
});

// ── the policy rows themselves ───────────────────────────────────────────────

describe('roots: the policy table classifies a path with no file behind it', () => {
  // The fixture cases above prove what the guard does with a root that *has* files.
  // This proves the property only the table can show: the four roots are classified
  // before they hold anything, which is the whole reason they were added to `policy.ts`
  // rather than being discovered from a directory listing.
  //
  // A direct table lookup, not a scan of the repository. The live tree has no file
  // under two of these roots yet, so a scan can only assert that nothing was
  // reported — which is a statement about the tree today, not about the policy, and it
  // costs a full parse of every source file to make it. The live control belongs to
  // `architecture_guards.test.ts`, which already owns "this repository satisfies every
  // rule".
  test.each<[string, Plane, Role]>([
    ['packages/frontend/features/src/notes/note_card.svelte', 'browser', 'view'],
    ['packages/frontend/features/src/notes/notes_view_model.svelte.ts', 'browser', 'view-model'],
    ['packages/frontend/features/src/notes/notes_service.ts', 'browser', 'service'],
    ['packages/frontend/platform/src/transport.ts', 'browser', 'module'],
    ['apps/frontend/native/src/routes/+page.svelte', 'browser', 'route-view'],
    ['apps/frontend/native/src/lib/platform/bridge.ts', 'browser', 'native-bridge'],
    ['apps/frontend/native/src/lib/session.ts', 'browser', 'module'],
    ['apps/frontend/native/vite.config.ts', 'node', 'config'],
    ['apps/frontend/native/src-tauri/tauri.conf.json', 'node', 'module'],
    ['apps/backend/jobs/src/index.ts', 'worker', 'module'],
  ])('classifies %s as %s/%s', (file, plane, role) => {
    expect(planeOf(file)).toBe(plane);
    expect(roleOf(file)).toBe(role);
  });

  test('refuses an application root it was not told about', () => {
    // The property that keeps the table from growing by prefix: an application this
    // round has never heard of has **no plane**, and `buildModuleGraph` keeps a file
    // only when both a plane and a role are found. So the file lands in `unclassified`
    // and is reported, rather than inheriting a plane from its parent directory.
    //
    // The role alone is not the gate — the catch-all `{ role: 'module' }` row at the
    // end of `ROLE_PLACEMENTS` matches every application, and that is deliberate: it
    // is the *plane* row that is a decision, and a role of `module` claims nothing
    // about runtime. The fixture case above proves the end-to-end consequence.
    expect(planeOf('apps/backend/analytics/src/index.ts')).toBeNull();
  });
});
