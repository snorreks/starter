// scripts/src/guards/guard_architecture.ts
//
// The architecture guard: a resolved module graph checked against a written policy.
//
// `policy.ts` says what is allowed. `module_graph.ts` builds what is actually there.
// This file is the only place the two meet, and every rule below states a single
// invariant that is either true or false of the graph.
//
// What replaced, and why the old one had to go: `guardWorkspaceBoundary` matched
// `@starter/`-prefixed specifiers against a list of package names, read out of source
// with a regular expression. It could not see a re-export, a relative path climbing
// out of its own layer, a subpath that bypassed a package's `exports`, or a dynamic
// import — so a boundary that "could not be crossed quietly" was in fact crossable
// four ways, and the list had no way to say so.
//
// Two design commitments, both visible in the rules below:
//
//   * **Diagnostics name the fix.** Every message carries the source, the target, the
//     dependency chain when there is more than one hop, the rule, and the ownership a
//     reader should move the code to. A guard that says only "not allowed" gets
//     switched off.
//   * **A clean report means everything was read.** Parse errors, unresolved
//     specifiers, non-literal dynamic imports, a source file no placement row covers,
//     and a zero-module graph are all violations. There is no input this guard can
//     fail to look at and still report `ok`.
//
// It replaces `workspace-boundary`; the other guards in `boundary.ts` are unrelated
// invariants and stay where they are.

import { posix } from 'node:path';
import type { GuardResult, Violation } from './boundary.ts';
import {
  buildModuleGraph,
  type ChainStep,
  FRAMEWORK_ROOTS,
  lookupExportTarget,
  type ModuleGraph,
  type ModuleNode,
  reachableChains,
  renderChain,
  splitPackageSpecifier as splitPackage,
  type WorkspacePackage,
} from './module_graph.ts';
import {
  type Capability,
  CROSS_WORKSPACE_RELATIVE_EXEMPTIONS,
  capabilityRoles,
  describeAllowed,
  FORBIDDEN_ROLE_EDGES,
  isDeclaredNodeOnly,
  isTestRunnerSpecifier,
  mayReach,
  NODE_ONLY_MODULES,
  PLANE_CAPABILITIES,
  PLANE_OWNERS,
  planeMayUse,
  planeOf,
  type RelativeImportExemption,
  type Role,
  SERVER_TYPE_ONLY_FORBIDDEN_ROOTS,
  UNCONSTRAINED_ROLES,
  WORKSPACE_PACKAGE_SCOPE,
} from './policy.ts';

/**
 * The workspace package that owns `file`: the longest matching directory.
 *
 * Longest-prefix, because `packages/shared/utils` and a hypothetical
 * `packages/shared/utils-fixtures` would both be prefixes and only one is the owner.
 */
const owningPackage = (graph: ModuleGraph, file: string): WorkspacePackage | null => {
  let owner: WorkspacePackage | null = null;
  for (const candidate of graph.packages.values()) {
    if (!file.startsWith(`${candidate.dir}/`) && file !== candidate.dir) {
      continue;
    }
    if (owner === null || candidate.dir.length > owner.dir.length) {
      owner = candidate;
    }
  }
  return owner;
};

/** `packages/shared/schemas/src/index.ts` -> `@starter/schemas`. */
const packageOfFile = (graph: ModuleGraph, file: string): WorkspacePackage | null =>
  owningPackage(graph, file);

/**
 * The directory that owns a file, as a workspace boundary.
 *
 * `.` for a file no workspace package owns — a root-level script, or a file in the
 * directory the guard was pointed at. Treating "outside every package" as its own
 * boundary is what stops a file at the repository root from reaching into a package's
 * `src/` with no declaration on either side.
 */
const workspaceDirOf = (graph: ModuleGraph, file: string): string =>
  owningPackage(graph, file)?.dir ?? '.';

const exemptionKey = (from: string, to: string): string => `${from}->${to}`;

const isRelativeImportExempt = (from: string, to: string): boolean =>
  CROSS_WORKSPACE_RELATIVE_EXEMPTIONS.some(
    (exemption: RelativeImportExemption) => exemption.from === from && exemption.to === to,
  );

/**
 * The repo-relative file a workspace package's `exports` map publishes for a subpath.
 *
 * `null` when the subpath is not published. Reads the package's own manifest, so it
 * answers the same question the bundler will.
 */
const resolveWorkspaceSubpath = (
  graph: ModuleGraph,
  packageName: string,
  subpath: string,
): string | null => {
  const manifest = graph.packages.get(packageName);
  if (manifest === undefined) {
    return null;
  }
  const target = lookupExportTarget(graph.root, manifest.dir, subpath);
  // `posix.join` rather than concatenation: an exports target is written `./src/…`, and
  // a report that says `packages/shared/utils/./src/…` does not match any path a reader
  // would type, which makes a working declaration look like drift.
  return target === null ? null : posix.join(manifest.dir, target);
};

/**
 * Does a package's `exports` map publish this subpath?
 *
 * The map is the only authority. A `tsconfig` `paths` entry that maps
 * `@starter/utils/*` to the package's `src/*` resolves perfectly well and still
 * routes around the map — which is how a Node-only helper becomes reachable as
 * `@starter/utils/lib/process/index.ts` and the deliberate `/process` entry point
 * stops meaning anything.
 */
