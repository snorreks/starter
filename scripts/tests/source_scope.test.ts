import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardNoLeftovers, guardSourceIsTracked } from '../src/guards/boundary.ts';
import { guardArchitecture } from '../src/guards/guard_architecture.ts';
import {
  buildModuleGraph,
  listRepositorySourceFiles,
  toRelative,
} from '../src/guards/module_graph.ts';
import { BASE_PROJECT, type Tree, writeProject } from './fixtures/architecture.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const fixture = (files: Tree): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-source-scope-'));
  roots.push(root);
  writeProject(root, {
    ...BASE_PROJECT,
    rootFiles: {
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
        },
      }),
      ...files,
    },
  });
  return root;
};

test('invalid and ignored scratch files cannot affect repository source checks', () => {
  const root = fixture({
    '.gitignore': '/tmp/\n',
    'tmp/experiment/broken.ts': 'this is deliberately not TypeScript; console.log("scratch");',
    'zed-format-probe.ts': 'this is deliberately not TypeScript; console.log("scratch");',
    '.pi/lib/marker.ts': 'export const marker = 1;\n',
  });
  expect(guardArchitecture(root).violations).toEqual([]);
  expect(guardNoLeftovers(root).violations).toEqual([]);
  expect(guardSourceIsTracked(root).violations).toEqual([]);
  const files = listRepositorySourceFiles(root).map((file) => toRelative(root, file));
  expect(files.length).toBeGreaterThan(0);
  expect(files).toContain('.pi/lib/marker.ts');
  expect(buildModuleGraph(root).modules.has('.pi/lib/marker.ts')).toBe(true);
  expect(files.some((file) => file.startsWith('tmp/') || file === 'zed-format-probe.ts')).toBe(
    false,
  );
});

test('a new application still needs explicit classification inside the governed roots', () => {
  const root = fixture({ 'apps/unheard-of/tool.ts': 'export const marker = 1;\n' });
  expect(
    guardArchitecture(root).violations.some(
      (violation) =>
        violation.rule === 'unclassified-source' && violation.file === 'apps/unheard-of/tool.ts',
    ),
  ).toBe(true);
});

test('tmp inside an application source tree is not mistaken for repository scratch', () => {
  const root = fixture({
    'apps/frontend/client/src/tmp/debug.ts': 'console.log("application source");\n',
  });
  expect(
    guardNoLeftovers(root).violations.some(
      (violation) => violation.file === 'apps/frontend/client/src/tmp/debug.ts',
    ),
  ).toBe(true);
});

test('ignored Pi helpers are still rejected as hidden first-party source', () => {
  const root = fixture({
    '.gitignore': '/.pi/lib/hidden.ts\n',
    '.pi/lib/hidden.ts': 'export const marker = 1;\n',
  });
  expect(
    guardSourceIsTracked(root).violations.some(
      (violation) => violation.file === '.pi/lib/hidden.ts',
    ),
  ).toBe(true);
});
