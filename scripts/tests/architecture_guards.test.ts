// scripts/tests/architecture_guards.test.ts
//
// The architecture guard, proved against disposable fixture projects.
//
// Every case here builds a throwaway tree, runs the guard over it, and asserts on the
// violations. The reason is the one in AGENTS.md: a guard that has only ever run clean
// may be reporting `ok` because it read nothing, and a guard run against the live tree
// cannot be shown to fail without breaking the repository to prove it.
//
// Two kinds of test, and the difference matters:
//
//   - In-process cases call `guardArchitecture(root)` and assert on rules and chains.
//     They are fast, and they say *which* invariant holds.
//   - The `guard command` cases spawn the real CLI, `bun run src/cli.ts guard`, and
//     assert on exit status and output. They cover what a developer actually runs:
//     flag parsing, the entrypoint, and the fact that a violation is nonzero rather
//     than a warning nobody sees.
//
// The negative controls are the point of the file. Each one is a way the *previous*
// implementation could not see: a relative path climbing out of its layer, an alias, a
// barrel re-export, a dynamic import, a Node-only subpath, a view calling a service,
// and a workspace package that did not exist when the policy was written.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Violation } from '../src/guards/boundary.ts';
import { guardArchitecture } from '../src/guards/guard_architecture.ts';
import {
  buildModuleGraph,
  listRepositorySourceFiles,
  ProjectRegistry,
  runtimeTargets,
} from '../src/guards/module_graph.ts';
import { readSelection } from '../src/guards/run_guards.ts';
import { REPO_ROOT } from '../src/shared/paths.ts';
import { BASE_PROJECT, type Member, type Project, writeProject } from './fixtures/architecture.ts';

const created: string[] = [];

/** A throwaway project, built from the scaffold unless the case says otherwise. */
const makeProject = (project: Project): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-architecture-'));
  created.push(root);
  writeProject(root, project);
  return root;
};

/**
 * The scaffold with one member's files replaced.
 *
 * Cases read as one or two changed files rather than as a whole second project, so a
 * reviewer can see what the case is about without diffing it against the scaffold.
 */
const withClientFiles = (
  overrides: Record<string, string>,
  extraMembers: Member[] = [],
  rootFiles: Project['rootFiles'] = undefined,
): Project => ({
  rootFiles,
  members: [
    ...BASE.members.map((member) =>
      member.dir === 'apps/frontend/client'
        ? { ...member, files: { ...member.files, ...overrides } }
        : member,
    ),
    ...extraMembers,
  ],
});

const run = (root: string): Violation[] => guardArchitecture(root).violations;

const BASE: Project = BASE_PROJECT;

const rulesOf = (violations: readonly Violation[]): string[] => [
  ...new Set(violations.map((violation) => violation.rule)),
];

const firstOf = (violations: readonly Violation[], rule: string): Violation | undefined =>
  violations.find((violation) => violation.rule === rule);

/**
 * The violation a rule raised *about a particular file*.
 *
 * Asserting on the first violation of a rule is a trap: the guard reports every module
 * that can reach the offending target, so the page that renders a leaky component is
 * named before the component itself. Each case below states which module it is about.
 */
const forFile = (
  violations: readonly Violation[],
  rule: string,
  file: string,
): Violation | undefined =>
  violations.find((violation) => violation.rule === rule && violation.file === file);

