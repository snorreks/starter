// scripts/src/guards/policy.ts
//
// The architecture, written down as data.
//
// Every entry here is a claim about where code runs and who owns it. The guard in
// `guard_architecture.ts` resolves the real module graph and asks this file
// whether the edges in it are permitted. Keeping the two apart is what lets a
// reviewer check the policy by reading it instead of by reading a parser.
//
// Three properties are deliberate and each of them has a failure it prevents:
//
//   * **The policy is a table, not a set of name patterns.** `PLACEMENTS` maps a
//     repository path to exactly one (plane, role) pair. A file the table does not
//     cover is a violation, not a pass — an unclassified source file is a hole in
//     the policy, and a policy with silent holes is not one.
//   * **Nothing is allowed by default.** `MAY_REACH` lists what each plane may
//     reach; the reverse direction is a violation. There is no allowlist to grow,
//     and therefore nowhere for a new package name to be waved through.
//   * **Every row carries its reason.** A guard message that cannot say where the
//     code should go is a complaint, not a fix.

/**
 * Where a module runs.
 *
 * `portable` is a real runtime obligation, not a synonym for "a library": it means
 * the module must load unchanged in a browser, in workerd and under Bun. The other
 * three name one of those three places.
 */
export type Plane = 'browser' | 'worker' | 'node' | 'portable';

/**
 * What a module is inside the feature-local View -> ViewModel -> service chain.
 *
 * The role decides which feature-local edges are permitted. It is not a naming
 * convention check: it is the answer to "what is this file's job", and the guard
 * uses it to refuse the inversions the architecture forbids.
 */
export type Role =
  /** A declaration file. It contributes no edge — see `UNCONSTRAINED_ROLES`. */
  | 'ambient'
  /** A page under `src/routes/`: composition that builds a screen. */
  | 'route-view'
  /** `+server.ts`, `+*.server.ts`, `hooks.server.ts`: a thin HTTP/load adapter. */
  | 'route-server'
  /** `src/lib/server/**`: authorization and persistence. */
  | 'server-module'
  /** A feature component: presentation and raised intents. */
  | 'view'
  /** Screen state and the commands a view raises. */
  | 'view-model'
  /** Transport and browser I/O. */
  | 'service'
  /** Wiring that constructs the above. */
  | 'composition'
  /** Anything else inside a known tree. */
  | 'module'
  /** Build, bundler and test-runner configuration. */
  | 'config'
  /** A test, or the harness it loads. */
  | 'test';

/**
 * Workspace modules that are Node-only *by declaration*.
 *
 * `packages/shared` is the portable core, and these two files are inside it. They are
 * not portable, and pretending otherwise would make the portable promise false in two
 * of its three runtimes — so they are declared `node` here, and each is reachable only
 * through a published subpath whose whole meaning is "the caller is not a browser":
 *
 *   `@starter/utils/process` — subprocess handling. `@starter/utils` is linked into the
 *   browser bundle, so a barrel export of this would break every browser build.
 *
 *   `@starter/logger/file` — an NDJSON file sink. A browser cannot write a local file;
 *   browser events reach the log file through `POST /api/telemetry` and the Worker.
 *
 * Two rows, each naming the subpath that publishes it, and `ruleNodeOnlySubpaths`
 * checks that the subpath still exists and still points here. That check is what makes
 * this a declaration rather than a permanent exemption: delete the subpath from
 * `exports` and the guard reports that the declaration is now unreachable.
 *
 * The direction that matters is still enforced. `node` may be reached by `node`; a
 * browser or the Worker reaching either of these is a violation, which is what
 * `runtime-capability` catches through the transitive capability.
 */
export const NODE_ONLY_MODULES: readonly {
  readonly prefix: string;
  readonly packageName: string;
  readonly subpath: string;
  readonly reason: string;
}[] = [
  {
    prefix: 'packages/shared/utils/src/lib/process/',
    packageName: '@starter/utils',
    subpath: './process',
    reason:
      'Subprocess handling. Importing the subpath is the assertion that the caller is not a browser.',
  },
  {
    prefix: 'packages/shared/logger/src/lib/file_sink.ts',
    packageName: '@starter/logger',
    subpath: './file',
    reason: 'A local NDJSON file sink. A browser cannot write a file, so it is Node-side only.',
  },
];

