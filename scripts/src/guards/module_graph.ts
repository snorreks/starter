// scripts/src/guards/module_graph.ts
//
// The resolved module graph.
//
// The previous guard read import statements out of source text with a regular
// expression and matched the resulting specifiers against a list of package names.
// That could not see a re-export, a relative path that climbs out of its own layer,
// an alias that routes around a boundary, or a specifier that only a resolver knows
// how to interpret — and each of those is a way to cross a boundary quietly, which
// is the only thing the boundary is for.
//
// So this module resolves. A file is parsed by the parser that owns its language
// (TypeScript for `.ts`, Svelte for `.svelte`, whose script blocks are then handed
// back to TypeScript), every specifier it contains is resolved through the owning
// project's own module resolution, and the result is a graph of canonical file
// identities. `guard_architecture.ts` then asks `policy.ts` whether the edges in that
// graph are allowed. Nothing in this file decides what is legal.
//
// Three properties are load-bearing:
//
//   * **Resolution is the project's own.** Compiler options come from the nearest
//     `tsconfig.json` via `ts.getParsedCommandLineOfConfigFile`, so `paths`,
//     `baseUrl`, `rootDirs` and `moduleResolution` are the configured ones. A
//     workspace package's subpaths come from its `exports` map, which makes that
//     map the authority rather than a TypeScript alias that can route around it.
//   * **Failure is reported, never swallowed.** A file that will not parse, a
//     specifier that will not resolve, a non-literal `import()`: each produces a
//     violation. A guard that cannot read its input and prints `ok` is the one
//     outcome worse than a false violation.
//   * **Framework metadata is read, not assumed.** The specifiers SvelteKit
//     provides (`$app/*`, `$env/*`) are discovered from the ambient module
//     declarations in the installed framework, and a prefix the policy trusts but
//     the framework does not provide is itself a violation.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path';
import { parse as parseSvelte } from 'svelte/compiler';
import ts from 'typescript';
import {
  CAPABILITY_RULES,
  type Capability,
  GENERATED_OUTPUT_DIRECTORY_NAMES,
  isGeneratedPath,
  type Plane,
  PROJECT_MANIFEST_NAMES,
  planeOf,
  type Role,
  roleOf,
  SOURCE_ROOTS,
} from './policy.ts';

/**
 * Skip these by name: vendored, generated, or not source.
 *
 * Only names that cannot plausibly be a source directory a person maintains. The
 * build-output names — `build`, `dist`, `target`, `coverage`, `test-results`,
 * `playwright-report` — are deliberately **not** here. They are ordinary words, and a
 * walk that skipped them by name would drop `packages/thing/src/build/` without a
 * word; they are recognised instead by `isGeneratedOutputDirectory`, which confirms a
 * candidate against the manifest beside it. Keeping both lists is what made the same
 * directory name-only in one walker and manifest-confirmed in another.
 */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.moon',
  '.svelte-kit',
  '.wrangler',
  '.direnv',
]);

/**
 * Directories excluded from the graph entirely, with the reason.
 *
 * `scripts/tests/fixtures` holds the trees the guard's own tests build. They are
 * inputs to tests, not part of the application: the tests prove the guard's
 * behaviour on them, and a fixture deliberately containing an illegal edge would
 * otherwise make `bun run guard` fail for the repository rather than for the tree
 * under test.
 */
export const GRAPH_EXCLUDED_DIRS: readonly string[] = ['scripts/tests/fixtures'];

/**
 * Source extensions the graph and the textual guards both treat as code.
 *
 * Deliberately no `.rs`. Rust is not a dialect of TypeScript, and a guard that parsed
 * it would be a second and strictly weaker answer to a question `cargo check` and
 * `cargo test` answer properly. A native crate is discovered as a *project* — it owes
 * a README — and its source is validated by its own lane.
 */
export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.svelte'];

/**
 * Every source file beneath `root`, or `[]` when there is no such directory.
 *
 * The absent case is not hypothetical: the fixtures that prove the other guards
 * work build throwaway trees that do not contain every directory they scan. A walk
 * that threw `ENOENT` would fail those tests on a missing directory rather than on
 * the rule they exist to check.
 */
export const listSourceFiles = (root: string): string[] => {
  const found: string[] = [];

  const walk = (directory: string, relativePrefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) {
        continue;
      }
      const relativePath = relativePrefix === '' ? entry : `${relativePrefix}/${entry}`;
      if (GRAPH_EXCLUDED_DIRS.includes(relativePath)) {
        continue;
      }
      // The same generated trees the project discovery walk skips, from the one
      // policy in `policy.ts`. A directory a generator writes is not a hole in the
      // policy: reporting its `.ts` files as unclassified would make `bun run guard`
      // fail after a build, which is the same class of failure as demanding a
      // committed output directory.
      if (isGeneratedPath(relativePath)) {
        continue;
      }
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        // Confirmed against the manifest beside it, so a source directory named
        // `build` or `target` is still walked.
        if (isGeneratedOutputDirectory(full)) {
          continue;
        }
        walk(full, relativePath);
        continue;
      }
      if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
        found.push(full);
      }
    }
  };

  walk(root, '');
  return found;
};

/** Repository source comes only from governed roots, never arbitrary scratch files. */
export const listRepositorySourceFiles = (root: string): string[] =>
  SOURCE_ROOTS.flatMap((directory) => listSourceFiles(join(root, directory))).filter((file) => {
    const path = toRelative(root, file);
    return !GRAPH_EXCLUDED_DIRS.some((directory) => path.startsWith(`${directory}/`));
  });

/** Repo-relative POSIX path. The canonical identity of a first-party module. */
export const toRelative = (root: string, file: string): string =>
  relative(root, file).split('\\').join('/');

/**
 * Is `absoluteDirectory` build output for the project beside it?
 *
 * `target`, `build`, `dist` and the rest are ordinary directory names, and a walker
 * that skipped them by name would drop a package's own `src/build/` from the graph
 * *and* from project discovery without reporting anything — the silent failure the
 * generation policy exists to prevent, reintroduced through a second table.
 *
 * So the name is the candidate and the manifest is the confirmation: output belongs to
 * a project, and the project has a `package.json` or a `Cargo.toml` sitting next to
 * the output. One `existsSync` per candidate, and it is the only I/O either walker
 * does beyond the walk itself.
 */