const publishesSubpath = (manifest: WorkspacePackage, subpath: string): boolean => {
  if (subpath === '.') {
    return manifest.exportKeys.has('.');
  }
  const key = subpath.slice(2);
  if (manifest.exportKeys.has(key)) {
    return true;
  }
  for (const published of manifest.exportKeys) {
    if (published.endsWith('/*') && key.startsWith(published.slice(0, -1))) {
      return true;
    }
  }
  return false;
};

// ── rules ───────────────────────────────────────────────────────────────────

interface Context {
  readonly graph: ModuleGraph;
  readonly violations: Violation[];
}

const report = (context: Context, violation: Violation): void => {
  context.violations.push(violation);
};

/**
 * Rule 1 — every source file is owned.
 *
 * `PLANE_PLACEMENTS` and `ROLE_PLACEMENTS` cover the repository. A file they do not
 * cover has no plane and no role, so nothing about it can be checked, and a policy
 * with a silent gap is indistinguishable from a policy that permits it.
 */
const ruleUnclassified = (context: Context): void => {
  for (const file of context.graph.unclassified) {
    report(context, {
      rule: 'unclassified-source',
      file,
      line: 1,
      message:
        'No ownership rule covers this file, so no edge of it can be checked.\n' +
        '  Add it to PLANE_PLACEMENTS and ROLE_PLACEMENTS in scripts/src/guards/policy.ts,\n' +
        '  or move it under a directory that is already owned.',
    });
  }
};

/**
 * Rule 2 — every file was read.
 *
 * A syntax error means the graph is incomplete, and an unreadable tsconfig means
 * every module in that project resolved against fallback options rather than the
 * configured ones. Reporting `ok` on a half-read tree is the failure this whole guard
 * exists to prevent, so both are violations rather than warnings.
 *
 * The tsconfig case is reported once per config file, not once per module: one
 * unreadable file affects every module in it, and a violation per module would bury
 * the one line that names the real problem.
 */
const ruleReadable = (context: Context): void => {
  for (const module of context.graph.modules.values()) {
    for (const error of module.errors) {
      report(context, {
        rule: 'parse-error',
        file: module.file,
        line: 1,
        message:
          `This file could not be parsed, so its imports were not checked: ${error}\n` +
          '  Fix the syntax. A guard that skips unreadable input and reports success\n' +
          '  is not a weaker guard; it is a guard that lies.',
      });
    }
  }

  for (const failure of context.graph.configErrors) {
    report(context, {
      rule: 'project-config',
      file: failure.file,
      line: 1,
      message:
        `This project's tsconfig could not be read, so its imports were resolved against ` +
        `the guard's defaults rather than the configured ones.\n  ${failure.errors.join('\n  ')}\n` +
        '  Resolution that ignores `paths`, `baseUrl` and `moduleResolution` is not\n' +
        '  resolution, and reporting it as checked would be false.',
    });
  }
};

/**
 * Rule 3 — every specifier resolves.
 *
 * Two reasons, reported separately, because the fix differs. A first-party specifier
 * that does not resolve is a dependency of this repository that the repository cannot
 * account for: a typo, a deleted module, or an alias pointing nowhere. A third-party
 * one that does not resolve is usually an undeclared dependency, and it means the
 * build works by accident on one machine.
 *
 * The non-literal dynamic import is the third case and the most interesting one.
 * `import(variable)` cannot be resolved statically, and this guard does not pretend
 * otherwise: it reports it. See `ruleNonLiteralDynamicImport` for the bounded policy.
 */
const ruleResolves = (context: Context): void => {
  for (const module of context.graph.modules.values()) {
    for (const edge of module.edges) {
      const { resolution } = edge;
      if (resolution.kind !== 'unresolved') {
        continue;
      }
      if (resolution.unresolvedReason === 'nonliteral') {
        // Reported by its own rule, with its own message.
        continue;
      }
      const firstParty = resolution.unresolvedReason === 'first-party';
      // A workspace subpath that is not published is reported by `rulePackageExports`,
      // which names the exports map and the declared alternatives. Reporting it here as
      // well would give one mistake two reports, the second of which is the less useful
      // one.
      const split = splitPackage(edge.specifier);
      if (
        firstParty &&
        split !== null &&
        context.graph.packages.has(split.name) &&
        !publishesSubpath(context.graph.packages.get(split.name) as WorkspacePackage, split.subpath)
      ) {
        continue;
      }
      report(context, {
        rule: firstParty ? 'unresolved-first-party' : 'unresolved-third-party',
        file: module.file,
        line: edge.line,
        message: firstParty
          ? `'${resolution.specifier}' is a dependency of this repository and does not ` +
            'resolve.\n' +
            "  Check the path, the package subpath, and this project's tsconfig `paths`.\n" +
            '  A boundary you cannot resolve is a boundary you are not checking.'
          : `'${resolution.specifier}' does not resolve from ${module.file}.\n` +
            '  Either it is not installed here, or the import is satisfied by\n' +
            '  something other than module resolution.',
      });
    }
  }
};

