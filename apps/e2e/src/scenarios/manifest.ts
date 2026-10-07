import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as v from 'valibot';
import { REPO_ROOT } from '../../../../scripts/src/shared/paths.ts';
import sourceManifest from './manifest.json' with { type: 'json' };

const AppSchema = v.union([v.literal('web'), v.literal('native')]);
const KindSchema = v.union([v.literal('page'), v.literal('not-found'), v.literal('error')]);
const RuntimeProfileSchema = v.union([
  v.literal('web-disabled'),
  v.literal('web-full'),
  v.literal('native-ui-browser'),
]);

const ScenarioSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  app: AppSchema,
  route: v.pipe(v.string(), v.minLength(1)),
  url: v.pipe(v.string(), v.minLength(1)),
  finalUrl: v.optional(v.pipe(v.string(), v.minLength(1))),
  kind: KindSchema,
  state: v.pipe(v.string(), v.minLength(1)),
  fixture: v.union([v.string(), v.null()]),
  setup: v.pipe(v.string(), v.minLength(1)),
  ready: v.strictObject({ heading: v.pipe(v.string(), v.minLength(1)) }),
  expected: v.strictObject({ controls: v.array(v.string()), content: v.array(v.string()) }),
  variants: v.strictObject({
    viewports: v.pipe(
      v.array(v.union([v.literal('desktop'), v.literal('mobile')])),
      v.minLength(1),
    ),
    themes: v.pipe(v.array(v.union([v.literal('light'), v.literal('dark')])), v.minLength(1)),
  }),
  capture: v.boolean(),
  regions: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
  visualRequirements: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
  referenceId: v.union([v.string(), v.null()]),
  audit: v.boolean(),
  baseline: v.boolean(),
  captureReason: v.union([v.string(), v.null()]),
  runtimeProfile: RuntimeProfileSchema,
});

export const ScenarioManifestSchema = v.strictObject({
  schemaVersion: v.literal(1),
  coverageGaps: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
  scenarios: v.pipe(v.array(ScenarioSchema), v.minLength(1)),
});

export type ScenarioManifest = v.InferOutput<typeof ScenarioManifestSchema>;
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
  const result = v.safeParse(ScenarioManifestSchema, parsed);
  if (!result.success) {
    const details = result.issues
      .slice(0, 8)
      .map((issue) => `${issue.path?.map(({ key }) => key).join('.') || '/'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid E2E scenario manifest:\n${details}`);
  }
  validateScenarioManifest(result.output);
  return result.output;
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