export const isGeneratedOutputDirectory = (absoluteDirectory: string): boolean => {
  if (!GENERATED_OUTPUT_DIRECTORY_NAMES.includes(basename(absoluteDirectory))) {
    return false;
  }
  const parent = dirname(absoluteDirectory);
  return PROJECT_MANIFEST_NAMES.some((manifest) => existsSync(join(parent, manifest)));
};

/** How a specifier was resolved. Each kind answers a different question. */
export type ResolutionKind =
  /** A file in this repository. The canonical identity is its relative path. */
  | 'first-party'
  /** A package or scheme outside this repository. */
  | 'external'
  /** A framework-provided module with no file of its own. */
  | 'framework'
  /** A framework-generated declaration file (SvelteKit's `./$types`). */
  | 'generated'
  /** A stylesheet or other non-module asset. Carries no code. */
  | 'asset'
  /** Nothing. `unresolvedReason` says whether the caller or the repository is at fault. */
  | 'unresolved';

export type UnresolvedReason =
  /** Relative, aliased or `@starter/*` — a dependency of this repository. */
  | 'first-party'
  /** A third-party specifier the project's own resolution could not find. */
  | 'third-party'
  /** `import(variable)`. Not statically knowable, and not claimed to be. */
  | 'nonliteral';

export interface Resolution {
  readonly kind: ResolutionKind;
  /** Repo-relative path, for `first-party` and `asset`. */
  readonly file?: string;
  /** The specifier as written. Empty for a non-literal dynamic import. */
  readonly specifier: string;
  readonly unresolvedReason?: UnresolvedReason;
  /** Capabilities the specifier itself confers. Transitive ones come from the target. */
  readonly capabilities: readonly Capability[];
}

export type EdgeKind = 'static' | 'dynamic';

export interface Edge {
  readonly specifier: string;
  readonly line: number;
  /**
   * True when TypeScript erases the declaration entirely: `import type`,
   * `export type`, or a clause whose every named binding is individually `type`.
   *
   * Kept separate from `kind` because the two answer different questions. `kind`
   * says how the module is loaded; `typeOnly` says whether a declaration survives
   * compilation at all. `policy.ts` uses both, and neither substitutes for the other.
   */
  readonly typeOnly: boolean;
  readonly kind: EdgeKind;
  readonly resolution: Resolution;
}

export interface ModuleNode {
  /** Repo-relative POSIX path. */
  readonly file: string;
  readonly plane: Plane;
  readonly role: Role;
  readonly edges: readonly Edge[];
  /** Syntax and configuration errors. Empty when the file was read and parsed. */
  readonly errors: readonly string[];
  /** True when the file references the `Bun` global. */
  readonly usesBunGlobal: boolean;
  /**
   * Capabilities this module's own specifiers confer, before inheritance.
   *
   * Kept apart from `capabilities` because a diagnostic has to say where a
   * capability came from. "This component needs Node" is a fact; "it needs Node
   * because of the import on line 9" is a fix.
   */
  readonly ownCapabilities: ReadonlySet<Capability>;
  /** Capabilities this module needs, including the ones it inherits transitively. */
  readonly capabilities: Set<Capability>;
}

export interface WorkspacePackage {
  readonly name: string;
  /** Repo-relative directory. */
  readonly dir: string;
  /** Declared dependency names, across every dependency field. */
  readonly declared: ReadonlySet<string>;
  /**
   * Declared `exports` keys, without the leading `./`. `.` is included.
   *
   * Used to tell a declared subpath from a deep import: `@starter/schemas/notes`
   * is an entry in the map, `@starter/schemas/src/notes/index.ts` is a path into a
   * package that the map never agreed to publish.
   */
  readonly exportKeys: ReadonlySet<string>;
}

export interface ModuleGraph {
  readonly root: string;
  readonly modules: ReadonlyMap<string, ModuleNode>;
  readonly packages: ReadonlyMap<string, WorkspacePackage>;
  /** Source files no placement row covers. A hole in the policy, not a pass. */
  readonly unclassified: readonly string[];
  /**
   * Projects whose tsconfig could not be read, once each.
   *
   * Reported once per config rather than once per module because that is what it is:
   * one unreadable file affects every module in it, and a violation per module would
   * bury the one line that names the real problem.
   */
  readonly configErrors: readonly { readonly file: string; readonly errors: readonly string[] }[];
  /** `declare module` names the installed frameworks provide. */
  readonly frameworkModules: ReadonlySet<string>;
}

// ── parsing ─────────────────────────────────────────────────────────────────

/**
 * Whether an import/export declaration contributes a runtime dependency.
 *
 * Clause-level `import type` and `export type` are erased. With
 * `verbatimModuleSyntax`, inline type bindings leave an empty import/export that
 * still loads the module. Otherwise, all-type binding lists are erased.
 */
const contributesRuntimeDependency = (
  node: ts.ImportDeclaration | ts.ExportDeclaration,
  verbatimModuleSyntax: boolean,
): boolean => {
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) {
      return false;
    }
    const clause = node.exportClause;
    if (clause && ts.isNamedExports(clause)) {
      return verbatimModuleSyntax || clause.elements.some((element) => !element.isTypeOnly);
    }
    return true;
  }

  const clause = node.importClause;
  if (clause === undefined) {
    return true;
  }
  if (clause.isTypeOnly) {
    return false;
  }
  if (clause.name !== undefined) {
    return true;
  }
  const bindings = clause.namedBindings;
  if (bindings === undefined) {
    return true;
  }
  if (ts.isNamespaceImport(bindings)) {
    return true;
  }
  return verbatimModuleSyntax || bindings.elements.some((element) => !element.isTypeOnly);
};

interface RawImport {
  readonly specifier: string | undefined;
  readonly line: number;
  readonly typeOnly: boolean;
  readonly kind: EdgeKind;
}