/**
 * Rule 4 — a non-literal dynamic import in application code is a violation.
 *
 * The honest position: a static graph cannot know what `import(name)` loads, so a
 * guard that reports `ok` in its presence is claiming a proof it does not have. The
 * bounded policy is therefore explicit rather than aspirational:
 *
 *   - Non-test modules may not contain one. Every module in the repository is either
 *     shipped or run, so a non-literal import anywhere in them is a place the boundary
 *     cannot see.
 *   - Test modules may. `import(\`../dev_ports.ts?case=${name}\`)` is the standard way
 *     to prove a module's behaviour depends on its environment, and a test never
 *     reaches a bundle.
 *
 * What this does *not* claim: that arbitrary dynamic JavaScript is safe. It claims the
 * unchecked edges are confined to test files that ship nothing.
 */
const ruleNonLiteralDynamicImport = (context: Context): void => {
  for (const module of context.graph.modules.values()) {
    if (UNCONSTRAINED_ROLES.includes(module.role)) {
      continue;
    }
    for (const edge of module.edges) {
      if (edge.resolution.unresolvedReason !== 'nonliteral') {
        continue;
      }
      report(context, {
        rule: 'nonliteral-dynamic-import',
        file: module.file,
        line: edge.line,
        message:
          'A dynamic import whose specifier is not a literal cannot be resolved, so the ' +
          'boundary cannot be checked here.\n' +
          '  Use a static import, or a literal dynamic import the guard can resolve.\n' +
          '  The exemption for tests exists because a test ships nothing; this file is ' +
          'not a test.',
      });
    }
  }
};

/**
 * Rule 5 — the framework provides what the policy assumes it provides.
 *
 * `policy.ts` trusts the roots in `FRAMEWORK_ROOTS` as framework-owned, and
 * `module_graph.ts` discovers the real module names from the installed framework's own
 * ambient declarations. This rule connects the two: if the policy trusts a root and
 * the installed framework declares nothing under it, then every `$app/...` import is
 * about to be reported as unresolved for a reason that has nothing to do with the
 * code — and the guard says so instead of producing a wall of confusing reports.
 */
const ruleFrameworkRootsExist = (context: Context): void => {
  for (const root of FRAMEWORK_ROOTS) {
    const provided = [...context.graph.frameworkModules].some((name) =>
      name.startsWith(`${root}/`),
    );
    if (provided) {
      continue;
    }
    report(context, {
      rule: 'framework-prefix-unverified',
      file: 'scripts/src/guards/policy.ts',
      line: 1,
      message:
        `The guard trusts '${root}/*' as framework-provided, but the installed framework ` +
        'declares no such module.\n' +
        '  Either the framework moved its virtual modules, or the installed version is ' +
        'not the one this guard was written against. Resolving neither is the safe ' +
        'outcome; reporting those imports as unresolved would not be.',
    });
  }
};

/**
 * Rule 6 — a workspace package declares every workspace package it imports by name.
 *
 * Resolution says what *resolves*; this says what is *declared*. They differ, and the
 * difference is how a package acquires a dependency it never intended: it works in one
 * checkout because the workspace hoisted it, and breaks when it is published, built
 * alone, or installed without the workspace.
 *
 * Scoped to package specifiers on purpose. A *relative* path into another workspace
 * package's source — `apps/e2e` importing `scripts/src/shared/paths.ts` — is a real
 * smell and it is not covered here: it is not an undeclared package dependency, and
 * every such path in this repository is between two private tooling packages that are
 * built together, where the failure mode this rule exists for (a dependency that only
 * resolves because a hoister provided it) does not arise. That limit is stated rather
 * than papered over with an exemption.
 */
const ruleDeclaredDependencies = (context: Context): void => {
  for (const module of context.graph.modules.values()) {
    const owner = packageOfFile(context.graph, module.file);
    if (owner === null) {
      continue;
    }
    for (const edge of module.edges) {
      const split = splitPackage(edge.specifier);
      if (split === null) {
        continue;
      }
      const dependency = context.graph.packages.get(split.name);
      if (dependency === undefined || dependency.name === owner.name) {
        continue;
      }
      if (owner.declared.has(dependency.name)) {
        continue;
      }
      report(context, {
        rule: 'undeclared-dependency',
        file: module.file,
        line: edge.line,
        message:
          `${owner.name} imports ${dependency.name} ('${edge.specifier}') but does not ` +
          `declare it.\n  Add it to ${owner.dir}/package.json. A dependency that resolves ` +
          'only because the workspace hoisted it is a dependency this package does not have.',
      });
    }
  }
};

/**
 * Rule 7 — a workspace package is imported only through its `exports`.
 *
 * `@starter/utils/process` is an explicit statement that the caller is not a browser.
 * `@starter/utils/lib/process/index.ts` says the same thing while ignoring the
 * declaration, and it keeps working when the file moves — which is precisely when a
 * boundary should stop working quietly.
 */
