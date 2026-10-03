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
  /**
   * The native application's bridge to the shell: the one place a `@tauri-apps/*`
   * dependency may appear.
   *
   * A role rather than a capability allowance, because a capability allowance would
   * be a statement about the *whole browser plane*, and that is exactly the blanket
   * permission this round refused. A static SvelteKit bundle and the web app run the
   * same JavaScript in different hosts; only the composition root of the native app
   * is guaranteed to have the Tauri API object, so only it may name it.
   */
  | 'native-bridge'
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

export type Capability =
  | 'node-runtime'
  | 'bun-runtime'
  | 'worker-runtime'
  | 'dom-runtime'
  | 'native-runtime';

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
  {
    capability: 'native-runtime',
    root: '@tauri-apps',
    reason:
      'The Tauri API object is injected by the native shell into the webview. A web ' +
      'page has no such object, so this dependency does not resolve at all there.',
  },
];

/**
 * Capabilities that a *role* holds rather than a plane holding them.
 *
 * `PLANE_CAPABILITIES` answers "which runtimes provide this", and that is the right
 * question for Node, Bun, workerd and a DOM. It is the wrong question for the Tauri
 * bridge, because the thing that provides the API is not a runtime — it is one
 * composition root inside a browser-plane application, and the rest of that
 * application is served as ordinary static files to browsers that will crash on the
 * same import.
 *
 * So this table overrides the plane check for the capabilities it names: the module's
 * role is checked instead. A row here is an assertion that the capability is confined
 * to a named, explicitly placed set of files, which is what makes it different from
 * adding the capability to `PLANE_CAPABILITIES` and calling it done.
 */
export const CAPABILITY_ROLES: Readonly<Partial<Record<Capability, readonly Role[]>>> = {
  'native-runtime': ['native-bridge'],
};

/** The roles a capability is confined to, or `undefined` when it is a plane's to hold. */
export const capabilityRoles = (capability: Capability): readonly Role[] | undefined =>
  CAPABILITY_ROLES[capability];

/**
 * The trees this repository generates rather than writes, with the reason each is one.
 *
 * Two different jobs are done with this list, and both fail silently if it is missing:
 *
 *   - Discovery skips them, so a generated directory is not mistaken for a project
 *     that owes a hand-maintained README, and a `.ts` file a generator emitted is not
 *     reported as an unclassified source file.
 *   - A reviewer reading a diagnostic can tell a path nobody edits from a path
 *     somebody forgot.
 *
 * Patterns are repository-relative and match whole path segments. Anything that is
 * *vendored* rather than generated (`node_modules`) is here for the same reason and
 * the same cost: neither is a place a person maintains code.
 *
 * One build directory is deliberately **not** in this table, because a bare name is
 * not enough to tell output from source: a package may legitimately keep code in
 * `src/vendor/` or a directory called `target/`, and silently dropping it from the
 * graph and from discovery is precisely the failure this table exists to prevent. A
 * Cargo target directory is recognised by the `Cargo.toml` beside it instead, which
 * is a fact about the filesystem rather than about the spelling — see
 * `isCargoBuildDirectory` in `module_graph.ts`, the one predicate both walkers
 * share. `src-tauri/target` is still named below, because that layout is fixed by
 * the Tauri CLI and does not depend on inferring it.
 *
 * Rust is absent by construction rather than by pattern. `SOURCE_EXTENSIONS` is
 * `.ts`, `.tsx` and `.svelte`, so no `.rs` file is ever parsed as TypeScript — Rust is
 * validated by `cargo check`/`cargo test` in its own lanes, and a guard that parsed it
 * would be a second, weaker answer to a question the compiler already answers.
 */
export const GENERATED_TREES: readonly { readonly test: RegExp; readonly reason: string }[] = [
  {
    test: /(^|\/)node_modules(\/|$)/,
    reason: 'Installed dependencies. Vendored, not maintained here.',
  },
  {
    test: /(^|\/)\.moon\/cache(\/|$)/,
    reason: 'Moon writes task hashes and outputs; it creates the directory on first run.',
  },
  {
    test: /(^|\/)\.svelte-kit(\/|$)/,
    reason: 'Generated by `svelte-kit sync`; absent in a fresh checkout.',
  },
  { test: /(^|\/)build(\/|$)/, reason: 'Compiler output.' },
  { test: /(^|\/)dist(\/|$)/, reason: 'Bundler output.' },
  { test: /(^|\/)coverage(\/|$)/, reason: 'Coverage report output.' },
  { test: /(^|\/)test-results(\/|$)/, reason: 'Playwright run output.' },
  { test: /(^|\/)playwright-report(\/|$)/, reason: 'Playwright run output.' },
  { test: /(^|\/)\.wrangler(\/|$)/, reason: 'Wrangler local state.' },
  { test: /(^|\/)state(\/|$)/, reason: 'Wrangler local state.' },
  { test: /(^|\/)\.direnv(\/|$)/, reason: 'direnv cache.' },
  {
    test: /(^|\/)src-tauri\/target(\/|$)/,
    reason:
      'Cargo build output for the Tauri shell, named by its fixed layout rather than ' +
      'inferred from a neighbouring manifest.',
  },
  {
    test: /(^|\/)src-tauri\/(?:gen|gen-schemas|vendor)(\/|$)/,
    reason:
      'Tauri regenerates the Android and Xcode projects from `tauri.conf.json` and ' +
      '`Cargo.toml`, and `tauri vendor` writes the crates it embeds. They are build ' +
      'products of the shell, and the shell owns their documentation.',
  },
];