afterAll(() => {
  for (const root of created) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the scaffold itself ──────────────────────────────────────────────────────

/**
 * A module with a non-literal dynamic import.
 *
 * The `${` is assembled rather than written literally, because in a plain string Biome
 * correctly reads it as a stray template placeholder. Building it keeps the fixture
 * honest; suppressing the rule instead would mean this repository had a suppression it
 * does not otherwise need.
 */
const INTERPOLATION = '$' + '{name}';
const nonLiteralImport = (): string =>
  `export const load = async (name: string): Promise<unknown> => import(\`./${INTERPOLATION}.ts\`);\n`;

describe('architecture: a conformant project', () => {
  test('reports nothing for a tree that respects every boundary', () => {
    // The positive control. Without it, every negative below would be satisfied by a
    // guard that reports everything and nothing distinguishes a real check from a
    // broken one.
    expect(run(makeProject(BASE))).toEqual([]);
  });

  test('reads a real module graph rather than guessing', () => {
    // Every discovered source file is either in the graph or reported as unclassified.
    // Without this, a discovery walk that quietly skipped a directory would look like a
    // clean project in every other case in this file.
    const root = makeProject(BASE);
    const graph = buildModuleGraph(root);
    const discovered = listRepositorySourceFiles(root).length;

    expect(discovered).toBeGreaterThan(0);
    expect(graph.modules.size + graph.unclassified.length).toBe(discovered);
  });

  test('declares a zero baseline, because a baseline is how a failure hides', () => {
    expect(guardArchitecture(makeProject(BASE)).baselineCount).toBe(0);
  });
});

// ── negative controls: the required failures ─────────────────────────────────

describe('architecture: browser code cannot reach the Worker half', () => {
  test('a generated remote endpoint may reach its service, but an ordinary browser module may not import it', () => {
    const allowed = makeProject(
      withClientFiles({
        'src/lib/server/notes_service.ts':
          'export const listNotes = () => ["owner scoped"] as const;\n',
        'src/lib/remote/notes.remote.ts':
          "import { listNotes } from '#lib/server/notes_service.ts'; export const queryNotes = () => listNotes();\n",
        'src/routes/notes/+page.svelte':
          "<script>import { queryNotes } from '#lib/remote/notes.remote.ts';</script><p>{queryNotes}</p>\n",
      }),
    );
    const allowedViolations = run(allowed);
    expect(
      forFile(
        allowedViolations,
        'plane-reachability',
        'apps/frontend/client/src/routes/notes/+page.svelte',
      ),
    ).toBeUndefined();
    expect(
      forFile(
        allowedViolations,
        'plane-reachability',
        'apps/frontend/client/src/lib/remote/notes.remote.ts',
      ),
    ).toBeUndefined();

    const refused = makeProject(
      withClientFiles({
        'src/lib/server/notes_service.ts':
          'export const listNotes = () => ["owner scoped"] as const;\n',
        'src/lib/remote/notes.remote.ts':
          "import { listNotes } from '#lib/server/notes_service.ts'; export const queryNotes = () => listNotes();\n",
        'src/lib/probe.ts':
          "import { queryNotes } from '#lib/remote/notes.remote.ts'; export const probe = queryNotes;\n",
      }),
    );
    const violation = forFile(
      run(refused),
      'plane-reachability',
      'apps/frontend/client/src/lib/probe.ts',
    );
    expect(violation?.message).toContain('browser module reaches a worker module');
  });

  test('rejects a relative path that climbs out of the browser half', () => {
    // The old guard looked only at `@starter/`-prefixed specifiers, so this import was
    // invisible to it however far up the tree it pointed. Three `..` from
    // `src/lib/features/notes/` lands in `src/lib/server/` — a route out of the
    // feature, through the directory layout, with no package name anywhere in it.
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/note_card.svelte': `<script lang="ts">
  import { notes } from '../../server/db.ts';
</script>
<article>{notes.table}</article>
`,
      }),
    );

    const violations = run(root);
    const reach = forFile(
      violations,
      'plane-reachability',
      'apps/frontend/client/src/lib/features/notes/note_card.svelte',
    );
    expect(reach, 'expected plane-reachability on the component').toBeDefined();
    expect(reach?.message).toContain('src/lib/server/db.ts');
  });

  test('rejects an alias that reaches a server module', () => {
    // `#lib` is SvelteKit's own alias, declared in a tsconfig it generates. A guard
    // that reads the project's `paths` resolves it; one that reads specifier text does
    // not see past the `#`.
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/note_card.svelte': `<script lang="ts">
  import { notes } from '#lib/server/db.ts';
</script>
<article>{notes.table}</article>
`,
      }),
    );

    const reach = firstOf(run(root), 'plane-reachability');
    expect(reach, 'expected plane-reachability').toBeDefined();
    expect(reach?.message).toContain('src/lib/server/db.ts');
  });

  test('rejects a literal dynamic import of a server module', () => {
    // The old pattern matched `import('…')` textually, but only for a specifier it
    // could already resolve; here the reachability is what matters and the import is
    // inside a component.
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/notes_view_model.svelte.ts':
          "export const load = async (): Promise<unknown> => import('@starter/database');\n",
      }),
    );

    const reach = firstOf(run(root), 'plane-reachability');
    expect(reach, 'expected plane-reachability').toBeDefined();
    expect(reach?.line).toBe(1);
  });

  test('rejects a Node-only package subpath reached from the browser', () => {
    // The load-bearing case for capability tracking. `@starter/utils` is portable, and
    // `@starter/utils/process` lives inside it, so a plane check that only looked at
    // the package would see a legal edge. The Node requirement travels through the
    // subpath to `node:child_process`, and the browser half does not have Node.
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/note_card.svelte': `<script lang="ts">
  import { killTree } from '@starter/utils/process';
</script>
<article>{killTree}</article>
`,
      }),
    );

    const capability = firstOf(run(root), 'runtime-capability');
    expect(capability, 'expected runtime-capability').toBeDefined();
    expect(capability?.message).toContain('node-runtime');
  });

  test("refuses a deep import that bypasses a package's exports", () => {
    // `@starter/schemas/src/notes/index.ts` resolves today and keeps resolving after a
    // file move the author did not consider. The exports map is the declaration.
    const root = makeProject(
      withClientFiles({
        'src/routes/api/notes/+server.ts':
          "import { notes } from '@starter/schemas/src/notes/index.ts';\nexport const notes_ = notes;\n",
      }),
    );

    const violation = firstOf(run(root), 'package-exports');
    expect(violation, 'expected package-exports').toBeDefined();
    expect(violation?.message).toContain('@starter/schemas');
    // The message lists what the map *does* publish, so the fix is legible.
    expect(violation?.message).toContain('notes');
  });
});

describe('architecture: barrel re-exports do not launder a boundary', () => {
  test('rejects a portable barrel that re-exports a server module', () => {
    // A direct edge check stops at the barrel: the browser's own import is legal, and
    // the barrel is legal, and the database is in the server package. Only transitive
    // reachability sees that the browser can load the database by naming the barrel.
    //
    // The leak goes through `src/notes/index.ts` because that is the subpath the
    // component actually imports, so the chain under test is the real one.
    const root = makeProject({
      members: BASE.members.map((member) =>
        member.name === '@starter/schemas'
          ? {
              ...member,
              files: {
                ...member.files,
                'src/notes/index.ts':
                  "export type Note = { id: string; body: string };\nexport { notes } from '@starter/database';\n",
              },
              dependencies: { '@starter/database': 'workspace:*' },
            }
          : member,
      ),
    });

    const violations = run(root);
    // The barrel itself is a portable module reaching a server one.
    expect(
      forFile(violations, 'plane-reachability', 'packages/shared/schemas/src/notes/index.ts'),
      'expected the barrel to be implicated',
    ).toBeDefined();
    // And the browser module that only ever named the barrel is implicated too, with
    // the barrel in the chain. This is the violation the old guard could not produce.
    const leaked = forFile(
      violations,
      'plane-reachability',
      'apps/frontend/client/src/lib/features/notes/note_card.svelte',
    );
    expect(leaked, 'expected the browser half to be implicated').toBeDefined();
    expect(leaked?.message).toContain('packages/shared/schemas/src/notes/index.ts');
    expect(leaked?.message).toContain('packages/backend/database/src/index.ts');
  });
});

describe('architecture: the feature-local layers', () => {
  test('rejects a view that calls a client service directly', () => {
    // View -> ViewModel -> service. A view that reaches the service has skipped the
    // state machine, so the component cannot be tested without the transport.
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/note_card.svelte': `<script lang="ts">
  import { notesService } from './notes_service.ts';
  import type { NotesViewModel } from './notes_view_model.svelte.ts';
  let { model }: { model: NotesViewModel } = $props();
</script>
<article>{notesService.list()}</article>
`,
      }),
    );

    const violation = firstOf(run(root), 'feature-layer');
    expect(violation, 'expected feature-layer').toBeDefined();
    expect(violation?.message).toContain('view');
    expect(violation?.message).toContain('service');
  });

  test('rejects a service that imports a view model', () => {
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/notes_service.ts':
          "import { NotesViewModel } from './notes_view_model.svelte.ts';\nexport type NotesService = { model: NotesViewModel };\nexport const notesService = {} as NotesService;\n",
      }),
    );

    expect(firstOf(run(root), 'feature-layer')?.message).toContain('must not import');
  });

  test('accepts a view model that uses a client service', () => {
    // The permitted direction, stated so a later broadening of the rule is visible.
    const root = makeProject(BASE);
    expect(rulesOf(run(root))).toEqual([]);
  });
});

describe('architecture: a new workspace package is judged, not skipped', () => {
  test('rejects a newly added package whose edge is illegal', () => {
    // Added after the policy was written, so nothing lists it by name. It is portable —
    // `packages/shared/*` — and it reaches the server database package.
    const newPackage: Member = {
      name: '@starter/notes-report',
      dir: 'packages/shared/notes-report',
      dependencies: { '@starter/database': 'workspace:*' },
      files: {
        'src/index.ts':
          "import { notes } from '@starter/database';\nexport const count = (): number => notes.table ? 1 : 0;\n",
      },
    };

    const root = makeProject(withClientFiles({}, [newPackage]));

    const violation = firstOf(run(root), 'plane-reachability');
    expect(violation, 'expected plane-reachability').toBeDefined();
    expect(violation?.file).toBe('packages/shared/notes-report/src/index.ts');
  });

  test('rejects a new package that imports one it never declared', () => {
    const newPackage: Member = {
      name: '@starter/undeclared',
      dir: 'packages/shared/undeclared',
      files: {
        'src/index.ts': "import { createId } from '@starter/utils';\nexport const id = createId;\n",
      },
    };

    const root = makeProject(withClientFiles({}, [newPackage]));

    const violation = firstOf(run(root), 'undeclared-dependency');
    expect(violation, 'expected undeclared-dependency').toBeDefined();
    expect(violation?.message).toContain('@starter/undeclared');
    expect(violation?.message).toContain('@starter/utils');
  });
});

// ── positive controls that must keep passing ─────────────────────────────────

describe('architecture: legitimate edges', () => {
  test('accepts the SvelteKit server plane importing the server packages', () => {
    // `+server.ts` and `src/lib/server/**` are the shapes SvelteKit compiles into the
    // Worker. Refusing them would make the architecture unimplementable.
    expect(rulesOf(run(makeProject(BASE)))).toEqual([]);
  });

  test('accepts a type-only import of a DTO from a view', () => {
    // Type-only edges are erased, so they are not runtime reachability, and a DTO in
    // the portable package is exactly what is meant to cross.
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/note_card.svelte': `<script lang="ts">
  import type { Note } from '@starter/schemas/notes';
  let { note }: { note: Note } = $props();
</script>
<article>{note.body}</article>
`,
      }),
    );

    expect(rulesOf(run(root))).toEqual([]);
  });

  test('accepts a component that mentions a forbidden package only in prose', () => {
    // The reason this guard parses instead of scanning: a doc comment naming a server
    // package is the single most common thing a component file contains, and a
    // text-scanning guard either trips on it or has to be special-cased.
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/note_card.svelte': `<script lang="ts">
  // Never import the notes schema here: '@starter/database' owns persistence.
  const label = 'note: see @starter/database for the schema';
  let { text }: { text: string } = $props();
</script>
<article>{label}{text}</article>
`,
      }),
    );

    expect(rulesOf(run(root))).toEqual([]);
  });

  test('accepts tooling reaching the declared Node-only subpath', () => {
    // The legal direction for `@starter/utils/process`. `scripts/` runs on Node, so
    // this is what the declaration is for.
    expect(rulesOf(run(makeProject(BASE)))).toEqual([]);
  });
});

describe('architecture: the boundary between a type-only import and a private entity', () => {
  test('rejects a browser module type-importing the ORM package', () => {
    // A DTO belongs in `@starter/schemas`. Sharing the schema's *types* would tie the
    // browser's compile-time surface to a private server entity, and the first value
    // import after that is a small step rather than a large one.
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/notes_view_model.svelte.ts':
          "import type { notes } from '@starter/database';\nexport const columns = notes.table ? [] : [];\n",
      }),
    );

    const violation = firstOf(run(root), 'server-type-only');
    expect(violation, 'expected server-type-only').toBeDefined();
    expect(violation?.message).toContain('type-only');
  });

  test('accepts a declaration file naming a server module', () => {
    // `src/app.d.ts` must name `Container` to declare `App.Locals`. That is the
    // framework's own type channel and it emits no code, so it is not reachability.
    const root = makeProject(BASE);
    expect(run(root).filter((violation) => violation.file.endsWith('src/app.d.ts'))).toEqual([]);
  });
});

// ── honesty about what could not be read ─────────────────────────────────────

describe('architecture: failure is reported, never swallowed', () => {
  test('reports a file that will not parse', () => {
    // A half-read graph reporting `ok` is the outcome this whole file exists to
    // prevent, and it is indistinguishable from a clean tree.
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/note_card.svelte': `<script lang="ts">
  const broken = ;
</script>
<article>hi</article>
`,
      }),
    );

    expect(firstOf(run(root), 'parse-error')).toBeDefined();
  });

  test('reports a first-party specifier that does not resolve', () => {
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/note_card.svelte': `<script lang="ts">
  import { gone } from '#lib/features/notes/gone.svelte';
</script>
<article>{gone}</article>
`,
      }),
    );

    const violation = firstOf(run(root), 'unresolved-first-party');
    expect(violation, 'expected unresolved-first-party').toBeDefined();
    expect(violation?.message).toContain('gone.svelte');
  });

  test('reports a non-literal dynamic import in application code', () => {
    // Not "proved safe". Not checked, and said so: the bounded policy is that
    // application code has none, and a test may.
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/notes_view_model.svelte.ts': nonLiteralImport(),
      }),
    );

    const violation = firstOf(run(root), 'nonliteral-dynamic-import');
    expect(violation, 'expected nonliteral-dynamic-import').toBeDefined();
  });

  test('accepts a non-literal dynamic import in a test, which ships nothing', () => {
    const root = makeProject(
      withClientFiles({
        'tests/probe.test.ts': nonLiteralImport(),
      }),
    );

    const probe = buildModuleGraph(root).modules.get('apps/frontend/client/tests/probe.test.ts');
    expect(probe?.role).toBe('test');
    expect(
      probe?.edges.some(
        (edge) =>
          edge.resolution.kind === 'unresolved' &&
          edge.resolution.unresolvedReason === 'nonliteral',
      ),
    ).toBe(true);
    expect(rulesOf(run(root))).not.toContain('nonliteral-dynamic-import');
  });

  test('reports a source file no placement row covers', () => {
    // A file the policy does not classify has no plane and no role, so nothing about it
    // can be checked. Silence there would be indistinguishable from permission.
    const root = makeProject({
      members: BASE.members,
      rootFiles: {
        'apps/unowned/tool.ts':
          "import { notes } from '@starter/database';\nexport const n = notes;\n",
      },
    });

    const violation = firstOf(run(root), 'unclassified-source');
    expect(violation, 'expected unclassified-source').toBeDefined();
    expect(violation?.file).toBe('apps/unowned/tool.ts');
  });

  test('reports a project whose tsconfig cannot be read', () => {
    const root = makeProject(
      withClientFiles({}, [], { 'packages/shared/schemas/tsconfig.json': '{ this is not json' }),
    );

    const violation = firstOf(run(root), 'project-config');
    expect(violation, 'expected project-config').toBeDefined();
  });

  test('reports a graph that discovered nothing at all', () => {
    // The last honesty case. Zero discovered modules means nothing was checked, and a
    // guard that reports `ok` there is indistinguishable from one that passed.
    const empty = mkdtempSync(join(tmpdir(), 'starter-architecture-empty-'));
    created.push(empty);
    writeProject(empty, { members: [] });

    const violation = firstOf(run(empty), 'empty-graph');
    expect(violation, 'expected empty-graph').toBeDefined();
  });

  test('rejects a package cycle', () => {
    // `@starter/schemas` and `@starter/ui` point at each other. Neither edge crosses a
    // plane, so the reachability rules cannot see it: what makes it a defect is that a
    // cycle cannot be built in dependency order.
    const withCycle = (member: Member): Member => {
      if (member.name === '@starter/schemas') {
        return {
          ...member,
          files: {
            ...member.files,
            'src/index.ts':
              "export * from './notes/index.ts';\nexport { Spinner } from '@starter/ui';\n",
          },
          dependencies: { '@starter/ui': 'workspace:*' },
        };
      }
      if (member.name === '@starter/ui') {
        return {
          ...member,
          files: {
            ...member.files,
            'src/index.ts':
              "export { noteMaxLength } from '@starter/schemas';\nexport const Spinner = noteMaxLength;\n",
          },
          dependencies: { '@starter/schemas': 'workspace:*' },
        };
      }
      return member;
    };

    const root = makeProject({ members: BASE.members.map(withCycle) });

    const violation = firstOf(run(root), 'package-cycle');
    expect(violation, 'expected package-cycle').toBeDefined();
    expect(violation?.message).toContain('@starter/schemas');
    expect(violation?.message).toContain('@starter/ui');
  });

  test('rejects a Node-only module in the portable core that nobody published', () => {
    // A third Node-only helper, with no declared subpath. It is classified `portable`
    // because that is what the directory says, and the capability rule is what catches
    // it: the portable core may not need Node. This is the rule that stops
    // `NODE_ONLY_MODULES` from being the only thing standing between a shared package and
    // `node:fs`.
    const root = makeProject({
      members: BASE.members.map((member) =>
        member.name === '@starter/utils'
          ? {
              ...member,
              files: {
                ...member.files,
                'src/lib/net/read_file.ts':
                  "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;\n",
              },
            }
          : member,
      ),
    });

    const capability = forFile(
      run(root),
      'runtime-capability',
      'packages/shared/utils/src/lib/net/read_file.ts',
    );
    expect(capability, 'expected runtime-capability').toBeDefined();
    expect(capability?.message).toContain('portable may use: nothing');
  });

  test('rejects a Node-only declaration whose subpath no longer exists', () => {
    // The other half. `@starter/utils/process` is published by an entry in the exports
    // map, and that entry is the whole reason the declaration is safe. Remove it and the
    // declaration becomes an exemption with no way in — so the guard says so rather than
    // continuing to honour it.
    const root = makeProject({
      members: BASE.members.map((member) =>
        member.name === '@starter/utils'
          ? { ...member, exports: { '.': './src/index.ts' } }
          : member,
      ),
    });

    const violation = firstOf(run(root), 'node-only-declaration');
    expect(violation, 'expected node-only-declaration').toBeDefined();
    expect(violation?.message).toContain('@starter/utils');
    expect(violation?.message).toContain('./process');
  });
});

describe('architecture: runtime edges follow the effective project configuration', () => {
  for (const verbatimModuleSyntax of [false, true]) {
    for (const extension of ['ts', 'svelte']) {
      test(`inline types retain runtime edges with verbatimModuleSyntax=${verbatimModuleSyntax} in ${extension}`, () => {
        const source = [
          "import { type killTree } from '@starter/utils/process';",
          "export { type Note } from '@starter/schemas/notes';",
          "import type { Note } from '@starter/schemas/notes';",
          "export type { Note as DTO } from '@starter/schemas/notes';",
        ].join('\n');
        const file = `src/lib/probe.${extension}`;
        const root = makeProject(
          withClientFiles({
            'inherited.json': JSON.stringify({ compilerOptions: { verbatimModuleSyntax } }),
            'tsconfig.json': JSON.stringify({ extends: './inherited.json' }),
            [file]: extension === 'svelte' ? `<script lang="ts">\n${source}\n</script>` : source,
          }),
        );
        const probe = buildModuleGraph(root).modules.get(`apps/frontend/client/${file}`);
        expect(probe).toBeDefined();
        if (probe === undefined) {
          throw new Error('Probe was not discovered');
        }
        expect(probe.errors).toEqual([]);
        expect(probe.edges.map((edge) => edge.typeOnly)).toEqual([
          !verbatimModuleSyntax,
          !verbatimModuleSyntax,
          true,
          true,
        ]);
        expect(runtimeTargets(probe).map((target) => target.via)).toEqual(
          verbatimModuleSyntax ? ['@starter/utils/process', '@starter/schemas/notes'] : [],
        );
        expect(probe.capabilities.has('node-runtime')).toBe(verbatimModuleSyntax);
      });
    }
  }

  test('reads and caches the root config after searching ancestors', () => {
    const root = makeProject({
      members: [],
      rootFiles: {
        'base.json': JSON.stringify({
          compilerOptions: {
            module: 'esnext',
            moduleResolution: 'bundler',
            verbatimModuleSyntax: true,
            paths: { '#root/*': ['./scripts/src/*'] },
          },
        }),
        'tsconfig.json': JSON.stringify({ extends: './base.json' }),
        'scripts/src/probe.ts': "import { type Value } from '#root/value';\n",
        'scripts/src/value.ts': 'export type Value = string;\n',
      },
    });
    const registry = new ProjectRegistry(root);
    const project = registry.projectFor('scripts/src/probe.ts');
    expect(project.configRelative).toBe('tsconfig.json');
    expect(project.options.verbatimModuleSyntax).toBe(true);
    expect(registry.projectFor('root.ts')).toBe(project);
    const graph = buildModuleGraph(root);
    expect(graph.configErrors).toEqual([]);
    expect(graph.modules.get('scripts/src/probe.ts')?.edges[0]).toMatchObject({
      typeOnly: false,
      resolution: { kind: 'first-party', file: 'scripts/src/value.ts' },
    });
  });

  test('uses the nearest config and reports a missing config', () => {
    const root = makeProject(
      withClientFiles({}, [], {
        'tsconfig.json': JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
      }),
    );
    const registry = new ProjectRegistry(root);
    expect(registry.projectFor('apps/frontend/client/src/lib/probe.ts').configRelative).toBe(
      'apps/frontend/client/tsconfig.json',
    );
    const unconfigured = makeProject({ members: [] });
    expect(
      new ProjectRegistry(unconfigured).projectFor('scripts/probe.ts').errors.join(' '),
    ).toContain('No tsconfig.json');
  });

  test('erased edges neither introduce nor inherit runtime capabilities', () => {
    const root = makeProject(
      withClientFiles({
        'src/lib/probe.ts': [
          "import type { Stats } from 'node:fs';",
          "export type { killTree } from '@starter/utils/process';",
          "import type { value } from './bridge.ts';",
        ].join('\n'),
        'src/lib/bridge.ts': "export { killTree as value } from '@starter/utils/process';\n",
      }),
    );
    const graph = buildModuleGraph(root);
    const probe = graph.modules.get('apps/frontend/client/src/lib/probe.ts');
    expect(probe?.edges).toHaveLength(3);
    expect(probe?.ownCapabilities.size).toBe(0);
    expect(probe?.capabilities.size).toBe(0);
    expect(
      graph.modules.get('apps/frontend/client/src/lib/bridge.ts')?.capabilities.has('node-runtime'),
    ).toBe(true);
    expect(
      forFile(run(root), 'runtime-capability', 'apps/frontend/client/src/lib/probe.ts'),
    ).toBeUndefined();
  });

  for (const specifier of ['node:fs', './bridge.ts']) {
    test(`capability diagnostics select the runtime edge for ${specifier}`, () => {
      const root = makeProject(
        withClientFiles({
          'src/lib/probe.ts': `import type { value } from '${specifier}';\nimport { value } from '${specifier}';\n`,
          'src/lib/bridge.ts': "export { readFileSync as value } from 'node:fs';\n",
        }),
      );
      const violation = forFile(
        run(root),
        'runtime-capability',
        'apps/frontend/client/src/lib/probe.ts',
      );
      expect(violation?.line).toBe(2);
      if (specifier === 'node:fs') {
        expect(violation?.message).toContain("probe.ts:2 imports 'node:fs'");
      } else {
        expect(violation?.message).toContain('bridge.ts');
      }
    });
  }
});

describe('architecture: exports must name existing files', () => {
  for (const target of ['./src/missing.ts', './src']) {
    test(`reports an unresolved first-party edge for ${target}`, () => {
      const root = makeProject(
        withClientFiles(
          {
            'src/lib/probe.ts': "import { value } from '@starter/fixture';\n",
          },
          [{ name: '@starter/fixture', dir: 'packages/shared/fixture', exports: { '.': target } }],
        ),
      );
      const probe = buildModuleGraph(root).modules.get('apps/frontend/client/src/lib/probe.ts');
      expect(probe?.edges[0]?.resolution).toMatchObject({
        kind: 'unresolved',
        unresolvedReason: 'first-party',
      });
      expect(
        forFile(run(root), 'unresolved-first-party', 'apps/frontend/client/src/lib/probe.ts'),
      ).toBeDefined();
    });
  }

  test('substitutes every wildcard, including those inside the target', () => {
    const root = makeProject(
      withClientFiles(
        {
          'src/lib/probe.ts': "import { value } from '@starter/fixture/notes';\n",
        },
        [
          {
            name: '@starter/fixture',
            dir: 'packages/shared/fixture',
            exports: { './*': './src/*/entry_*.ts' },
            files: { 'src/notes/entry_notes.ts': 'export const value = 1;\n' },
          },
        ],
      ),
    );
    expect(
      buildModuleGraph(root).modules.get('apps/frontend/client/src/lib/probe.ts')?.edges[0]
        ?.resolution,
    ).toMatchObject({
      kind: 'first-party',
      file: 'packages/shared/fixture/src/notes/entry_notes.ts',
    });
  });
});