const rulePackageExports = (context: Context): void => {
  for (const module of context.graph.modules.values()) {
    for (const edge of module.edges) {
      const split = splitPackage(edge.specifier);
      if (split === null || !split.name.startsWith(WORKSPACE_PACKAGE_SCOPE)) {
        continue;
      }
      const manifest = context.graph.packages.get(split.name);
      if (manifest === undefined || publishesSubpath(manifest, split.subpath)) {
        continue;
      }
      report(context, {
        rule: 'package-exports',
        file: module.file,
        line: edge.line,
        message:
          `'${edge.specifier}' is not published by ${manifest.name}. Its package.json ` +
          `declares: ${[...manifest.exportKeys].sort().join(', ')}.\n` +
          '  Import a declared subpath, or add this one to its exports map. A deep ' +
          'import resolves today and survives a file move it should not have survived.',
      });
    }
  }
};

/**
 * Rule 8 — a plane reaches only what its row allows.
 *
 * The four-by-four matrix in `policy.ts`, checked over *runtime* reachability rather
 * than direct edges only. Transitive checking is the point: a browser module that
 * imports a portable barrel which re-exports a server module is reaching the server
 * module, and only a graph can say so.
 *
 * Type-only edges are excluded here and have their own rule, because an erased
 * declaration is not reachability — with one deliberate exception, stated there.
 */
const rulePlaneReachability = (context: Context): void => {
  for (const module of context.graph.modules.values()) {
    if (UNCONSTRAINED_ROLES.includes(module.role)) {
      continue;
    }
    const chains = reachableChains(module, context.graph.modules);
    for (const [targetFile, chain] of chains) {
      const target = context.graph.modules.get(targetFile);
      if (target === undefined || mayReach(module.plane, target.plane)) {
        continue;
      }
      report(context, {
        rule: 'plane-reachability',
        file: module.file,
        line: lineOfFirstEdge(module, chain),
        message:
          `A ${module.plane} module reaches a ${target.plane} module at run time.\n` +
          `  Chain: ${renderChain(chain)}\n` +
          `  ${module.plane} may reach: ${describeAllowed(module.plane)}\n` +
          `  ${target.plane}-owned code belongs in: ${PLANE_OWNERS[target.plane]}\n` +
          '  If this edge is a type-only contract, put it in @starter/schemas: a DTO ' +
          'belongs in the portable package, and importing the implementation is what ' +
          'puts it in the bundle.',
      });
    }
  }
};

/** The line of the import that begins the chain, which is the line a reader fixes. */
const lineOfFirstEdge = (module: ModuleNode, chain: readonly ChainStep[]): number => {
  const first = chain[1];
  if (first === undefined) {
    return 1;
  }
  return module.edges.find((edge) => edge.specifier === first.via)?.line ?? 1;
};

/**
 * Rule 9 — a module holds only the capabilities its plane has.
 *
 * This is what catches a Node-only subpath reached through a portable package, and it
 * is why the capability set is a fixpoint rather than the module's own edges.
 * `@starter/utils/process` lives in a portable package, so a plane check alone sees a
 * legal edge; the capability travels through it to `node:child_process`, and the
 * browser half that reached it does not have Node.
 *
 * One capability is checked against the module's *role* instead, because what provides
 * it is not a runtime: `CAPABILITY_ROLES` in `policy.ts` names the roles allowed to
 * hold `native-runtime`, which is how the Tauri bridge is confined to the native
 * application's composition root without granting it to every browser file.
 *
 * For those role-held capabilities the check distinguishes two ways of acquiring one,
 * because they are different mistakes:
 *
 *   * **Naming it.** A module whose own specifier is `@tauri-apps/*` must itself be
 *     the bridge. This is the rule `scripts/tests/new_roots_guards.test.ts` pins, and
 *     it is the one that matters: a component reaching for `invoke` itself is a page
 *     that would break in any other host.
 *   * **Inheriting it.** A module that reaches the *bridge* — the composition root, a
 *     route, a screen — is part of the same native host and is allowed to hold what
 *     the bridge holds. Refusing this would forbid dependency injection outright: the
 *     composition root is exactly the thing routes are supposed to consume, so a
 *     transitive check would report every screen in the application while the thing it
 *     is complaining about is the architecture working.
 *
 * Inheriting from anything *else* — a module that is not the bridge but names the API
 * itself — is still a violation, because that intermediate is exactly the leak the
 * bridge placement exists to prevent.
 */
const ruleRuntimeCapabilities = (context: Context): void => {
  for (const module of context.graph.modules.values()) {
    if (UNCONSTRAINED_ROLES.includes(module.role)) {
      continue;
    }
    for (const capability of [...module.capabilities].sort()) {
      const roles = capabilityRoles(capability);
      if (roles === undefined) {
        if (planeMayUse(module.plane, capability)) {
          continue;
        }
      } else if (
        roles.includes(module.role) ||
        inheritsFromBridgedRole(module, capability, context)
      ) {
        continue;
      }
      report(context, {
        rule: 'runtime-capability',
        file: module.file,
        line: lineOfCapability(module, capability, context.graph),
        message:
          `A ${module.plane} module needs '${capability}', which only ` +
          `${describeCapability(capability)} provides.\n` +
          `  Introduced by: ${describeCapabilitySource(module, capability, context.graph)}\n` +
          `  ${module.plane} may use: ${
            PLANE_CAPABILITIES[module.plane].join(', ') || 'nothing'
          }.\n` +
          (roles === undefined ? '' : `  A ${module.role} may use it: ${roles.join(', ')}.\n`) +
          '  A Node-only helper reached from a browser is a build that fails in ' +
          'production, not in review.',
      });
    }
  }
};