export const isDeclaredNodeOnly = (relativePath: string): boolean =>
  NODE_ONLY_MODULES.some((entry) => relativePath.startsWith(entry.prefix));

/** Escape a literal path fragment for use inside a `RegExp`. */
const escapeForRegExp = (literal: string): string => literal.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

/**
 * The one-way dependency rule.
 *
 * Four planes and one matrix. Read down each column to see what a plane may pull
 * in; every absent entry is a violation.
 *
 *   portable -> portable    a shared package is loadable everywhere or nowhere
 *   browser  -> portable, browser
 *   worker   -> portable, worker
 *   node     -> portable, node
 *
 * `node -> worker` is absent on purpose: `scripts/` and `.pi/` run outside both
 * application planes, and a CLI that imports the Worker half makes the two
 * impossible to build, test and reason about separately. `node -> browser` is absent
 * for the same reason.
 */
export const MAY_REACH: Record<Plane, readonly Plane[]> = {
  portable: ['portable'],
  browser: ['portable', 'browser'],
  worker: ['portable', 'worker'],
  node: ['portable', 'node'],
};

export const mayReach = (from: Plane, to: Plane): boolean => MAY_REACH[from].includes(to);

/**
 * Roles whose edges the guard does not check for plane reachability.
 *
 * Two entries, each with a reason that is a property of the file rather than a
 * concession:
 *
 *   - `ambient` is a `.d.ts`. It contains no emitted code, so it cannot put a
 *     server module in a browser bundle. `src/app.d.ts` must name `Container` to
 *     declare `App.Locals`, which is the framework's own type channel.
 *   - `test` asserts on the module it tests and runs in the tool runtime. A test
 *     never reaches a shipped bundle, so constraining its edges would constrain
 *     nothing except the ability to test a server module from a browser-half test.
 *     Its *syntax*, its *resolution* and its *package declarations* are still
 *     checked; only runtime reachability is not.
 */
export const UNCONSTRAINED_ROLES: readonly Role[] = ['ambient', 'test'];

/**
 * A runtime fact a module needs, inferred from the specifiers it reaches.
 *
 * A capability is not a plane: it is what a dependency *does*. `@starter/database`
 * is a first-party module and the guard knows which plane owns it, but `drizzle-orm`
 * is a third-party package and nothing in the repository says whether it runs in
 * workerd. These four rows are that statement, and they exist only because an
 * external package cannot be classified by a directory it does not live in.
 *
 * Every row is matched on a prefix, so a subpath such as `drizzle-orm/d1` is
 * covered by the `drizzle-orm` row.
 */
export interface CapabilityRule {
  readonly capability: Capability;
  /** The package or scheme root. A subpath of it inherits the capability. */
  readonly root: string;
  readonly reason: string;
}

export type Capability = 'node-runtime' | 'bun-runtime' | 'worker-runtime' | 'dom-runtime';

export const CAPABILITY_RULES: readonly CapabilityRule[] = [
  {
    capability: 'node-runtime',
    root: 'node:',
    reason: 'Node built-ins do not exist in a browser or in workerd.',
  },
  {
    capability: 'node-runtime',
    root: 'bun:',
    reason: 'Bun built-ins exist only under the Bun runtime.',
  },
  {
    capability: 'worker-runtime',
    root: 'cloudflare:',
    reason: 'Workers platform bindings are provided by the adapter at run time.',
  },
  {
    capability: 'worker-runtime',
    root: 'workerd:',
    reason: 'workerd-internal modules exist only inside the Worker.',
  },
  {
    capability: 'worker-runtime',
    root: 'drizzle-orm',
    reason:
      'The Drizzle runtime opens a database binding and speaks the driver protocol. ' +
      'It is the database implementation, not a contract.',
  },
  {
    capability: 'worker-runtime',
    root: 'better-auth',
    reason:
      'Better Auth owns sessions, password hashing and the database adapter. ' +
      'It is the auth implementation, not a contract.',
  },
  {
    capability: 'dom-runtime',
    root: 'svelte/internal',
    reason: "Svelte's client runtime compiles against a DOM that workerd does not have.",
  },
  {
    capability: 'dom-runtime',
    root: 'svelte/reactivity',
    reason: "Svelte's client runtime compiles against a DOM that workerd does not have.",
  },
];

