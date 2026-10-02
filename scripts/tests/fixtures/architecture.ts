// scripts/tests/fixtures/architecture.ts
//
// Disposable mini-projects for the architecture guard.
//
// They are data, not directories on disk, for one reason: a fixture that is a real
// directory inside `scripts/` would need its own `package.json`, and a nested
// `package.json` inside a workspace member is something `bun install` has opinions
// about. Writing the tree from a record at test time keeps the fixture disposable,
// keeps the guard's own discovery walk out of it, and keeps each case readable as the
// handful of files that matter.
//
// Every case is a *complete* enough project to be judged: a root manifest with
// `workspaces`, a `tsconfig.json` per member, and the package manifests whose
// `exports` maps the guard reads. A fixture that omitted them would test the guard's
// fallback path rather than its real one.

/** `path -> contents`. */
export type Tree = Record<string, string>;

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A workspace package: a name, a directory, and the rest merged over the default. */
export interface Member {
  readonly name: string;
  readonly dir: string;
  readonly exports?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly files?: Tree;
}

/** Root manifest plus the workspaces that follow from it. */
export interface Project {
  readonly members: readonly Member[];
  /** Extra files placed at the root, e.g. a deliberately broken tsconfig. */
  readonly rootFiles?: Tree;
}

const DEFAULT_MEMBER_FILES: Tree = {
  'src/index.ts': 'export const marker = 1;\n',
};

/**
 * The scaffold every case starts from.
 *
 * Mirrors the real repository's shape on purpose: one portable package, one server
 * package, one browser package, one app with a browser half and a Worker half, and the
 * tooling workspace. A fixture with a different shape would prove the guard works on a
 * project nobody has.
 */
export const BASE_PROJECT: Project = {
  members: [
    {
      name: '@starter/schemas',
      dir: 'packages/shared/schemas',
      exports: { '.': './src/index.ts', './notes': './src/notes/index.ts' },
      files: {
        'src/index.ts': "export * from './notes/index.ts';\n",
        // One type and one value, because the difference matters to the guard: a
        // type-only edge is erased and a value edge is reachability, and a fixture that
        // only exercised the first would make the runtime rules look untested.
        'src/notes/index.ts':
          'export type Note = { id: string; body: string };\nexport const noteMaxLength = 280;\n',
      },
    },
    {
      name: '@starter/utils',
      dir: 'packages/shared/utils',
      exports: { '.': './src/index.ts', './process': './src/lib/process/index.ts' },
      files: {
        'src/index.ts': 'export const createId = (): string => crypto.randomUUID();\n',
        'src/lib/process/index.ts': "export * from './process_tree.ts';\n",
        'src/lib/process/process_tree.ts':
          "import { execFileSync } from 'node:child_process';\nexport const killTree = (): number => execFileSync.length;\n",
      },
    },
    {
      name: '@starter/logger',
      dir: 'packages/shared/logger',
      exports: {
        '.': './src/index.ts',
        './browser': './src/lib/browser_logger.ts',
        './file': './src/lib/file_sink.ts',
      },
      dependencies: { '@starter/schemas': 'workspace:*' },
      files: {
        'src/index.ts': 'export const createLogger = (): string => "logger";\n',
        'src/lib/browser_logger.ts': 'export const BrowserLogger = null;\n',
        // Node-only, published only as `@starter/logger/file`. Mirrors the real
        // package, whose barrel deliberately omits this file.
        'src/lib/file_sink.ts':
          "import { appendFileSync } from 'node:fs';\nexport const NdjsonFileSink = appendFileSync;\n",
      },
    },
    {
      name: '@starter/database',
      dir: 'packages/backend/database',
      exports: { '.': './src/index.ts' },
      dependencies: { '@starter/schemas': 'workspace:*' },
      files: {
        'src/index.ts': 'export const notes = { table: true };\n',
      },
    },
    {
      name: '@starter/ui',
      dir: 'packages/frontend/ui',
      exports: {
        '.': { svelte: './src/index.ts', default: './src/index.ts' },
        './tokens.css': './src/tokens.css',
      },
      files: {
        'src/index.ts': 'export const Spinner = null;\n',
        'src/tokens.css': ':root {}\n',
      },
    },
    {
      name: '@starter/client',
      dir: 'apps/frontend/client',
      dependencies: {
        '@starter/database': 'workspace:*',
        '@starter/schemas': 'workspace:*',
        '@starter/ui': 'workspace:*',
        '@starter/utils': 'workspace:*',
      },
      files: {
        // `#lib` is what SvelteKit generates: a tsconfig in `node_modules` declaring a
        // paths entry, and carrying the module-resolution settings the generated config
        // really carries. Reproduced rather than approximated, because the guard reads
        // them: with `moduleResolution` left unset the fixture resolved through a
        // different algorithm than the real application uses, which is exactly the kind
        // of divergence that makes a fixture prove nothing.
        'node_modules/$app/tsconfig.json': JSON.stringify(
          {
            compilerOptions: {
              paths: { '#lib': ['../../src/lib'], '#lib/*': ['../../src/lib/*'] },
              module: 'esnext',
              moduleResolution: 'bundler',
              allowImportingTsExtensions: true,
              strict: true,
            },
          },
          null,
          2,
        ),
        // The framework's own ambient declarations. The guard reads these to learn
        // which specifiers SvelteKit provides, and then refuses to resolve them itself.
        // A fixture without them would leave the framework prefix unverifiable, which
        // is a property of the fixture rather than of the code under test.
        'node_modules/@sveltejs/kit/types/index.d.ts':
          'declare module "$app/server" {\n  export const json: (body: unknown) => Response;\n}\n' +
          'declare module "$app/navigation" {\n  export const goto: (url: string) => Promise<void>;\n}\n',
        'tsconfig.json': JSON.stringify(
          { extends: '$app/tsconfig', compilerOptions: { strict: true } },
          null,
          2,
        ),
        'src/lib/server/db.ts':
          "import { notes } from '@starter/database';\nexport const list = () => notes;\n",
        'src/lib/server/service.ts':
          "import { notes } from '@starter/database';\nimport { createId } from '@starter/utils';\nexport const save = () => [notes, createId];\n",
        'src/lib/features/notes/notes_view_model.svelte.ts':
          "import type { Note } from '@starter/schemas/notes';\nimport { notesService } from './notes_service.svelte.ts';\nexport class NotesViewModel {\n  notes: Note[] = [];\n  service = notesService;\n}\n",
        'src/lib/features/notes/notes_service.svelte.ts':
          "import type { Note } from '@starter/schemas/notes';\nexport type NotesService = { list: () => Note[] };\nexport const notesService: NotesService = { list: () => [] };\n",
        // A value import alongside the type, mirroring the real `note_form.svelte`: this
        // is the edge that makes the barrel test below meaningful, because a type-only
        // edge is erased and cannot carry a leak into a bundle.
        'src/lib/features/notes/note_card.svelte':
          "<script lang=\"ts\">\n  import { noteMaxLength, type Note } from '@starter/schemas/notes';\n  import type { NotesViewModel } from './notes_view_model.svelte.ts';\n  let { note, model }: { note: Note; model: NotesViewModel } = $props();\n</script>\n\n<article data-max={noteMaxLength}>{note.body}</article>\n",
        'src/routes/api/notes/+server.ts':
          "import { json } from '$app/server';\nimport { save } from '#lib/server/service.ts';\nexport const POST = () => json({ ok: true, save });\n",
        'src/routes/notes/+page.svelte':
          "<script lang=\"ts\">\n  import NoteCard from '#lib/features/notes/note_card.svelte';\n  import type { NotesViewModel } from '#lib/features/notes/notes_view_model.svelte.ts';\n  let { model }: { model: NotesViewModel } = $props();\n</script>\n\n<NoteCard note={{ id: '1', body: 'x' }} {model} />\n",
        'src/app.d.ts':
          "import type { Container } from '#lib/server/container.ts';\ndeclare global {\n  namespace App {\n    interface Locals {\n      container: Container;\n    }\n  }\n}\nexport {};\n",
        'src/lib/server/container.ts': 'export type Container = { db: unknown };\n',
      },
    },
    {
      name: '@starter/scripts',
      dir: 'scripts',
      dependencies: { '@starter/utils': 'workspace:*' },
      files: {
        'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
        'src/cli.ts':
          "import { killTree } from '@starter/utils/process';\nexport const main = (): void => killTree;\n",
      },
    },
  ],
};