/**
 * Does this module hold `capability` only by reaching a module whose role is allowed
 * to hold it?
 *
 * True when the module does not name the capability's package itself and every edge
 * that introduces it lands on an allowed role. See the rule's header for why the two
 * ways of acquiring one are treated differently.
 */
const inheritsFromBridgedRole = (
  module: ModuleNode,
  capability: Capability,
  context: Context,
): boolean => {
  const roles = capabilityRoles(capability) ?? [];
  if (module.ownCapabilities.has(capability)) {
    return false;
  }
  return originRoles(module, capability, context, new Set()).every((role) => roles.includes(role));
};

/**
 * Every role at which `capability` is actually named, reached from `module`.
 *
 * The walk is not one level deep: the composition root reaches the bridge, and a
 * route reaches the composition root, and the route is the module being judged. What
 * matters is where the `@tauri-apps/*` specifier is *written*, so this follows first
 * -party edges until it finds the modules that hold the capability themselves, and
 * answers with their roles. An empty result means the capability is in the fixpoint
 * but no module names it, which is reported rather than treated as inherited.
 */
const originRoles = (
  module: ModuleNode,
  capability: Capability,
  context: Context,
  seen: Set<string>,
): Role[] => {
  if (seen.has(module.file)) {
    return [];
  }
  seen.add(module.file);

  if (module.ownCapabilities.has(capability)) {
    return [module.role];
  }

  return module.edges.flatMap((edge) => {
    const target = context.graph.modules.get(edge.resolution.file ?? '');
    return target === undefined || !target.capabilities.has(capability)
      ? []
      : originRoles(target, capability, context, seen);
  });
};

const describeCapability = (capability: Capability): string => {
  switch (capability) {
    case 'node-runtime':
      return 'Node';
    case 'bun-runtime':
      return 'the Bun runtime';
    case 'worker-runtime':
      return 'workerd';
    case 'dom-runtime':
      return 'a DOM';
    case 'native-runtime':
      return 'the Tauri shell';
  }
};

/** The first module in the chain that has the capability of its own accord. */
const describeCapabilitySource = (
  module: ModuleNode,
  capability: Capability,
  graph: ModuleGraph,
): string => {
  const own = module.edges.find(
    (edge) => !edge.typeOnly && edge.resolution.capabilities.includes(capability),
  );
  if (own !== undefined) {
    return `${module.file}:${own.line} imports '${own.specifier}'`;
  }
  if (module.usesBunGlobal && capability === 'bun-runtime') {
    return `${module.file} references the Bun global`;
  }
  for (const [file, chain] of reachableChains(module, graph.modules)) {
    const node = graph.modules.get(file);
    if (node?.ownCapabilities.has(capability)) {
      return renderChain(chain);
    }
  }
  return module.file;
};

const lineOfCapability = (
  module: ModuleNode,
  capability: Capability,
  graph: ModuleGraph,
): number => {
  const own = module.edges.find(
    (edge) => !edge.typeOnly && edge.resolution.capabilities.includes(capability),
  );
  if (own !== undefined) {
    return own.line;
  }
  for (const chain of reachableChains(module, graph.modules).values()) {
    const tail = chain[chain.length - 1];
    if (tail?.module.ownCapabilities.has(capability)) {
      const first = chain[1];
      return first === undefined
        ? 1
        : (module.edges.find((e) => !e.typeOnly && e.specifier === first.via)?.line ?? 1);
    }
  }
  return 1;
};

/**
 * Rule 10 — a browser module does not type-import a server package.
 *
 * TypeScript erases an `import type`, so this is not a reachability question; it is a
 * boundary question. The Drizzle schema is a private server entity: exporting it to
 * the browser's compile-time surface is how a page starts depending on the shape of a
 * table, and the first value import is then a small step rather than a large one.
 *
 * The portable package is not in this list, because a DTO *is* meant to cross. And
 * `src/app.d.ts` is not caught by it, because that is a role `ambient` declaration
 * file whose job is to declare `App.Locals`.
 */
const ruleServerTypeOnlyBoundary = (context: Context): void => {
  for (const module of context.graph.modules.values()) {
    if (module.plane !== 'browser' || UNCONSTRAINED_ROLES.includes(module.role)) {
      continue;
    }
    for (const edge of module.edges) {
      const split = splitPackage(edge.specifier);
      const forbidden =
        split !== null &&
        SERVER_TYPE_ONLY_FORBIDDEN_ROOTS.some(
          (root) => split.name === root || edge.specifier.startsWith(`${root}/`),
        );
      if (!forbidden) {
        continue;
      }
      const viaType = edge.typeOnly ? ' (type-only, and still refused)' : '';
      report(context, {
        rule: 'server-type-only',
        file: module.file,
        line: edge.line,
        message:
          `A browser module imports the server package '${edge.specifier}'${viaType}.\n` +
          '  The ORM schema is a private server entity; a browser that depends on its ' +
          'types is one value import away from bundling it.\n' +
          '  Publish the wire shape from @starter/schemas and import that instead.',
      });
    }
  }
};