describe('architecture: route adapters and harness locations', () => {
  for (const directory of ['', 'nested/']) {
    for (const name of ['+server.ts', '+page.server.ts', '+layout.server.ts']) {
      test(`classifies ${directory}${name} as a Worker route adapter`, () => {
        const file = `src/routes/${directory}${name}`;
        const root = makeProject(
          withClientFiles({
            [file]: "import { save } from '#lib/server/service.ts';\nexport const load = save;\n",
          }),
        );
        const graph = buildModuleGraph(root);
        expect(graph.modules.get(`apps/frontend/client/${file}`)).toMatchObject({
          plane: 'worker',
          role: 'route-server',
        });
        expect(
          run(root).filter((violation) => violation.file === `apps/frontend/client/${file}`),
        ).toEqual([]);
      });
    }
  }

  for (const name of ['setup', 'preflight', 'test_setup', 'global-setup']) {
    test(`keeps runtime checks on a shipped ${name}.ts`, () => {
      const file = `src/lib/${name === 'test_setup' ? 'feature/' : ''}${name}.ts`;
      const root = makeProject(withClientFiles({ [file]: nonLiteralImport() }));
      expect(buildModuleGraph(root).modules.get(`apps/frontend/client/${file}`)?.role).toBe(
        'module',
      );
      expect(
        forFile(run(root), 'nonliteral-dynamic-import', `apps/frontend/client/${file}`),
      ).toBeDefined();
    });
  }

  test('recognizes the actual test harness locations', () => {
    const files = [
      'apps/frontend/client/src/lib/test_setup.ts',
      'apps/frontend/client/src/browser_tests/setup.ts',
      'apps/e2e/global-setup.ts',
      'apps/e2e/preflight.ts',
    ];
    const root = makeProject(
      withClientFiles({}, [], Object.fromEntries(files.map((file) => [file, nonLiteralImport()]))),
    );
    const graph = buildModuleGraph(root);
    for (const file of files) {
      expect(graph.modules.get(file)?.role).toBe('test');
      expect(forFile(run(root), 'nonliteral-dynamic-import', file)).toBeUndefined();
    }
  });
});

