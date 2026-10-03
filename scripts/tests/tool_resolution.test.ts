// scripts/tests/tool_resolution.test.ts
//
// Where a pinned binary is looked for, and why the Windows answer differs.
//
// This is the shared resolver every tool in the tooling workspace goes through —
// wrangler, drizzle-kit, vite, playwright and the Tauri CLI. It has a platform
// branch, and the branch had never been exercised: the Windows desktop job
// reported `MISS tauri cli — not installed` on a runner where `bun install` had
// installed it thirty seconds earlier, because a `.bin` entry on Windows is named
// `<tool>.cmd` and only the extensionless name was looked for.
//
// Fixtures, not the live tree: the point is to make the Windows and Linux answers
// differ on purpose.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceBin } from '../src/shared/tools.ts';

/** A tree with `node_modules/.bin` entries, written the way a package manager would. */
const fixture = (entries: Readonly<Record<string, readonly string[]>>): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-tools-'));
  for (const [packageDir, tools] of Object.entries(entries)) {
    for (const tool of tools) {
      const dir = join(root, packageDir, 'node_modules', '.bin');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, tool), '#!/bin/sh\n');
    }
  }
  return root;
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const tree = (entries: Readonly<Record<string, readonly string[]>>): string => {
  const root = fixture(entries);
  roots.push(root);
  return root;
};

describe('resolveWorkspaceBin', () => {
  test('finds the extensionless shim a Unix package manager writes', () => {
    const root = tree({ 'apps/frontend/native': ['tauri'] });

    expect(resolveWorkspaceBin('tauri', ['apps/frontend/native'], root)).toBe(
      join(root, 'apps/frontend/native', 'node_modules', '.bin', 'tauri'),
    );
  });

  test('finds the .cmd shim a Windows package manager writes', () => {
    // The failure this test exists for: on Windows there is no extensionless
    // entry, so a resolver that looked only for `tauri` reports a pinned,
    // installed dependency as missing.
    const root = tree({ 'apps/frontend/native': ['tauri.cmd'] });

    expect(resolveWorkspaceBin('tauri', ['apps/frontend/native'], root)).toBe(
      join(root, 'apps/frontend/native', 'node_modules', '.bin', 'tauri.cmd'),
    );
  });

  test('finds a native .exe', () => {
    const root = tree({ 'apps/frontend/native': ['tauri.exe'] });

    expect(resolveWorkspaceBin('tauri', ['apps/frontend/native'], root)).toBe(
      join(root, 'apps/frontend/native', 'node_modules', '.bin', 'tauri.exe'),
    );
  });

  test('the declaring package wins over the root, on any suffix', () => {
    // More specific first, deliberately: a tool declared by the project that needs
    // it must not be shadowed by a different copy at the workspace root.
    const root = tree({
      'apps/frontend/native': ['tauri.cmd'],
      '': ['tauri'],
    });

    expect(resolveWorkspaceBin('tauri', ['apps/frontend/native'], root)).toContain(
      join('apps', 'frontend', 'native'),
    );
  });

  test('falls back to the root .bin directory', () => {
    const root = tree({ '': ['wrangler'] });

    expect(resolveWorkspaceBin('wrangler', ['apps/frontend/client'], root)).toBe(
      join(root, 'node_modules', '.bin', 'wrangler'),
    );
  });

  test('reports null when no declaring package has it', () => {
    const root = tree({ 'apps/frontend/native': ['tauri'] });

    expect(resolveWorkspaceBin('wrangler', ['apps/frontend/client'], root)).toBeNull();
  });

  test('reports null for an empty tree rather than a path that does not exist', () => {
    // `existsSync` is the check, so a missing directory is a miss and not a path
    // the caller would hand to a spawn that then fails with ENOENT.
    const root = tree({});

    expect(resolveWorkspaceBin('tauri', ['apps/frontend/native'], root)).toBeNull();
  });
});