/**
 * Rule 11 — the feature-local edges that must not exist.
 *
 * View -> ViewModel -> client service, one direction. A view that reaches a service
 * loses the state machine that made the screen testable; a service that reaches a
 * ViewModel holds state that outlives the screen. These are stated as forbidden edges
 * rather than as permitted ones so that a new presentation helper is not a violation
 * somebody deletes a row to silence.
 */
const ruleFeatureLayers = (context: Context): void => {
  for (const module of context.graph.modules.values()) {
    if (UNCONSTRAINED_ROLES.includes(module.role)) {
      continue;
    }
    for (const edge of module.edges) {
      if (edge.typeOnly) {
        continue;
      }
      const target = edge.resolution.file;
      if (target === undefined) {
        continue;
      }
      const reached = context.graph.modules.get(target);
      if (reached === undefined) {
        continue;
      }
      const forbidden = FORBIDDEN_ROLE_EDGES.find(
        (candidate) => candidate.from === module.role && candidate.to === reached.role,
      );
      if (forbidden === undefined) {
        continue;
      }
      report(context, {
        rule: 'feature-layer',
        file: module.file,
        line: edge.line,
        message:
          `A ${module.role} must not import a ${reached.role}.\n` +
          `  ${forbidden.reason}\n` +
          `  ${module.file}:${edge.line} imports '${edge.specifier}' -> ${reached.file}`,
      });
    }
  }
};

/**
 * Rule 12 — a test runner belongs in a test.
 *
 * Small and narrow on purpose. `bun:test` in a shipped module is not a style
 * preference; it is a module that cannot be part of a bundle. Test *harness*
 * configuration is `config`, which is the other role allowed here.
 */
const ruleTestRunnerPlacement = (context: Context): void => {
  for (const module of context.graph.modules.values()) {
    if (module.role === 'test' || module.role === 'config') {
      continue;
    }
    for (const edge of module.edges) {
      if (edge.typeOnly || !isTestRunnerSpecifier(edge.specifier)) {
        continue;
      }
      report(context, {
        rule: 'test-runner-placement',
        file: module.file,
        line: edge.line,
        message:
          `'${edge.specifier}' is a test runner, imported by a ${module.role}.\n` +
          '  A module that loads a test runner is not a module the application ships. ' +
          'Move the code into a test, or the dependency into devDependencies of a ' +
          'harness.',
      });
    }
  }
};

/**
 * Rule 13 — workspace packages do not form a cycle.
 *
 * A package cycle is not merely untidy: it cannot be built in dependency order, so it
 * is a fact about the build graph rather than a style. Reported at package level,
 * because that is the granularity `bun install` and the task graph both reason about,
 * and because a module-level cycle inside one package is a different question.
 */
const rulePackageCycles = (context: Context): void => {
  const edges = new Map<string, Set<string>>();
  for (const entry of context.graph.packages.values()) {
    edges.set(entry.name, new Set());
  }
  for (const module of context.graph.modules.values()) {
    const from = packageOfFile(context.graph, module.file);
    if (from === null) {
      continue;
    }
    const targets = edges.get(from.name);
    if (targets === undefined) {
      continue;
    }
    for (const edge of module.edges) {
      if (edge.typeOnly) {
        continue;
      }
      const to =
        edge.resolution.file === undefined
          ? null
          : packageOfFile(context.graph, edge.resolution.file);
      if (to !== null && to.name !== from.name) {
        targets.add(to.name);
      }
    }
  }

  const reported = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const walk = (name: string): void => {
    if (visiting.has(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name];
      const key = [...cycle].sort().join('>');
      if (reported.has(key)) {
        return;
      }
      reported.add(key);
      report(context, {
        rule: 'package-cycle',
        file: `${context.graph.packages.get(cycle[0] as string)?.dir ?? cycle[0] ?? '.'}/package.json`,
        line: 1,
        message:
          `Workspace packages form a dependency cycle: ${cycle.join(' -> ')}.\n` +
          '  A cycle cannot be built in dependency order, so it is a fact about the\n' +
          '  build graph rather than a matter of taste. Break it by moving the shared\n' +
          '  part into a package both sides may depend on.',
      });
      return;
    }
    if (visited.has(name)) {
      return;
    }
    visiting.add(name);
    path.push(name);
    for (const next of edges.get(name) ?? []) {
      walk(next);
    }
    path.pop();
    visiting.delete(name);
    visited.add(name);
  };

  for (const name of edges.keys()) {
    walk(name);
  }
};