const collectFromSourceFile = (
  sourceFile: ts.SourceFile,
  lineOffset: number,
  verbatimModuleSyntax: boolean,
): RawImport[] => {
  const imports: RawImport[] = [];

  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 + lineOffset;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteralLike(specifier)) {
        imports.push({
          specifier: specifier.text,
          line: lineOf(node),
          typeOnly: !contributesRuntimeDependency(node, verbatimModuleSyntax),
          kind: 'static',
        });
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const [argument] = node.arguments;
      imports.push({
        // `undefined` is the honest answer for `import(variable)`, and it is what
        // keeps "checked" and "not checkable" distinct all the way to the report.
        specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : undefined,
        line: lineOf(node),
        typeOnly: false,
        kind: 'dynamic',
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return imports;
};

/**
 * A reference to the `Bun` global.
 *
 * Not a string search: the parser has already said this is an identifier in
 * expression position. `foo.Bun`, `obj = { Bun: 1 }` and a shadowing local binding
 * are excluded — the first is a property, the second a key, the third not the global.
 */
const referencesBunGlobal = (sourceFile: ts.SourceFile): boolean => {
  let shadowed = false;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'Bun') {
        shadowed = true;
      }
    }
  }
  if (shadowed) {
    return false;
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isIdentifier(node) && node.text === 'Bun') {
      const parent: ts.Node | undefined = node.parent;
      const isPropertyName =
        parent !== undefined &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isBindingElement(parent) && parent.propertyName === node));
      if (!isPropertyName) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

/**
 * Parse diagnostics, through the one public API that reports them.
 *
 * `SourceFile.parseDiagnostics` is what most tooling reaches for and it works, but
 * TypeScript 6 does not declare it, so using it means a cast. `transpileModule` with
 * `reportDiagnostics` is documented and needs no cast.
 *
 * Two inputs make it the wrong tool, and both are handled rather than ignored:
 *
 *   - A `.d.ts` has no output to generate, so `transpileModule` throws
 *     `Debug Failure. Output generation failed`. A declaration file is role `ambient`
 *     and contributes no edges, so there is nothing to check and nothing is lost.
 *   - A TypeScript internal failure must become a reported violation, not a crash. A
 *     guard that throws reports nothing at all, which is the one outcome worse than a
 *     false violation.
 */
const parseDiagnosticsOf = (text: string, fileName: string): string[] => {
  if (fileName.endsWith('.d.ts')) {
    return [];
  }
  try {
    const output = ts.transpileModule(text, {
      reportDiagnostics: true,
      fileName,
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
        verbatimModuleSyntax: true,
      },
    });
    return (output.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
  } catch (error) {
    return [
      `TypeScript could not report diagnostics: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
};

interface ParsedModule {
  readonly imports: readonly RawImport[];
  readonly errors: readonly string[];
  readonly usesBunGlobal: boolean;
}

/**
 * `.svelte`: the Svelte parser locates the script blocks, TypeScript reads them.
 *
 * SvelteKit 3 puts `lang="ts"` TypeScript straight into the Svelte AST, so the two
 * parsers overlap. Splitting the work this way uses each for the question it answers
 * exactly: Svelte knows where a script block sits inside markup, and TypeScript
 * knows what an import declaration is. Svelte's `content.start`/`content.end` are
 * offsets into the block, so the script text is sliced out rather than guessed at,
 * and the line offset comes from the block's own position — which is why a violation
 * in a component is reported at the component's line 7 and not at line 1.
 */
const parseSvelteModule = (
  text: string,
  file: string,
  verbatimModuleSyntax: boolean,
): ParsedModule => {
  let ast: ReturnType<typeof parseSvelte>;
  try {
    ast = parseSvelte(text, { filename: file });
  } catch (error) {
    return {
      imports: [],
      errors: [error instanceof Error ? error.message : `Svelte parse failed: ${String(error)}`],
      usesBunGlobal: false,
    };
  }

  const imports: RawImport[] = [];
  const errors: string[] = [];
  let usesBunGlobal = false;

  for (const block of [ast.module, ast.instance]) {
    if (block === null || block === undefined) {
      continue;
    }
    const attributes = (block.attributes ?? []) as { name: string; value: unknown }[];
    const lang = attributes.find((attribute) => attribute.name === 'lang');
    const langValue = (lang?.value as { data?: string }[] | undefined)?.[0]?.data;
    const isTypeScript = lang === undefined || String(langValue ?? 'ts').includes('ts');

    // `content.start`/`content.end` are absolute offsets into the file, not into the
    // block. Verified against a component with a leading HTML comment, where the block
    // begins at `<script` and the content begins after the opening tag — treating them
    // as relative silently slices the wrong bytes and reports every component as
    // unparseable.
    const scriptText = text.slice(block.content.start, block.content.end);
    const sourceFile = ts.createSourceFile(
      `${file}.${block.type}.ts`,
      scriptText,
      ts.ScriptTarget.Latest,
      true,
      isTypeScript ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    const lineOffset = text.slice(0, block.content.start).split('\n').length - 1;

    errors.push(...parseDiagnosticsOf(scriptText, `${file}.${block.type}.ts`));
    imports.push(...collectFromSourceFile(sourceFile, lineOffset, verbatimModuleSyntax));
    usesBunGlobal = usesBunGlobal || referencesBunGlobal(sourceFile);
  }

  return { imports, errors, usesBunGlobal };
};

const parseTypeScriptModule = (
  text: string,
  file: string,
  verbatimModuleSyntax: boolean,
): ParsedModule => {
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);

  return {
    imports: collectFromSourceFile(sourceFile, 0, verbatimModuleSyntax),
    errors: parseDiagnosticsOf(text, file),
    usesBunGlobal: referencesBunGlobal(sourceFile),
  };
};

export const parseModule = (
  file: string,
  text: string,
  options: ts.CompilerOptions = {},
): ParsedModule =>
  file.endsWith('.svelte')
    ? parseSvelteModule(text, file, options.verbatimModuleSyntax === true)
    : parseTypeScriptModule(text, file, options.verbatimModuleSyntax === true);

// ── workspace packages ──────────────────────────────────────────────────────

interface PackageManifest {
  readonly name?: string;
  readonly exports?: unknown;
  readonly main?: string;
  readonly workspaces?: string[];
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

/**
 * A package's effective `exports` map.
 *
 * A package with no `exports` publishes exactly one entry — its `main` — and nothing
 * else. Treating that as "publishes everything" would make `package-exports` vacuous for
 * any package that has not opted into the map, and treating it as "publishes nothing"
 * would refuse the package's own barrel. Node's rule is the one to follow.
 */
const exportsOf = (manifest: PackageManifest): unknown =>
  manifest.exports ?? (manifest.main === undefined ? undefined : { '.': manifest.main });

/** The condition keys an exports map is allowed to answer with, most specific first. */
const EXPORT_CONDITIONS = ['svelte', 'import', 'module', 'browser', 'default', 'require', 'node'];

/**
 * One target inside an `exports` entry.
 *
 * Both shapes exist in this repository: a bare string
 * (`"./notes": "./src/notes/index.ts"`) and a conditions object
 * (`".": { "svelte": …, "default": … }`). Only string targets are followed. `null`
 * means "blocked", and it is honoured as blocked, because an exports map that blocks
 * a subpath is a decision and the guard must not route around it.
 */
const exportTarget = (entry: unknown): string | null => {
  if (typeof entry === 'string') {
    return entry;
  }
  if (entry === null || typeof entry !== 'object') {
    return null;
  }
  for (const condition of EXPORT_CONDITIONS) {
    const value = (entry as Record<string, unknown>)[condition];
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      return null;
    }
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
};

/**
 * The target a subpath declares, or `null` when the map does not publish it.
 *
 * Exported because a *declaration* has to be checkable too: `policy.ts` names the
 * subpath that publishes each Node-only module, and that claim is only meaningful if
 * something resolves it against the same manifest the bundler will read.
 */
export const lookupExportTarget = (
  root: string,
  packageDir: string,
  subpath: string,
): string | null => lookupExport(exportsOf(readManifestOrEmpty(root, packageDir)), subpath);

/**
 * The target a subpath declares, or `null` when the map does not publish it.
 *
 * `.` is the package root. A `/*` pattern is a declaration that every subpath under
 * its prefix is published, which is what a package that really means "export
 * everything here" writes.
 */
const lookupExport = (exportsField: unknown, subpath: string): string | null => {
  if (exportsField === null || typeof exportsField !== 'object') {
    return typeof exportsField === 'string' ? exportsField : null;
  }
  const table = exportsField as Record<string, unknown>;

  const exact = table[subpath];
  if (exact !== undefined) {
    return exportTarget(exact);
  }

  for (const [key, value] of Object.entries(table)) {
    if (!key.startsWith('./') || !key.endsWith('/*')) {
      continue;
    }
    const prefix = key.slice(0, -1);
    if (!subpath.startsWith(prefix)) {
      continue;
    }
    const target = exportTarget(value);
    if (target === null) {
      return null;
    }
    return target.replaceAll('*', subpath.slice(prefix.length));
  }

  return null;
};

/** Every subpath an `exports` map publishes, without the leading `./`. */
const exportKeys = (exportsField: unknown): Set<string> => {
  const keys = new Set<string>(['.']);
  if (exportsField === null || typeof exportsField !== 'object') {
    return keys;
  }
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    for (const [key, target] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('./')) {
        keys.add(key === '.' ? '.' : key.slice(2));
      } else if (target !== undefined) {
        // A conditions object nested under a subpath key.
        visit(target);
      }
    }
  };
  visit(exportsField);
  return keys;
};

const readManifest = (file: string): PackageManifest | null => {
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageManifest;
  } catch {
    return null;
  }
};

