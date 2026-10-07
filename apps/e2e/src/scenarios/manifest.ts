import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { REPO_ROOT } from '../../../../scripts/src/shared/paths.ts';
import sourceManifest from './manifest.json' with { type: 'json' };

const AppSchema = Type.Union([Type.Literal('web'), Type.Literal('native')]);
const KindSchema = Type.Union([
  Type.Literal('page'),
  Type.Literal('not-found'),
  Type.Literal('error'),
]);
const RuntimeProfileSchema = Type.Union([
  Type.Literal('web-disabled'),
  Type.Literal('web-full'),
  Type.Literal('native-ui-browser'),
]);

const ScenarioSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    app: AppSchema,
    route: Type.String({ minLength: 1 }),
    url: Type.String({ minLength: 1 }),
    kind: KindSchema,
    state: Type.String({ minLength: 1 }),
    fixture: Type.Union([Type.String(), Type.Null()]),
    setup: Type.String({ minLength: 1 }),
    ready: Type.Object({ heading: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    expected: Type.Object(
      { controls: Type.Array(Type.String()), content: Type.Array(Type.String()) },
      { additionalProperties: false },
    ),
    variants: Type.Object(
      {
        viewports: Type.Array(Type.Union([Type.Literal('desktop'), Type.Literal('mobile')]), {
          minItems: 1,
        }),
        themes: Type.Array(Type.Union([Type.Literal('light'), Type.Literal('dark')]), {
          minItems: 1,
        }),
      },
      { additionalProperties: false },
    ),
    capture: Type.Boolean(),
    regions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    visualRequirements: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    referenceId: Type.Union([Type.String(), Type.Null()]),
    audit: Type.Boolean(),
    baseline: Type.Boolean(),
    captureReason: Type.Union([Type.String(), Type.Null()]),
    runtimeProfile: RuntimeProfileSchema,
  },
  { additionalProperties: false },
);

export const ScenarioManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    coverageGaps: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    scenarios: Type.Array(ScenarioSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type ScenarioManifest = Static<typeof ScenarioManifestSchema>;
export type Scenario = ScenarioManifest['scenarios'][number];
export type AppName = Scenario['app'];

const MANIFEST_PATH = new URL('./manifest.json', import.meta.url);

export const readScenarioManifest = (path = MANIFEST_PATH): ScenarioManifest => {
  let parsed: unknown;
  try {
    parsed = path instanceof URL ? sourceManifest : JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Could not read E2E scenario manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Value.Check(ScenarioManifestSchema, parsed)) {
    const details = [...Value.Errors(ScenarioManifestSchema, parsed)]
      .slice(0, 8)
      .map((issue) => `${'path' in issue ? issue.path || '/' : '/'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid E2E scenario manifest:\n${details}`);
  }
  validateScenarioManifest(parsed);
  return parsed;
};

export const validateScenarioManifest = (manifest: ScenarioManifest): void => {
  if (manifest.coverageGaps.some((gap) => gap.trim() === '')) {
    throw new Error('Every declared E2E coverage gap needs a concrete reason.');
  }
  const ids = manifest.scenarios.map((scenario) => scenario.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Invalid E2E scenario manifest: duplicate scenario id.');
  }
  for (const scenario of manifest.scenarios) {
    if (scenario.capture && scenario.captureReason !== null) {
      throw new Error(`Captured scenario ${scenario.id} cannot declare a not-run reason.`);
    }
    if (
      !scenario.capture &&
      (scenario.captureReason === null || scenario.captureReason.trim() === '')
    ) {
      throw new Error(`Uncaptured scenario needs a reason: ${scenario.id}.`);
    }
    if (scenario.baseline && !scenario.capture) {
      throw new Error(`A baseline requires capture: ${scenario.id}.`);
    }
    if (scenario.kind === 'page' && !scenario.route.startsWith('/')) {
      throw new Error(`Page scenario route must start with /: ${scenario.id}.`);
    }
  }
};

const collectPages = (directory: string, root: string, found: string[]): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectPages(path, root, found);
    } else if (entry.isFile() && entry.name === '+page.svelte') {
      const route = relative(root, directory).split(sep).filter(Boolean).join('/');
      found.push(route.length === 0 ? '/' : `/${route}`);
    }
  }
};

/** Discover the page routes that a frontend app currently ships. */
export const discoverPageRoutes = (appPath: string, root = REPO_ROOT): string[] => {
  const routes: string[] = [];
  const routeRoot = join(root, appPath, 'src/routes');
  collectPages(routeRoot, routeRoot, routes);
  return routes.sort();
};

export interface RouteCoverage {
  discovered: Record<AppName, string[]>;
  declared: Record<AppName, string[]>;
  missing: string[];
  unmatched: string[];
}

/** Compare current app routes with declared page scenarios. */
export const checkRouteCoverage = (
  discovered: Record<AppName, readonly string[]>,
  manifest: ScenarioManifest,
): RouteCoverage => {
  validateScenarioManifest(manifest);

  const declared: Record<AppName, string[]> = {
    web: [
      ...new Set(
        manifest.scenarios
          .filter((item) => item.kind === 'page' && item.app === 'web')
          .map((item) => item.route),
      ),
    ].sort(),
    native: [
      ...new Set(
        manifest.scenarios
          .filter((item) => item.kind === 'page' && item.app === 'native')
          .map((item) => item.route),
      ),
    ].sort(),
  };
  const missing: string[] = [];
  const unmatched: string[] = [];
  for (const app of ['web', 'native'] as const) {
    const actual = [...new Set(discovered[app])].sort();
    for (const route of actual) {
      if (!declared[app].includes(route)) {
        missing.push(`${app}:${route}`);
      }
    }
    for (const route of declared[app]) {
      if (!actual.includes(route)) {
        unmatched.push(`${app}:${route}`);
      }
    }
  }
  return {
    discovered: { web: [...discovered.web].sort(), native: [...discovered.native].sort() },
    declared,
    missing,
    unmatched,
  };
};

/** Stable manifest-to-project capture identities used by both the runner and report. */
export const expectedCaptureKeys = (manifest: ScenarioManifest): string[] =>
  manifest.scenarios
    .filter((scenario) => scenario.capture)
    .flatMap((scenario) =>
      scenario.variants.viewports.flatMap((viewport) =>
        scenario.variants.themes.map((theme) => `${scenario.id}::${viewport}-${theme}`),
      ),
    )
    .sort();