/**
 * Rule 15 — a Node-only module inside a workspace package is declared, and its
 * declaration still resolves.
 *
 * Two halves, and the second is the one that matters.
 *
 * **Undeclared.** A module with the `node` plane inside a published package is either
 * one of `NODE_ONLY_MODULES` or a hole in the declaration. Both `@starter/utils/process`
 * and `@starter/logger/file` exist because a Node-only helper had to be reachable from
 * tooling and unreachable from a browser; the next one should have to say so, and a
 * table nobody checks is a table that grows by accident.
 *
 * **Unreachable.** Each declaration names the subpath that publishes it. If that
 * subpath is removed from `exports` — or stops pointing at the declared path — the
 * declaration has become a permanent exemption with no way in, and the guard says so
 * rather than continuing to honour it.
 */
const ruleNodeOnlySubpaths = (context: Context): void => {
  for (const declaration of NODE_ONLY_MODULES) {
    const manifest = context.graph.packages.get(declaration.packageName);
    if (manifest === undefined) {
      report(context, {
        rule: 'node-only-declaration',
        file: 'scripts/src/guards/policy.ts',
        line: 1,
        message:
          `NODE_ONLY_MODULES declares ${declaration.packageName}${declaration.subpath}, ` +
          `but ${declaration.packageName} is not a workspace package here.\n` +
          '  The declaration cannot be verified against a package that does not exist.',
      });
      continue;
    }

    const resolved = resolveWorkspaceSubpath(
      context.graph,
      declaration.packageName,
      declaration.subpath,
    );
    if (resolved === null) {
      report(context, {
        rule: 'node-only-declaration',
        file: `${manifest.dir}/package.json`,
        line: 1,
        message:
          `${declaration.packageName} no longer publishes '${declaration.subpath}', so the ` +
          `Node-only declaration for ${declaration.prefix} is unreachable.\n` +
          '  Either publish the subpath or delete the declaration. An unreachable ' +
          'declaration is an exemption with no way in, which is worse than none.',
      });
      continue;
    }

    if (!declaration.prefix.startsWith(resolved) && !resolved.startsWith(declaration.prefix)) {
      report(context, {
        rule: 'node-only-declaration',
        file: `${manifest.dir}/package.json`,
        line: 1,
        message:
          `${declaration.packageName}${declaration.subpath} resolves to ${resolved}, which is ` +
          `outside the declared Node-only path ${declaration.prefix}.\n` +
          '  The declaration and the exports map have drifted apart.',
      });
    }
  }

  for (const module of context.graph.modules.values()) {
    if (module.plane !== 'node') {
      continue;
    }
    const owner = packageOfFile(context.graph, module.file);
    if (owner === null || isDeclaredNodeOnly(module.file)) {
      continue;
    }
    // Only the portable core. `scripts/` and `.pi/` are Node tooling by nature, so a
    // `node` module there is the rule rather than an exception to it; the declaration
    // exists for a package whose promise is "loadable in a browser, in workerd and
    // under Bun", where a Node-only file is a hole in that promise.
    if (planeOf(`${owner.dir}/`) !== 'portable') {
      continue;
    }
    report(context, {
      rule: 'node-only-declaration',
      file: module.file,
      line: 1,
      message:
        `${owner.name} is the portable core and contains a Node-only module that is not ` +
        'declared in NODE_ONLY_MODULES.\n' +
        '  A Node-only helper inside a portable package must say which subpath ' +
        'publishes it.\n' +
        `  Add a row for ${module.file} with the subpath that reaches it.`,
    });
  }
};

/**
 * Rule 16 — a relative import may not leave its own workspace package.
 *
 * The gap this closes is a real one rather than a theoretical one. Rules 6 and 7 both
 * read a package's declarations, and both are written against *package* specifiers, so
 * `import { resolveBrowser } from '../../scripts/src/shared/browser_path.ts'` skipped
 * both of them at once: it is not a package name, so neither the `exports` map nor the
 * dependency list was consulted. It resolved, it typechecked, and it kept resolving
 * after the file it pointed at moved — which is the moment a declaration should have
 * started refusing to be ignored.
 *
 * The rule is stated over *runtime* edges, and that is a deliberate boundary rather
 * than a gap. An `import type` from another workspace is erased by TypeScript, so it
 * cannot put a module into a bundle and cannot carry a Node requirement into a
 * browser. What it does is tie one workspace's compile-time surface to another's file
 * layout, and that question already has an owner: `ruleServerTypeOnlyBoundary` refuses
 * a browser module naming a server package, even type-only.
 *
 * Within one package a relative import is how modules are written, so the rule is
 * about the *boundary*, not about relative paths: `src/lib/features/notes/../utils/…`
 * inside the same package is invisible here and fully checked by every other rule.
 */