const readManifestOrEmpty = (root: string, dir: string): PackageManifest =>
  readManifest(join(root, dir, 'package.json')) ?? {};

/**
 * Every workspace package, discovered from the root manifest's `workspaces` globs.
 *
 * Read from the manifest rather than from a list, so a package added to the
 * repository is classified the moment it exists. That is what makes "a new workspace
 * package with an illegal edge" produce a violation with a real message instead of
 * falling through the guard because nobody remembered to add it to a table.
 */
export const readWorkspacePackages = (root: string): Map<string, WorkspacePackage> => {
  const found = new Map<string, WorkspacePackage>();
  const rootManifest = readManifest(join(root, 'package.json'));
  const patterns = rootManifest?.workspaces ?? [];

  for (const pattern of patterns) {
    const base = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
    const baseDir = join(root, base);
    if (!existsSync(baseDir)) {
      continue;
    }
    const relativeDirs = pattern.endsWith('/*')
      ? readdirSync(baseDir)
          .map((entry) => `${base}/${entry}`)
          .filter((entry) => statSync(join(root, entry)).isDirectory())
          .filter((entry) => !isGeneratedPath(entry))
      : [base];

    for (const relativeDir of relativeDirs) {
      const manifest = readManifest(join(root, relativeDir, 'package.json'));
      if (manifest?.name === undefined) {
        continue;
      }
      found.set(manifest.name, {
        name: manifest.name,
        dir: relativeDir.split('\\').join('/'),
        declared: new Set([
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.devDependencies ?? {}),
          ...Object.keys(manifest.peerDependencies ?? {}),
          ...Object.keys(manifest.optionalDependencies ?? {}),
        ]),
        exportKeys: exportKeys(exportsOf(manifest)),
      });
    }
  }

  return found;
};

// ── projects ────────────────────────────────────────────────────────────────

interface Project {
  /** Directory holding the tsconfig, repo-relative. */
  readonly dir: string;
  readonly configFile: string;
  readonly configRelative: string;
  readonly options: ts.CompilerOptions;
  /**
   * The directory a `paths` entry is relative to.
   *
   * Not the project directory. A `paths` entry is relative to the config that
   * *declared* it, and in this repository the one that declares `#lib` is the tsconfig
   * SvelteKit generates into `node_modules/$app/`. TypeScript computes this during
   * config parsing and keeps it on the options object, but does not declare it, so it is
   * read through one narrow accessor with the project directory as a fallback.
   */
  readonly pathsBase: string;
  /** Errors TypeScript reported while reading the config itself. */
  readonly errors: readonly string[];
}