/** Capabilities each plane may hold. Absent entries are violations. */
export const PLANE_CAPABILITIES: Record<Plane, readonly Capability[]> = {
  // Nothing: the reason `packages/shared` exists. A portable module that opens a
  // file, a socket or a database handle is dead code in two of its three runtimes.
  portable: [],
  browser: ['dom-runtime'],
  worker: ['worker-runtime'],
  node: ['node-runtime', 'bun-runtime'],
};

export const planeMayUse = (plane: Plane, capability: Capability): boolean =>
  PLANE_CAPABILITIES[plane].includes(capability);

/**
 * Test runners and their configuration, which are legal only in a test or a config
 * module.
 *
 * Separate from `CAPABILITY_RULES` on purpose. `bun:test` is not a "server library"
 * and forbidding it outside tests would be a statement about test style, not about
 * architecture; forbidding it in a *shipped* module is a statement that the module
 * cannot be a shipped module.
 */
export const TEST_RUNNER_ROOTS: readonly string[] = [
  'bun:test',
  'node:test',
  'vitest',
  '@vitest/',
  '@playwright/test',
  'playwright',
  '@cloudflare/vitest-pool-workers',
];

export const isTestRunnerSpecifier = (specifier: string): boolean =>
  TEST_RUNNER_ROOTS.some((root) => specifier === root || specifier.startsWith(root));

/**
 * The feature-local edges that are forbidden, with the reason each is forbidden.
 *
 * A positive statement of what is not allowed, which is why this is a list of four
 * rows rather than an enumeration of permitted ones: an enumeration would have to
 * name every presentation helper, and the next one added would be a violation
 * somebody deletes the row for.
 */
export interface ForbiddenRoleEdge {
  readonly from: Role;
  readonly to: Role;
  readonly reason: string;
}

export const FORBIDDEN_ROLE_EDGES: readonly ForbiddenRoleEdge[] = [
  {
    from: 'view',
    to: 'service',
    reason:
      'A view renders and raises intents. Transport and browser I/O belong to a ' +
      'ViewModel, so a component cannot be tested without the network and a ' +
      'screen cannot show a state the ViewModel does not know about.',
  },
  {
    from: 'service',
    to: 'view',
    reason:
      'A service is called by a ViewModel and returns data. A view imported by one ' +
      'makes the data layer decide about presentation.',
  },
  {
    from: 'service',
    to: 'view-model',
    reason:
      'Screen state belongs to the ViewModel. A service that imports one is holding ' +
      'state that outlives the screen.',
  },
  {
    from: 'route-server',
    to: 'route-view',
    reason:
      'A load or an endpoint returns data. It never renders, and rendering in a ' +
      'route adapter means Svelte client runtime inside the Worker.',
  },
  {
    from: 'route-server',
    to: 'view-model',
    reason:
      'A load returns serializable DTOs. A ViewModel is screen state built by the ' +
      'page, and serializing one into page data is exactly the leak the DTO rule ' +
      'exists to prevent.',
  },
];

/**
 * Server-owned types a browser module may not import even as `import type`.
 *
 * TypeScript erases a type-only import, so it cannot put a server module in a
 * bundle. It is still a dependency: it ties the browser's compile-time surface to a
 * private server entity, and the moment someone adds one value import the leak is
 * already written. `docs/architecture.md` calls this out, and it is one row here so
 * the rule has one place to be read and one place to be changed.
 *
 * The first-party equivalent — `src/lib/server/**` — is *not* here, because
 * `src/app.d.ts` legitimately names `Container` to declare `App.Locals`, and
 * declaration files are role `ambient`.
 */