/**
 * Materialise a project into `root`.
 *
 * Merges case-specific files over the scaffold, so a case states only what it is
 * about. A case that needs to *remove* a scaffold file writes it as an empty string
 * and the caller gets nothing on disk — used below by the "discovery finds nothing"
 * case, which is the only way to prove a zero-module report is not a pass.
 */
export const writeProject = (root: string, project: Project): void => {
  const workspaces: string[] = [];

  for (const member of project.members) {
    workspaces.push(`${member.dir}`);

    const manifest = {
      name: member.name,
      version: '0.1.0',
      private: true,
      type: 'module',
      ...(member.exports === undefined ? {} : { exports: member.exports }),
      main: './src/index.ts',
      ...(member.dependencies === undefined ? {} : { dependencies: member.dependencies }),
      scripts: {},
    };

    write(root, `${member.dir}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    write(
      root,
      `${member.dir}/tsconfig.json`,
      member.files?.['tsconfig.json'] ??
        `${JSON.stringify({ compilerOptions: { strict: true } }, null, 2)}\n`,
    );

    for (const [path, contents] of Object.entries(member.files ?? {})) {
      if (path === 'tsconfig.json' || contents.length === 0) {
        continue;
      }
      write(root, `${member.dir}/${path}`, contents);
    }

    // Any member that published nothing and shipped no file still needs a source file,
    // or the guard would report it as absent rather than as a member.
    if (member.files === undefined) {
      for (const [path, contents] of Object.entries(DEFAULT_MEMBER_FILES)) {
        write(root, `${member.dir}/${path}`, contents);
      }
    }
  }

  write(
    root,
    'package.json',
    `${JSON.stringify(
      { name: 'fixture', version: '0.1.0', private: true, type: 'module', workspaces },
      null,
      2,
    )}\n`,
  );

  for (const [path, contents] of Object.entries(project.rootFiles ?? {})) {
    if (contents.length > 0) {
      write(root, path, contents);
    }
  }
};

/** Write one file, creating its parent directories. */
const write = (root: string, relativePath: string, contents: string): void => {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
};