const GENERATED_TREES_COMPILED: readonly RegExp[] = GENERATED_TREES.map((entry) => entry.test);

/** Is this repository-relative path inside a generated or vendored tree? */
export const isGeneratedPath = (relativePath: string): boolean =>
  GENERATED_TREES_COMPILED.some((test) => test.test(relativePath));

/**
 * Directory names Cargo writes its build output into.
 *
 * A name, not a path, because the path is what this rule must *not* decide on: a
 * package may own a directory called `target` or `vendor`, and those are source. The
 * name alone identifies a candidate; the manifest beside it is what confirms it.
 */
export const CARGO_BUILD_DIRECTORY_NAMES: readonly string[] = ['target'];

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
  // The static native application and the scheduled jobs Worker. Named individually
  // rather than covered by `^apps/` or `^apps/backend/`, because a blanket prefix is
  // how a new application under one of these roots would be classified without anybody
  // deciding what it is: `apps/backend/analytics` must be refused as unclassified until
  // someone says what runtime it has.
  { test: /^apps\/frontend\/native\/src\/lib\/platform\//, plane: 'browser' },
  { test: /^apps\/frontend\/native\/src\//, plane: 'browser' },
  // Everything else in the native app — `src-tauri/`, its scripts, its tests — is
  // tooling that runs on Node. The Rust inside it is never parsed; see GENERATED_TREES.
  { test: /^apps\/frontend\/native\//, plane: 'node' },
  { test: /^apps\/backend\/jobs\//, plane: 'worker' },
  { test: /^packages\/shared\//, plane: 'portable' },
  { test: /^packages\/backend\//, plane: 'worker' },
  // `packages/frontend/*` is browser code, and the two shared packages added this
  // round keep that plane for a stated reason: their contract is a view, a ViewModel
  // and a transport a browser half consumes. They are portable in the sense of "two
  // hosts", not in the sense of `packages/shared`, which promises workerd as well.
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

  // The static native application. Its routes are composition like the web app's, and
  // the whole of `src/lib/platform/**` is the bridge to the Tauri shell — the only
  // place `@tauri-apps/*` may be named (see CAPABILITY_ROLES).
  { test: /^apps\/frontend\/native\/src\/routes\/.+\.svelte$/, role: 'route-view' },
  { test: /^apps\/frontend\/native\/src\/lib\/platform\//, role: 'native-bridge' },
  { test: /^apps\/frontend\/native\/src\/lib\//, role: 'module' },
  { test: /^apps\/frontend\/native\//, role: 'module' },
  // The scheduled jobs Worker has no SvelteKit route plane; every module in it is
  // worker code reached through a binding.
  { test: /^apps\/backend\/jobs\//, role: 'module' },

  // The shared feature package carries the same View -> ViewModel -> service layers as
  // the web app's own `src/lib/features/**`, in a package instead of an application.
  // The rules are shared as one pattern so a file cannot be a View in one app and a
  // plain module in the other.
  { test: /^packages\/frontend\/features\/.+\.svelte$/, role: 'view' },
  { test: /^packages\/frontend\/features\/.+view_model.+$/, role: 'view-model' },
  { test: /^packages\/frontend\/features\/.+service.+$/, role: 'service' },
  { test: /^packages\/frontend\/features\/.+composition.+$/, role: 'composition' },
  { test: /^packages\/frontend\/features\//, role: 'module' },
  // Contracts and injected transports. No component and no screen state, so no
  // feature role applies and none is claimed.
  { test: /^packages\/frontend\/platform\//, role: 'module' },

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
    'shapes), apps/frontend/native/src/**, packages/frontend/*, or packages/shared/* ' +
    'for a portable contract',
  worker:
    'apps/frontend/client/src/lib/server/** or a route adapter (+server.ts, ' +
    '+page.server.ts, +layout.server.ts, hooks.server.ts), apps/backend/jobs/**, ' +
    'packages/backend/*',
  node: 'scripts/** or .pi/** — code that runs outside both application planes',
};

export const describeAllowed = (plane: Plane): string => MAY_REACH[plane].join(', ');

/**
 * Cross-workspace relative imports the architecture permits, each with its reason.
 *
 * A relative path that leaves its own workspace package skips two declarations at once:
 * the package's `exports` map and its dependency list. `rulePackageExports` and
 * `ruleDeclaredDependencies` both check those declarations, and both are written
 * against package specifiers — so a `../../scripts/src/shared/paths.ts` passed every
 * rule in this file. It resolves today, it keeps resolving after the file moves, and
 * the `exports` map stops meaning anything for that edge.
 *
 * The remedy is always the same: publish the subpath the importer needs, declare the
 * dependency, and import it by name. So the exemptions below are pairs of
 * *workspaces*, not patterns of paths, and each has to keep naming a real reason:
 *
 *   - `apps/e2e` -> `scripts`. The Playwright harness, its global setup and its config
 *     run in the same Bun process as the tooling they configure and assert about.
 *     Importing the module directly is what makes the harness test the *real* path
 *     resolution and port allocation instead of a copy of it. Nothing here is shipped:
 *     the harness is role `test`/`config`, so no bundle can contain it.
 *   - `apps/frontend/client` -> `scripts`. Its Vitest config, which runs in Node
 *     before any application code is loaded and therefore cannot use a browser
 *     dependency to find the executable.
 *
 * Two properties keep this from becoming a hole:
 *
 *   1. Each pair is *narrowed by the plane rules above*, not by this list. A shipped
 *      browser module in `apps/frontend/client` reaching `scripts/` is already a
 *      `plane-reachability` violation, so nothing unsafe is granted here.
 *   2. `ruleRelativeImportExemptionsAreUsed` reports a row that no longer matches any
 *      edge, the same way `ruleNodeOnlySubpaths` reports an unreachable declaration.
 *      An exemption nobody uses is dead policy, and dead policy is where the next
 *      blanket permission grows.
 */
export interface RelativeImportExemption {
  /** Repo-relative directory of the importing workspace package. */
  readonly from: string;
  /** Repo-relative directory of the package it reaches. */
  readonly to: string;
  readonly reason: string;
}

export const CROSS_WORKSPACE_RELATIVE_EXEMPTIONS: readonly RelativeImportExemption[] = [
  {
    from: 'apps/e2e',
    to: 'scripts',
    reason:
      'The Playwright harness and the tooling it drives are one Bun process. It ' +
      'imports the module so the harness exercises the real path resolution, port ' +
      'allocation and browser lookup rather than a second copy of them.',
  },
  {
    from: 'apps/frontend/client',
    to: 'scripts',
    reason:
      'The Vitest config resolves the browser executable before any application ' +
      'module is loaded, and runs in Node. It is role `config`, so nothing it ' +
      'reaches can reach a browser bundle.',
  },
];

/**
 * What a first-party project's README has to answer.
 *
 * Five obligations, and the wording is deliberately free: each is a set of heading
 * patterns rather than a required string, so two projects with different voices both
 * satisfy it. What is not free is the *content* — a README that cannot say what the
 * project runs on, or how to run its tasks, is the documentation failure this guard
 * exists to make visible, and a project that ships without one cannot be reviewed by
 * anybody who did not write it.
 *
 * Headings, not prose, because a heading is a promise about a section and a paragraph
 * is not: matching prose would make the check a keyword search that any sentence could
 * satisfy. One README per *project*, not per source directory — the obligation is that
 * somebody can find out how to work here, not that every folder repeats it.
 */
export interface ReadmeSection {
  readonly id: string;
  /** Any heading matching any of these counts. Case-insensitive. */
  readonly headings: readonly RegExp[];
  /** Printed with the violation, so the fix is the missing heading, not a paragraph. */
  readonly guidance: string;
}

export const REQUIRED_README_SECTIONS: readonly ReadmeSection[] = [
  {
    id: 'purpose',
    headings: [
      /purpose/i,
      /^what (this|it) is/i,
      /^what is (here|in)/i,
      /overview/i,
      /^runtime/i,
      /^what you get/i,
    ],
    guidance: 'Say what the project is and which runtime(s) its code executes on.',
  },
  {
    id: 'setup',
    headings: [
      /setup/i,
      /^config(uration)?\b/i,
      /install/i,
      /prerequisit/i,
      /environment/i,
      /getting started/i,
    ],
    guidance:
      'Name the configuration and prerequisites a fresh checkout needs, and where they ' +
      'are declared.',
  },
  {
    id: 'commands',
    headings: [/commands?/i, /^usage/i, /^tasks?/i, /how to run/i, /^running/i],
    guidance:
      'List the commands with the working directory each one runs from, because ' +
      '"bun run test" is a different command in four of this repository\'s projects.',
  },
  {
    id: 'validation',
    headings: [/validat/i, /^tests?\b/i, /^check/i, /verif/i, /artifacts?/i],
    guidance:
      'Say what proves this project works — which lane, which runner, which count is ' +
      'nonzero — and what it produces as output.',
  },
  {
    id: 'boundaries',
    headings: [/boundar/i, /architect/i, /depend/i, /^docs?\b/i, /see also/i, /^related/i],
    guidance:
      'State what this project may import and what may not import it, and link the ' +
      'canonical guide rather than copying it.',
  },
];