const ruleCrossWorkspaceRelativeImports = (context: Context): void => {
  for (const module of context.graph.modules.values()) {
    const from = workspaceDirOf(context.graph, module.file);
    for (const edge of module.edges) {
      if (edge.typeOnly || !edge.specifier.startsWith('.')) {
        continue;
      }
      const target = edge.resolution.file;
      if (target === undefined) {
        // A generated module (`./$types`) or an unresolved one. Both are other rules'
        // answers, and reporting a bypass for an edge with no resolved target would be
        // reporting something the graph never established.
        continue;
      }
      const reached = context.graph.modules.get(target);
      if (reached === undefined) {
        continue;
      }
      const to = workspaceDirOf(context.graph, target);
      if (to === from || isRelativeImportExempt(from, to)) {
        continue;
      }
      report(context, {
        rule: 'cross-workspace-relative-import',
        file: module.file,
        line: edge.line,
        message:
          `A relative import leaves ${from} and reaches ${to} by file path, which is ` +
          'past both of the declarations that edge was supposed to go through.\n' +
          `  Chain: ${renderChain([
            { module, via: undefined },
            { module: reached, via: edge.specifier },
          ])}\n` +
          `  ${from} does not publish ${to}'s internals, and ${from}/package.json does ` +
          `not declare it as a dependency.\n` +
          `  Remedy: export the module from ${to}'s package.json \`exports\` map, add ` +
          `${to} to ${from}/package.json, and import it by package name.\n` +
          '  A path into another workspace is how a deep import becomes permanent: it ' +
          'keeps resolving after the file moves, which is exactly when the boundary ' +
          'should start refusing.',
      });
    }
  }
};

/**
 * Rule 17 — every declared relative-import exemption still matches an edge.
 *
 * The other half, and the one that keeps the table honest. An exemption nobody uses is
 * a permission that outlived its reason, and the next one is added beside it. This is
 * the same shape as `ruleNodeOnlySubpaths`' unreachable-declaration half, applied for
 * the same reason: an exemption with no way in is worse than none.
 */
const ruleRelativeImportExemptionsAreUsed = (context: Context): void => {
  const used = new Set<string>();

  for (const module of context.graph.modules.values()) {
    const from = workspaceDirOf(context.graph, module.file);
    for (const edge of module.edges) {
      if (edge.typeOnly || !edge.specifier.startsWith('.')) {
        continue;
      }
      const target = edge.resolution.file;
      if (target === undefined) {
        continue;
      }
      const to = workspaceDirOf(context.graph, target);
      if (to !== from) {
        used.add(exemptionKey(from, to));
      }
    }
  }

  // A tree that does not contain the importing workspace at all — every fixture but
  // one, and a partial checkout — cannot invalidate a pair. Reporting it there would
  // make the rule assert something about a repository it is not looking at.
  const workspaces = new Set(context.graph.packages.values());
  const declares = (dir: string): boolean =>
    [...workspaces].some((entry) => entry.dir === dir) ||
    [...context.graph.modules.keys()].some((file) => file.startsWith(`${dir}/`));

  for (const exemption of CROSS_WORKSPACE_RELATIVE_EXEMPTIONS) {
    if (used.has(exemptionKey(exemption.from, exemption.to))) {
      continue;
    }
    if (!declares(exemption.from)) {
      continue;
    }
    report(context, {
      rule: 'stale-relative-import-exemption',
      file: 'scripts/src/guards/policy.ts',
      line: 1,
      message:
        `CROSS_WORKSPACE_RELATIVE_EXEMPTIONS permits ${exemption.from} -> ` +
        `${exemption.to}, and no import in this tree does that any more.\n` +
        `  Declared reason: ${exemption.reason}\n` +
        '  Delete the row. An exemption nobody uses is a permission that outlived the\n' +
        '  reason it was written for, and it is where the next blanket one grows.',
    });
  }
};

/**
 * Rule 18 — the graph is not empty.
 *
 * A guard that finds nothing has not proved anything. If the discovery walk returned
 * no modules at all, either the root is wrong or every placement row is wrong, and
 * both are failures a reader needs told about rather than a clean report they will
 * believe.
 */
const ruleGraphNotEmpty = (context: Context): void => {
  if (context.graph.modules.size > 0) {
    return;
  }
  report(context, {
    rule: 'empty-graph',
    file: '.',
    line: 1,
    message:
      'The guard found no source files at all, so no rule above was evaluated.\n' +
      '  This is reported rather than passed: a boundary guard that checked nothing is\n' +
      '  indistinguishable from a boundary guard that found nothing wrong.',
  });
};

/**
 * The architecture guard.
 *
 * Runs every rule over the resolved graph. Deliberately uncached: the cost is a
 * second-scale parse of the repository's own sources, and this is the check people
 * trust immediately before merging.
 */
export const guardArchitecture = (root: string): GuardResult => {
  const graph = buildModuleGraph(root);
  const context: Context = { graph, violations: [] };

  ruleGraphNotEmpty(context);
  ruleUnclassified(context);
  ruleReadable(context);
  ruleResolves(context);
  ruleNonLiteralDynamicImport(context);
  ruleFrameworkRootsExist(context);
  rulePackageExports(context);
  ruleDeclaredDependencies(context);
  rulePlaneReachability(context);
  ruleRuntimeCapabilities(context);
  ruleServerTypeOnlyBoundary(context);
  ruleFeatureLayers(context);
  ruleTestRunnerPlacement(context);
  rulePackageCycles(context);
  ruleNodeOnlySubpaths(context);
  ruleCrossWorkspaceRelativeImports(context);
  ruleRelativeImportExemptionsAreUsed(context);

  return {
    id: 'architecture',
    label: 'Resolved architecture boundaries',
    baselineCount: 0,
    violations: context.violations,
  };
};
