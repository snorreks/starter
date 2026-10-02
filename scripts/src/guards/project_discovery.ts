// scripts/src/guards/project_discovery.ts
//
// Which directories in this repository are projects.
//
// A README obligation is only as good as the definition of "project" behind it. The
// obvious version of that definition is a list, and a list has a specific failure: it
// was correct the day it was written, and the day a project was added under a new
// root it was wrong in a way nothing reported. Five directories were named, and
// `packages/frontend/features` — a package the graph classifies and the task graph
// builds — owed no documentation because nobody remembered to add it to a table.
//
// So this walks the repository's own declarations instead:
//
//   * **Bun workspaces** from the root `package.json` `workspaces` globs, resolved by
//     the same `readWorkspacePackages` the module graph uses. One definition of "a
//     workspace package", so a directory cannot be a package to the graph and a
//     stranger to the documentation guard.
//   * **Moon projects** from `.moon/workspace.yml`. A Moon project can exist without
//     being a Bun package — a Rust-backed project is the obvious one — and its tasks
//     are run by the same `bun run` a reader follows a link for.
//   * **First-party `Cargo.toml` files**, found by walking for them. A crate is a
//     project whatever language it is written in, and this is the only discovery
//     source that can see one.
//   * **The repository root**, which is a project: it is the thing somebody clones.
//
// Nothing here decides what a project *is allowed to import* or *must contain*. That
// is `policy.ts`, and this file only answers "which directories exist as projects", so
// that a rule can be written about all of them rather than about a list.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { IGNORED_DIRS, readWorkspacePackages } from './module_graph.ts';
import { isGeneratedPath } from './policy.ts';

/**
 * Where a project was discovered from.
 *
 * Kept on the project rather than folded into a single `kind`, because a directory
 * that two declarations agree about is a stronger obligation than one only a glob
 * found — and because the diagnostic has to be able to say which declaration named it
 * when the answer is "this should not have been here".
 */
export type ProjectSource = 'repository-root' | 'bun-workspace' | 'moon-project' | 'cargo-crate';

export interface DiscoveredProject {
  /** Repo-relative directory. `.` for the repository root. */
  readonly dir: string;
  /** Best available identity: package name, Moon project id, or directory name. */
  readonly name: string;
  /** Every declaration that found it, sorted and deduplicated. */
  readonly sources: readonly ProjectSource[];
}

/** The name a directory has when no manifest claims one. */
const directoryName = (dir: string): string => (dir === '.' ? '.' : (dir.split('/').pop() ?? dir));

/** `.moon/workspace.yml`'s `projects:` block, as directories. */
const moonProjectDirs = (root: string): { id: string; dir: string }[] => {
  const file = join(root, '.moon/workspace.yml');
  if (!existsSync(file)) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = parse(readTextSafe(file));
  } catch {
    // A workspace file that does not parse is reported by `bun run moon`, and a
    // project it failed to declare is reported as absent by that same command.
    // Inventing a partial list here would be worse than returning nothing, so the
    // caller sees an empty source and can say so.
    return [];
  }

  const projects = (parsed as { projects?: unknown } | null)?.projects;
  if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) {
    return [];
  }

  const found: { id: string; dir: string }[] = [];
  for (const [id, value] of Object.entries(projects as Record<string, unknown>)) {
    // Moon 2 writes either a single glob or a `{ globs: [...] }` block. An explicit
    // list rather than a nested ternary, because which shape was read is the whole
    // question here and a ternary makes the reader compare two conditions.
    const block = value as { globs?: unknown } | null;
    const patterns: unknown[] = [];
    if (typeof value === 'string') {
      patterns.push(value);
    } else if (Array.isArray(block?.globs)) {
      patterns.push(...block.globs);
    }
    for (const pattern of patterns) {
      if (typeof pattern === 'string') {
        found.push({ id, dir: pattern.replace(/\/\*$/, '') });
      }
    }
  }
  return found;
};

/** Reading a file that is not there is an answer, not a crash. */
const readTextSafe = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/**
 * Every directory holding a `Cargo.toml`, skipping generated and vendored trees.
 *
 * The walk is the same one the module graph uses, minus the extension filter: a crate
 * has no `.ts` file to find, and the only question here is whether the manifest is
 * there. Skipping `GENERATED_TREES` is what keeps the `Cargo.toml` files Cargo itself
 * writes under `src-tauri/target` from being reported as crates that owe a README.
 * which Cargo itself writes — from being reported as a crate that owes a README.
 */
const cargoCrateDirs = (root: string): string[] => {
  const found: string[] = [];

  const walk = (directory: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry) || entry === '.git') {
        continue;
      }
      const relativePath = prefix === '' ? entry : `${prefix}/${entry}`;
      if (isGeneratedPath(relativePath)) {
        continue;
      }
      const full = join(directory, entry);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        walk(full, relativePath);
        continue;
      }
      if (entry === 'Cargo.toml') {
        found.push(prefix);
      }
    }
  };

  walk(root, '');
  return found;
};

/**
 * Every project in `root`, deduplicated by directory and sorted.
 *
 * A directory two declarations agree about appears once, carrying both sources. The
 * repository root is always present and always first: it is the project everybody
 * starts from, and a guard that could forget it would be a guard with a hole at the
 * top of the tree.
 */
export const discoverProjects = (root: string): DiscoveredProject[] => {
  const byDir = new Map<string, { name: string; sources: Set<ProjectSource> }>();

  const add = (dir: string, name: string, source: ProjectSource): void => {
    const normalized = dir.replace(/^\.\//, '').replace(/\/+$/, '') || '.';
    const existing = byDir.get(normalized);
    if (existing === undefined) {
      byDir.set(normalized, { name, sources: new Set([source]) });
      return;
    }
    existing.sources.add(source);
    // A declared name beats a directory name: `@starter/ui` says more than `ui`.
    if (existing.name === directoryName(normalized) && name !== directoryName(normalized)) {
      existing.name = name;
    }
  };

  // The root's declared name, when it has one. `readWorkspacePackages` only reports
  // members, so the root is read here rather than through a special case in the
  // manifest reader.
  let rootName = directoryName('.');
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    if (typeof manifest.name === 'string') {
      rootName = manifest.name;
    }
  } catch {
    // A root without a readable manifest is still a project; the directory name is
    // the honest answer for it.
  }
  add('.', rootName, 'repository-root');

  for (const entry of readWorkspacePackages(root).values()) {
    add(entry.dir, entry.name, 'bun-workspace');
  }
  for (const { id, dir } of moonProjectDirs(root)) {
    add(dir, id, 'moon-project');
  }
  for (const dir of cargoCrateDirs(root)) {
    add(dir, directoryName(dir), 'cargo-crate');
  }

  return [...byDir.entries()]
    .map(([dir, entry]) => ({ dir, name: entry.name, sources: [...entry.sources].sort() }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
};

/** How each discovery source is named in a diagnostic. */
const SOURCE_NAMES: Record<ProjectSource, string> = {
  'repository-root': 'the repository root',
  'bun-workspace': 'the root package.json workspaces globs',
  'moon-project': '.moon/workspace.yml',
  'cargo-crate': 'a first-party Cargo.toml',
};

export const describeSources = (sources: readonly ProjectSource[]): string =>
  sources.map((source) => SOURCE_NAMES[source]).join(' and ');