export const SERVER_TYPE_ONLY_FORBIDDEN_ROOTS: readonly string[] = [
  '@starter/database',
  '@starter/auth',
];

/**
 * Workspace package prefixes whose ownership the guard resolves itself.
 *
 * Every workspace package is discovered from the root `package.json` `workspaces`
 * globs, so a newly added package is classified the moment it exists — which is
 * what makes "a new package with an illegal edge" a violation with a real message
 * rather than a gap.
 */
export const WORKSPACE_PACKAGE_SCOPE = '@starter/';

/**
 * Path -> plane, most specific first.
 *
 * Prefix matching handles the directory boundaries; the two route-adapter shapes
 * are written as patterns because they are file shapes rather than directories.
 * Both live here rather than in a second table so a route adapter cannot be one
 * plane in one place and another role in the other.
 *
 * Two entries carry the load of the whole design:
 *
 *   - `apps/frontend/client/src/lib/server/**` and the route adapter shapes are
 *     `worker`; the rest of `src/**` is `browser`. One directory, two runtimes,
 *     and the boundary is a path.
 *   - `packages/shared/**` is `portable`, which means it is not "a library" — it is
 *     a promise that the module loads in a browser, in workerd and under Bun. The
 *     capability rules above are how that promise is kept.
 */
export const PLANE_PLACEMENTS: readonly { readonly test: RegExp; readonly plane: Plane }[] = [
  // The application's Worker half: its server-only area and the three route adapter
  // shapes SvelteKit itself compiles into the Worker.
  { test: /^apps\/frontend\/client\/src\/lib\/server\//, plane: 'worker' },
  { test: /^apps\/frontend\/client\/src\/hooks\.server\.ts$/, plane: 'worker' },
  {
    test: /^apps\/frontend\/client\/src\/routes\/(?:.*\/)?\+(?:server|page\.server|layout\.server)\.ts$/,
    plane: 'worker',
  },
  // The browser half of the same package. A `+page.svelte` is deliberately *not*
  // matched above, so the components beside a `+page.server.ts` keep the browser
  // permission set.
  { test: /^apps\/frontend\/client\/src\//, plane: 'browser' },
  // Everything else in the app — vite.config.ts, dev_ports.ts, scripts/, tests/ —
  // is build tooling, which runs on Node.
  { test: /^apps\/frontend\/client\//, plane: 'node' },
  { test: /^apps\/e2e\//, plane: 'node' },
  // Declared Node-only modules inside the portable core. Before `packages/shared`, so
  // the declaration wins over the package's own plane — see NODE_ONLY_MODULES for why
  // these two are the only such rows.
  ...NODE_ONLY_MODULES.map((entry): { test: RegExp; plane: Plane } => ({
    // The prefix is escaped rather than interpolated raw. The escaping itself is a
    // plain string, not a template literal, because `${}` inside a regex character
    // class opens an interpolation — which is a syntax error, and one that only appears
    // once a row exists to trigger it.
    test: new RegExp(`^${escapeForRegExp(entry.prefix)}`),
    plane: 'node',
  })),
  { test: /^packages\/shared\//, plane: 'portable' },
  { test: /^packages\/backend\//, plane: 'worker' },
  { test: /^packages\/frontend\//, plane: 'browser' },
  { test: /^scripts\//, plane: 'node' },
  { test: /^\.pi\//, plane: 'node' },
];

export const planeOf = (relativePath: string): Plane | null =>
  PLANE_PLACEMENTS.find((entry) => entry.test.test(relativePath))?.plane ?? null;

/**
 * Path -> role, most specific first.
 *
 * Role is what the feature-local rules in `FORBIDDEN_ROLE_EDGES` are expressed in.
 * It is derived from the repository's own naming, because that is where the
 * architecture put the distinction: `*_view_model*`, `*_service*`, `*_composition*`
 * and `*.svelte` in a feature directory are what "View -> ViewModel -> service"
 * looks like on disk.
 *
 * The name is a *convention*, and it is stated as one. What the guard claims about
 * it is narrow and is exactly what these rules need: that a module named for a
 * screen is the screen's state. It makes no claim about what such a module does at
 * run time — that is owned by behaviour tests, not by this file.
 */
export const ROLE_PLACEMENTS: readonly { readonly test: RegExp; readonly role: Role }[] = [
  // A declaration file contributes no edge at all.
  { test: /\.d\.ts$/, role: 'ambient' },
  { test: /\.(test|spec)\.tsx?$/, role: 'test' },
  { test: /(?:^|\/)(?:tests|__tests__|browser_tests)\//, role: 'test' },
  // Test harnesses that are not named like tests: the Bun preload, the Playwright
  // global setup, the per-lane setup module.
  { test: /^apps\/frontend\/client\/src\/lib\/test_setup\.ts$/, role: 'test' },
  { test: /^apps\/e2e\/global-setup\.ts$/, role: 'test' },
  // Bundler, test-runner and build configuration.
  { test: /(?:^|\/)[\w.-]+\.config\.tsx?$/, role: 'config' },

  // The application's route plane. These three shapes are what SvelteKit itself
  // compiles into the Worker, which is why they are `worker` rather than `browser`.
  { test: /^apps\/frontend\/client\/src\/hooks\.server\.ts$/, role: 'route-server' },
  {
    test: /^apps\/frontend\/client\/src\/routes\/(?:.*\/)?\+(?:server|page\.server|layout\.server)\.ts$/,
    role: 'route-server',
  },
  { test: /^apps\/frontend\/client\/src\/routes\/.+\.svelte$/, role: 'route-view' },
  { test: /^apps\/frontend\/client\/src\/lib\/server\//, role: 'server-module' },

  // Feature-local layers, decided inside a feature directory.
  { test: /^apps\/frontend\/client\/src\/lib\/features\/.+\.svelte$/, role: 'view' },
  { test: /^apps\/frontend\/client\/src\/lib\/features\/.+view_model.+$/, role: 'view-model' },
  { test: /^apps\/frontend\/client\/src\/lib\/features\/.+service.+$/, role: 'service' },
  { test: /^apps\/frontend\/client\/src\/lib\/features\/.+composition.+$/, role: 'composition' },
  { test: /^apps\/frontend\/client\/src\/lib\/features\//, role: 'module' },
  // Client transport and browser I/O outside any feature.
  { test: /^apps\/frontend\/client\/src\/lib\/services\//, role: 'service' },
  { test: /^apps\/frontend\/client\/src\/lib\//, role: 'module' },
  { test: /^apps\/frontend\/client\/src\//, role: 'module' },

  // `apps/e2e` is a test harness in its entirety: there is no application code in it.
  // Stated as one rule rather than a list of filenames, because a new helper there is
  // a helper for the harness too.
  { test: /^apps\/e2e\//, role: 'test' },

  // Tooling, packages and agent extensions carry no feature role.
  { test: /^apps\//, role: 'module' },
  { test: /^packages\//, role: 'module' },
  { test: /^scripts\//, role: 'module' },
  { test: /^\.pi\//, role: 'module' },
];

export const roleOf = (relativePath: string): Role | null =>
  ROLE_PLACEMENTS.find((entry) => entry.test.test(relativePath))?.role ?? null;

/**
 * Where code that breaks each boundary belongs.
 *
 * Printed with the violation. "Fix the import" is not an instruction; "this belongs
 * in the Worker half, reached through a route adapter" is.
 */
export const PLANE_OWNERS: Record<Plane, string> = {
  portable: 'packages/shared/* — and it must stay loadable in a browser, in workerd and under Bun',
  browser:
    'apps/frontend/client/src/** (excluding src/lib/server/** and the route adapter ' +
    'shapes), packages/frontend/*, or packages/shared/* for a portable contract',
  worker:
    'apps/frontend/client/src/lib/server/** or a route adapter (+server.ts, ' +
    '+page.server.ts, +layout.server.ts, hooks.server.ts), packages/backend/*',
  node: 'scripts/** or .pi/** — code that runs outside both application planes',
};

export const describeAllowed = (plane: Plane): string => MAY_REACH[plane].join(', ');