describe('architecture: standalone guard selection', () => {
  test('defaults only when --root is absent', () => {
    expect(readSelection([]).root).toBe(REPO_ROOT);
    expect(readSelection(['--root', '/tmp/guard-fixture']).root).toBe('/tmp/guard-fixture');
  });

  test('profiling is opt-in, and it is not a filter', () => {
    // `--profile` changes what is printed and nothing else. A flag that quietly
    // changed which guards ran would be a way to make the lane faster by making it
    // weaker.
    expect(readSelection([]).profile).toBe(false);
    expect(readSelection(['--profile']).profile).toBe(true);
    expect(readSelection(['--profile', '--only', 'architecture'])).toMatchObject({
      only: 'architecture',
      profile: true,
    });
  });

  for (const args of [['--root'], ['--root', '--json'], ['--root', '-x']]) {
    test(`rejects ${args.join(' ')}`, () => {
      expect(() => readSelection(args)).toThrow('--root needs a directory');
    });
  }
});

// ── the real command, not only the function ──────────────────────────────────

describe('architecture: the guard command', () => {
  const cli = (
    root: string,
    args: readonly string[] = [],
  ): {
    code: number;
    stdout: string;
    stderr: string;
  } => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'guard', '--only', 'architecture', '--root', root, ...args],
      cwd: join(REPO_ROOT, 'scripts'),
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };

  test('exits nonzero and names the violation on a broken fixture', () => {
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/note_card.svelte': `<script lang="ts">
  import { notes } from '#lib/server/db.ts';
</script>
<article>{notes.table}</article>
`,
      }),
    );

    const result = cli(root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('FAIL');
    expect(result.stdout).toContain('plane-reachability');
    // The diagnostic has to carry the fix, not just the refusal.
    expect(result.stdout).toContain('Chain:');
  });

  test('exits zero on a conformant fixture', () => {
    const result = cli(makeProject(BASE));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ok');
  });

  test('reports machine-readable violations as JSON', () => {
    const root = makeProject(
      withClientFiles({
        'src/lib/features/notes/note_card.svelte': `<script lang="ts">
  import { killTree } from '@starter/utils/process';
</script>
<article>{killTree}</article>
`,
      }),
    );

    const result = cli(root, ['--json']);
    const parsed = JSON.parse(result.stdout) as {
      passed: boolean;
      guards: { violations: { rule: string; file: string; line: number; message: string }[] }[];
    };
    const violations = parsed.guards[0]?.violations ?? [];
    expect(parsed.passed).toBe(false);

    const capability = forFile(
      violations,
      'runtime-capability',
      'apps/frontend/client/src/lib/features/notes/note_card.svelte',
    );
    expect(capability, 'expected runtime-capability in the JSON output').toBeDefined();
    expect(capability?.line).toBe(2);
    expect(capability?.message).toContain('node-runtime');
  });

  test('prints per-guard elapsed time under --profile, for every guard it ran', () => {
    // The measurement the CI decision rests on has to be reproducible by whoever
    // reads the claim, from the command a developer already types. Asserting only
    // that some number appears would pass on a guard that timed one guard and
    // printed its own runtime as the rest.
    const result = cli(makeProject(BASE), ['--profile']);
    expect(result.code).toBe(0);

    const report = JSON.parse(
      Bun.spawnSync({
        cmd: [
          'bun',
          'run',
          'src/cli.ts',
          'guard',
          '--only',
          'architecture',
          '--root',
          makeProject(BASE),
          '--json',
        ],
        cwd: join(REPO_ROOT, 'scripts'),
      }).stdout.toString(),
    ) as { guards: { id: string }[]; timings: { id: string; ms: number }[] };

    expect(report.timings.map((timing) => timing.id)).toEqual(
      report.guards.map((guard) => guard.id),
    );
    for (const timing of report.timings) {
      expect(timing.ms).toBeGreaterThanOrEqual(0);
    }

    // The rendered table, not merely the presence of an id somewhere in the output:
    // every id in the JSON also appears in the `ok` lines above the table, so an
    // assertion of `toContain(id)` would pass against a `--profile` that printed no
    // timings at all.
    expect(result.stdout).toContain('elapsed, per guard:');
    const rows = [...result.stdout.matchAll(/^\s+(\d+) ms\s{2}(\S+)$/gm)].map((match) => ({
      ms: Number(match[1]),
      id: match[2],
    }));

    // One row per guard, plus the total, and the guard ids are the ones that ran.
    expect(rows.at(-1)?.id).toBe('total');
    expect(
      rows
        .slice(0, -1)
        .map((row) => row.id)
        .sort(),
    ).toEqual(report.guards.map((guard) => guard.id).sort());

    // The total is the sum of the rows beside it. Compared within one output only:
    // the JSON above comes from a second CLI invocation, so its numbers belong to a
    // different process and comparing across them fails on a loaded runner while
    // proving nothing.
    const totalMs = rows.at(-1)?.ms ?? -1;
    expect(rows.slice(0, -1).every((row) => totalMs >= row.ms)).toBe(true);
  });

  test('refuses --root without a directory rather than scanning the repository', () => {
    // A typo here would otherwise scan the real tree and exit 0, which reads as "the
    // fixture passed".
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'guard', '--only', 'architecture', '--root'],
      cwd: join(REPO_ROOT, 'scripts'),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('--root needs a directory');
  });

  test('refuses an unknown guard id instead of running all of them', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'guard', '--only', 'nope', '--root', makeProject(BASE)],
      cwd: join(REPO_ROOT, 'scripts'),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr.toString()).toContain('No guard named');
  });
});

// ── the repository itself ───────────────────────────────────────────────────

/**
 * How long a whole-repository guard pass is allowed.
 *
 * This is not a property of correctness; it is the cost of resolving every module
 * in the tree, and it grows with the repository. Bun's default per-test timeout is
 * five seconds, which this exceeds on any host slower than the one it was written
 * on — producing a red unit lane that says nothing about the architecture.
 *
 * Stated rather than left implicit for the same reason `BUILD_TIMEOUT_MS` is: a
 * bound nobody wrote down is a bound that fails on someone else's machine and gets
 * "fixed" by deleting the test.
 */
const WHOLE_REPO_TIMEOUT_MS = 60_000;

describe('architecture: the live repository', () => {
  test(
    'currently satisfies every rule',
    () => {
      // The fixture cases prove the rules; this proves they are met today. A failure here
      // is a real violation in the tree, not a broken test.
      expect(run(REPO_ROOT)).toEqual([]);
    },
    WHOLE_REPO_TIMEOUT_MS,
  );
});