/**
 * Read TypeScript's computed `paths` base directory.
 *
 * The property is set by `parseJsonConfigFileContent` and present at run time — checked
 * against this repository's client project, where it resolves to the generated
 * `node_modules/$app` directory — but it is not in the 6.0 type declarations. One cast,
 * documented, instead of re-deriving TypeScript's own `extends` bookkeeping by hand.
 */
const pathsBaseOf = (options: ts.CompilerOptions, configFile: string): string => {
  const computed = (options as { pathsBasePath?: string }).pathsBasePath;
  if (typeof computed === 'string' && computed.length > 0) {
    return computed;
  }
  return dirname(configFile);
};

/**
 * Compiler options used when a file belongs to no tsconfig at all.
 *
 * `Bundler` resolution with TypeScript extensions, matching `config/tsconfig` in this
 * repository, so an unconfigured file is resolved the same way a configured one is
 * rather than the way a 2019 Node program would be.
 */
const FALLBACK_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2023,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
};

export class ProjectRegistry {
  readonly #root: string;
  readonly #host: ts.ParseConfigFileHost;
  readonly #cache = new Map<string, Project>();

  constructor(root: string) {
    this.#root = root;
    this.#host = {
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      // `getParsedCommandLineOfConfigFile` needs the full `ParseConfigFileHost`,
      // not just a resolution host: it walks `include`/`exclude` while merging an
      // `extends` chain. Omitting `readDirectory` makes every project report as
      // unreadable, which is the loud failure rather than the quiet one.
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getCurrentDirectory: () => root,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      // Required by the type, and only consulted for a config TypeScript considers
      // unrecoverable — in which case `parsed.errors` carries the diagnostic and this
      // guard reports it. It must not be silent, but it must not be the reporter.
      onUnRecoverableConfigFileDiagnostic: () => {},
      realpath: (candidate) => {
        try {
          return realpathSync(candidate);
        } catch {
          return candidate;
        }
      },
    };
  }

  get host(): ts.ModuleResolutionHost {
    return this.#host;
  }

  /** The project that owns `relativeFile`: the nearest ancestor with a tsconfig. */
  projectFor(relativeFile: string): Project {
    let directory = dirname(relativeFile);
    while (directory !== '.' && directory !== '' && directory !== '/') {
      const cached = this.#cache.get(directory);
      if (cached !== undefined) {
        return cached;
      }
      const configRelative = `${directory}/tsconfig.json`;
      const configFile = join(this.#root, configRelative);
      if (existsSync(configFile)) {
        const project = this.#read(directory, configFile, configRelative);
        this.#cache.set(directory, project);
        return project;
      }
      directory = dirname(directory);
    }

    const cached = this.#cache.get('.');
    if (cached !== undefined) {
      return cached;
    }
    const configFile = join(this.#root, 'tsconfig.json');
    if (existsSync(configFile)) {
      const project = this.#read('.', configFile, 'tsconfig.json');
      this.#cache.set('.', project);
      return project;
    }

    const fallback: Project = {
      dir: '.',
      configFile: join(this.#root, 'tsconfig.json'),
      configRelative: 'tsconfig.json',
      options: FALLBACK_OPTIONS,
      pathsBase: this.#root,
      errors: [
        "No tsconfig.json above this file; module resolution used the guard's " +
          'defaults, so a misconfigured project would look resolved.',
      ],
    };
    this.#cache.set('.', fallback);
    return fallback;
  }

  #read(dir: string, configFile: string, configRelative: string): Project {
    let parsed: ts.ParsedCommandLine | undefined;
    try {
      parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, this.#host);
    } catch (error) {
      return {
        dir,
        configFile,
        configRelative,
        options: FALLBACK_OPTIONS,
        pathsBase: this.#root,
        errors: [
          `${configRelative} could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }

    if (parsed === undefined) {
      return {
        dir,
        configFile,
        configRelative,
        options: FALLBACK_OPTIONS,
        pathsBase: this.#root,
        errors: [`${configRelative} is not a readable tsconfig.`],
      };
    }

    return {
      dir,
      configFile,
      configRelative,
      options: parsed.options,
      pathsBase: pathsBaseOf(parsed.options, configFile),
      errors: parsed.errors.map(
        (error) => `${configRelative}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`,
      ),
    };
  }
}

// ── framework metadata ──────────────────────────────────────────────────────

/**
 * Walk up from `start` looking for a relative path, at most `depth` levels.
 *
 * Used to find installed packages from a workspace member, since Bun's layout puts
 * most of them under the repository root and some under the member itself.
 */
const findUpwards = (start: string, segments: readonly string[], depth = 6): string | null => {
  let directory = start;
  for (let level = 0; level < depth; level += 1) {
    const candidate = join(directory, ...segments);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
  return null;
};

/**
 * Ambient module declarations, read from installed framework metadata.
 *
 * `$app/navigation` is not a file. It is a `declare module` in the framework's own
 * type declarations, and the same is true of `$env/*` in the config SvelteKit
 * generates for the application. Guessing the list here would be a second source of
 * truth that drifts on the next framework upgrade; reading the declarations keeps the
 * guard honest about what the installed framework actually provides — and it is what
 * lets `policy.ts` state a *prefix* while the guard verifies the prefix.
 */
const readFrameworkModules = (root: string): Set<string> => {
  const declared = new Set<string>();

  const harvest = (file: string | null): void => {
    if (file === null || !file.endsWith('.d.ts')) {
      return;
    }
    for (const match of readFileSync(file, 'utf8').matchAll(
      /\bdeclare\s+module\s+['"]([^'"]+)['"]/g,
    )) {
      if (match[1] !== undefined) {
        declared.add(match[1]);
      }
    }
  };

  for (const searchFrom of [join(root, 'apps/frontend/client'), root]) {
    if (!existsSync(searchFrom)) {
      continue;
    }
    harvest(findUpwards(searchFrom, ['node_modules/@sveltejs/kit/types/index.d.ts']));
    const generated = findUpwards(searchFrom, ['node_modules/$app/types']);
    if (generated !== null) {
      for (const entry of readdirSync(generated)) {
        harvest(join(generated, entry));
      }
    }
  }

  return declared;
};

/**
 * Specifier roots the guard will accept from framework metadata alone.
 *
 * Deliberately a short prefix list so the claim is testable: `policy.ts` trusts
 * `$app`, and if the installed framework declares nothing under it, then every
 * `$app/...` import is about to be reported as unresolved for a reason that has nothing
 * to do with the code — and the guard says so instead of producing a wall of confusing
 * reports.
 *
 * `$app/env/public` and `$app/env/private` are the only other virtual modules in
 * SvelteKit 3, and they are declared by the same framework under the same root, so
 * listing `$env` separately would have been a second source of truth that the installed
 * version does not support.
 */
export const FRAMEWORK_ROOTS = ['$app'] as const;

// ── resolution ──────────────────────────────────────────────────────────────

const NODE_BUILTINS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((name) => name.replace(/^node:/, '')),
]);

/** `fs/promises` is a builtin; `fs/promises/x` is not. */
const isNodeBuiltin = (specifier: string): boolean =>
  specifier.startsWith('node:') || NODE_BUILTINS.has(specifier);

/**
 * Extensions Vite and SvelteKit supply that TypeScript's resolver does not know.
 *
 * `.svelte` is the important one: TypeScript has no script kind for a Svelte
 * component, so `#lib/features/notes/note_card.svelte` — a completely ordinary
 * import in this repository — does not resolve, and the guard would report it as an
 * unresolvable first-party dependency.
 */
const BUNDLER_EXTENSIONS = ['.svelte', '.ts', '.tsx', '.js', '.mjs'];

const ASSET_EXTENSIONS = ['.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.json', '.woff2'];

/**
 * Re-resolve a specifier with the extensions a bundler adds.
 *
 * Two problems, solved differently.
 *
 * **Extensions.** TypeScript has no script kind for a Svelte component, so
 * `#lib/features/notes/note_card.svelte` — a completely ordinary import in this
 * repository — does not resolve. The fix is to retry the specifier with each extension
 * a bundler would add, which is `BUNDLER_EXTENSIONS`.
 *
 * **Alias base directory.** A `paths` entry inherited through `extends` is relative to
 * the directory of the config that *declared* it. In this repository the `#lib` entry
 * is declared by the tsconfig SvelteKit generates into `node_modules/$app/`, not by the
 * project's own `tsconfig.json`, and mapping it against the project's directory
 * resolves to `<repo>/src/lib` — a path that does not exist. So the base comes from
 * `ts.getPathsBasePath`, TypeScript's own accessor for exactly this, rather than from
 * the project directory.
 */
const resolveWithBundlerExtensions = (
  specifier: string,
  importerFile: string,
  project: Project,
  context: ResolverContext,
): Resolution | null => {
  const bases: string[] = [];
  const queryless = specifier.split('?')[0] ?? specifier;

  if (queryless.startsWith('.')) {
    bases.push(resolvePath(dirname(importerFile), queryless));
  } else {
    const paths = project.options.paths ?? {};
    const pathsBase = project.pathsBase;
    for (const [key, targets] of Object.entries(paths)) {
      const star = key.indexOf('*');
      if (star === -1) {
        if (specifier === key) {
          bases.push(...targets.map((target) => resolvePath(pathsBase, target)));
        }
        continue;
      }
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (!queryless.startsWith(prefix) || !queryless.endsWith(suffix)) {
        continue;
      }
      const matched = queryless.slice(prefix.length, queryless.length - suffix.length);
      for (const target of targets) {
        const index = target.indexOf('*');
        bases.push(
          resolvePath(
            pathsBase,
            index === -1 ? target : target.slice(0, index) + matched + target.slice(index + 1),
          ),
        );
      }
    }
  }

  const attempts: string[] = [];
  for (const base of bases) {
    attempts.push(base, ...BUNDLER_EXTENSIONS.map((extension) => `${base}${extension}`));
    for (const extension of BUNDLER_EXTENSIONS) {
      attempts.push(`${base}/index${extension}`);
    }
  }

  for (const attempt of attempts) {
    if (!existsSync(attempt) || !statSync(attempt).isFile()) {
      continue;
    }
    return {
      kind: 'first-party',
      file: toRelative(context.root, attempt),
      specifier,
      capabilities: capabilitiesOfSpecifier(specifier),
    };
  }

  return null;
};

/**
 * Does `specifier` fall under `rule.root`?
 *
 * Two shapes, and getting them confused is how a whole capability class silently
 * stops existing. `node:` is a *scheme*: `node:child_process` is under it, so the
 * prefix is the root as written. `drizzle-orm` is a package name: it covers
 * `drizzle-orm` and `drizzle-orm/d1`, and nothing else — a package called
 * `drizzle-orm-extras` is a different package.
 *
 * An earlier version used exact-or-`/subpath` for both, which made every `node:` and
 * `cloudflare:` rule match nothing at all. Nothing failed: the repository has no
 * Node import in browser code, so the guard reported a clean tree while the mechanism
 * that was supposed to catch one was inert.
 */
const matchesRoot = (specifier: string, root: string): boolean =>
  root.endsWith(':')
    ? specifier.startsWith(root)
    : specifier === root || specifier.startsWith(`${root}/`);

const capabilitiesOfSpecifier = (specifier: string): Capability[] =>
  CAPABILITY_RULES.filter((rule) => matchesRoot(specifier, rule.root)).map(
    (rule) => rule.capability,
  );

/**
 * SvelteKit's `./$types`.
 *
 * Generated from the route table into a gitignored directory, so it does not exist
 * until `svelte-kit sync` has run — which is a fact about whether a build has run,
 * not about whether the repository is correct. It is a type-only module with no
 * emitted code, so it has no plane and no capability. Refusing to resolve it would
 * mean the guard failed on a checkout that had not built yet.
 */
const isGeneratedRouteTypes = (specifier: string): boolean =>
  specifier === '$types' || specifier.endsWith('/$types');

const isAliasLike = (specifier: string, project: Project): boolean =>
  specifier.startsWith('#') ||
  Object.keys(project.options.paths ?? {}).some(
    (key) => key === specifier || specifier.startsWith(`${key}/`),
  );

/**
 * `@starter/ui/tokens.css` -> `{ name: '@starter/ui', subpath: './tokens.css' }`.
 *
 * A scoped name needs the *second* separator, not the first: `@starter` is not a
 * package here, and treating the first `/` as the boundary silently splits every
 * scoped import into a package that does not exist plus a subpath that is not
 * declared. That failure mode is invisible — the split simply never matches anything,
 * so both the `exports` check and the declared-dependency check quietly do nothing.
 */
export const splitPackageSpecifier = (
  specifier: string,
): { name: string; subpath: string } | null => {
  if (specifier.startsWith('@')) {
    const first = specifier.indexOf('/');
    if (first === -1) {
      return null;
    }
    const second = specifier.indexOf('/', first + 1);
    if (second === -1) {
      return { name: specifier, subpath: '.' };
    }
    return { name: specifier.slice(0, second), subpath: `.${specifier.slice(second)}` };
  }
  const slash = specifier.indexOf('/');
  return slash === -1
    ? { name: specifier, subpath: '.' }
    : { name: specifier.slice(0, slash), subpath: `.${specifier.slice(slash)}` };
};

interface ResolverContext {
  readonly root: string;
  readonly packages: ReadonlyMap<string, WorkspacePackage>;
  readonly frameworkModules: ReadonlySet<string>;
  readonly registry: ProjectRegistry;
}

/**
 * A stylesheet or other non-module file, resolved after module resolution failed.
 *
 * Only non-modules reach this: a CSS side-effect import carries no code and so no
 * plane, but it *is* a dependency of this repository, and reporting it as unresolved
 * would train people to ignore unresolved reports.
 */
const findAsset = (
  specifier: string,
  importerFile: string,
  context: ResolverContext,
): string | null => {
  const withoutQuery = specifier.split('?')[0] ?? specifier;
  const candidates: string[] = [];

  if (withoutQuery.startsWith('.')) {
    const fromImporter = resolvePath(dirname(importerFile), withoutQuery);
    candidates.push(fromImporter, ...ASSET_EXTENSIONS.map((ext) => `${fromImporter}${ext}`));
  }

  const split = splitPackageSpecifier(withoutQuery);
  const workspacePackage = split === null ? undefined : context.packages.get(split.name);
  if (split !== null && workspacePackage !== undefined) {
    const manifest = readManifest(join(context.root, workspacePackage.dir, 'package.json'));
    const target = manifest === null ? null : lookupExport(exportsOf(manifest), split.subpath);
    if (target !== null) {
      candidates.push(resolvePath(context.root, workspacePackage.dir, target));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return toRelative(context.root, candidate);
    }
  }
  return null;
};

/**
 * Resolve one specifier to a canonical identity.
 *
 * Order is deliberate. Framework-provided and runtime-provided specifiers first,
 * because they have no file and asking a resolver about them only produces noise.
 * Then a workspace package's own `exports` map, because that map is the declaration
 * the architecture makes about what may be imported, and a TypeScript `paths` alias
 * must not be able to route around it. Then the project's own TypeScript resolution,
 * which handles `paths`, relative paths and third-party packages. Then assets, which
 * are not modules.
 */
const resolveSpecifier = (
  specifier: string,
  importerFile: string,
  project: Project,
  context: ResolverContext,
): Resolution => {
  const capabilities = capabilitiesOfSpecifier(specifier);

  if (context.frameworkModules.has(specifier)) {
    return { kind: 'framework', specifier, capabilities };
  }
  if (isGeneratedRouteTypes(specifier)) {
    return { kind: 'generated', specifier, capabilities };
  }
  if (specifier.startsWith('cloudflare:') || specifier.startsWith('workerd:')) {
    return { kind: 'framework', specifier, capabilities };
  }
  if (specifier.startsWith('bun:') || isNodeBuiltin(specifier)) {
    return { kind: 'external', specifier, capabilities };
  }

  // A workspace package resolves through its own `exports` map first.
  const split = splitPackageSpecifier(specifier);
  const workspacePackage = split === null ? undefined : context.packages.get(split.name);
  if (split !== null && workspacePackage !== undefined) {
    const manifest = readManifestOrEmpty(context.root, workspacePackage.dir);
    const target = lookupExport(exportsOf(manifest), split.subpath);
    if (target !== null) {
      const absolute = resolvePath(context.root, workspacePackage.dir, target);
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        return { kind: 'unresolved', specifier, capabilities, unresolvedReason: 'first-party' };
      }
      return {
        kind: 'first-party',
        file: toRelative(context.root, absolute),
        specifier,
        capabilities,
      };
    }
  }

  const resolved = ts.resolveModuleName(
    specifier,
    importerFile,
    project.options,
    context.registry.host,
  ).resolvedModule;

  if (resolved !== undefined) {
    const absolute = resolved.resolvedFileName;
    if (absolute.startsWith(context.root)) {
      return {
        kind: 'first-party',
        file: toRelative(context.root, absolute),
        specifier,
        capabilities,
      };
    }
    return { kind: 'external', specifier, capabilities };
  }

  const withExtensions = resolveWithBundlerExtensions(specifier, importerFile, project, context);
  if (withExtensions !== null) {
    return withExtensions;
  }

  const asset = findAsset(specifier, importerFile, context);
  if (asset !== null) {
    return { kind: 'asset', file: asset, specifier, capabilities };
  }

  const firstParty =
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    isAliasLike(specifier, project) ||
    (split !== null && context.packages.has(split.name));

  return {
    kind: 'unresolved',
    specifier,
    capabilities,
    unresolvedReason: firstParty ? 'first-party' : 'third-party',
  };
};

// ── graph construction ───────────────────────────────────────────────────────

/**
 * Build the resolved graph for `root`.
 *
 * Every failure mode produces something the caller can report: `errors` per module,
 * an `unresolved` edge with a reason, and `unclassified` for a source file no
 * placement row covers. A clean result therefore means "everything was read and
 * everything resolved", which is the only meaning a clean result may have.
 */
export const buildModuleGraph = (root: string): ModuleGraph => {
  const packages = readWorkspacePackages(root);
  const registry = new ProjectRegistry(root);
  const frameworkModules = readFrameworkModules(root);
  const context: ResolverContext = { root, packages, frameworkModules, registry };

  const files = listRepositorySourceFiles(root);
  const modules = new Map<string, ModuleNode>();
  const projectErrors = new Map<string, string[]>();

  for (const absolute of files) {
    const file = toRelative(root, absolute);
    const plane = planeOf(file);
    const role = roleOf(file);

    if (plane === null || role === null) {
      continue;
    }

    const project = registry.projectFor(file);
    const projectKey = project.configRelative;
    if (!projectErrors.has(projectKey)) {
      projectErrors.set(projectKey, [...project.errors]);
    }

    let text: string;
    try {
      text = readFileSync(absolute, 'utf8');
    } catch (error) {
      modules.set(file, {
        file,
        plane,
        role,
        edges: [],
        errors: [`Unreadable: ${error instanceof Error ? error.message : String(error)}`],
        usesBunGlobal: false,
        ownCapabilities: new Set<Capability>(),
        capabilities: new Set<Capability>(),
      });
      continue;
    }

    const parsed = parseModule(file, text, project.options);
    const edges: Edge[] = parsed.imports.map((entry) => {
      if (entry.specifier === undefined) {
        return {
          specifier: '',
          line: entry.line,
          typeOnly: false,
          kind: entry.kind,
          resolution: {
            kind: 'unresolved',
            specifier: '',
            capabilities: [],
            unresolvedReason: 'nonliteral',
          },
        };
      }
      return {
        specifier: entry.specifier,
        line: entry.line,
        typeOnly: entry.typeOnly,
        kind: entry.kind,
        resolution: resolveSpecifier(entry.specifier, absolute, project, context),
      };
    });

    modules.set(file, {
      file,
      plane,
      role,
      edges,
      errors: parsed.errors,
      usesBunGlobal: parsed.usesBunGlobal,
      ownCapabilities: ownCapabilitiesOf(edges, parsed.usesBunGlobal),
      capabilities: new Set<Capability>(),
    });
  }

  propagateCapabilities(modules);

  const unclassified = files
    .map((absolute) => toRelative(root, absolute))
    .filter((file) => !modules.has(file));

  const configErrors = [...projectErrors.entries()]
    .filter(([, errors]) => errors.length > 0)
    .map(([file, errors]) => ({ file, errors }));

  return { root, modules, packages, unclassified, configErrors, frameworkModules };
};

/** Capabilities a module's own edges confer, before any inheritance. */
const ownCapabilitiesOf = (edges: readonly Edge[], usesBunGlobal: boolean): Set<Capability> => {
  const own = new Set<Capability>();
  if (usesBunGlobal) {
    own.add('bun-runtime');
  }
  for (const edge of edges) {
    if (edge.typeOnly) {
      continue;
    }
    for (const capability of edge.resolution.capabilities) {
      own.add(capability);
    }
  }
  return own;
};

/**
 * Capabilities, including the ones a module inherits by reaching a module that has
 * them.
 *
 * A fixpoint rather than a single pass, because a capability can travel many edges: a
 * browser component that imports a barrel which re-exports a Node-only subpath has a
 * Node dependency, and it acquires it two hops from the import a reviewer reads.
 * Four capabilities and a monotone lattice, so iteration terminates.
 */
const propagateCapabilities = (modules: Map<string, ModuleNode>): void => {
  let changed = true;
  while (changed) {
    changed = false;
    for (const module of modules.values()) {
      const next = new Set(module.capabilities);
      for (const capability of module.ownCapabilities) {
        next.add(capability);
      }
      for (const edge of module.edges) {
        if (edge.typeOnly) {
          continue;
        }
        const target = edge.resolution.file;
        if (target === undefined) {
          continue;
        }
        const reached = modules.get(target);
        if (reached === undefined) {
          continue;
        }
        for (const capability of reached.capabilities) {
          next.add(capability);
        }
      }
      if (next.size === module.capabilities.size) {
        continue;
      }
      for (const capability of next) {
        module.capabilities.add(capability);
      }
      changed = true;
    }
  }
};

/**
 * Runtime edges from `module` to first-party modules, labelled by specifier.
 *
 * Type-only edges are excluded here and handled by their own rules. An erased
 * declaration cannot put a module in a bundle, so counting it as runtime
 * reachability would overstate what the graph proves.
 */
export const runtimeTargets = (module: ModuleNode): readonly { file: string; via: string }[] =>
  module.edges
    .filter((edge) => !edge.typeOnly && edge.resolution.kind === 'first-party')
    .map((edge) => ({ file: edge.resolution.file as string, via: edge.specifier }));

/** One hop of a reachability chain: the module reached, and the specifier used. */
export interface ChainStep {
  readonly module: ModuleNode;
  /** The specifier that led here. `undefined` for the chain's starting module. */
  readonly via: string | undefined;
}

/**
 * The shortest chain of first-party modules from `start` to every reachable one.
 *
 * Breadth-first, so the chain printed with a violation is the shortest explanation
 * available — which is the one a reader can act on. `via` travels with each step so
 * the report can name the import rather than only the files.
 */
export const reachableChains = (
  start: ModuleNode,
  modules: ReadonlyMap<string, ModuleNode>,
): Map<string, ChainStep[]> => {
  const chains = new Map<string, ChainStep[]>();
  const queue: ChainStep[][] = [[{ module: start, via: undefined }]];
  const seen = new Set<string>([start.file]);

  while (queue.length > 0) {
    const chain = queue.shift();
    if (chain === undefined) {
      break;
    }
    const tail = chain[chain.length - 1]?.module;
    if (tail === undefined) {
      continue;
    }
    for (const target of runtimeTargets(tail)) {
      if (seen.has(target.file)) {
        continue;
      }
      const node = modules.get(target.file);
      if (node === undefined) {
        continue;
      }
      seen.add(target.file);
      const nextChain = [...chain, { module: node, via: target.via }];
      chains.set(target.file, nextChain);
      queue.push(nextChain);
    }
  }

  return chains;
};

/** Render a chain as one line: `a.ts --'specifier'--> b.ts --…--> target.ts`. */
export const renderChain = (chain: readonly ChainStep[]): string =>
  chain
    .map((step, index) =>
      index === 0 ? step.module.file : `--'${step.via}'--> ${step.module.file}`,
    )
    .join(' ');
