import { describe, expect, test } from 'bun:test';
import {
  checkRouteCoverage,
  discoverPageRoutes,
  readScenarioManifest,
  validateScenarioManifest,
} from './manifest.ts';

describe('E2E scenario coverage', () => {
  test('the manifest is valid and covers every web and native Svelte page route', () => {
    const manifest = readScenarioManifest();
    const webRoutes = discoverPageRoutes('apps/frontend/client');
    const nativeRoutes = discoverPageRoutes('apps/frontend/native');
    const result = checkRouteCoverage({ web: webRoutes, native: nativeRoutes }, manifest);

    expect(result.missing).toEqual([]);
    expect(manifest.scenarios.some((scenario) => scenario.kind === 'not-found')).toBe(true);
    expect(manifest.scenarios.some((scenario) => scenario.kind === 'error')).toBe(true);
  });

  test('a newly discovered page is reported as uncovered', () => {
    const manifest = readScenarioManifest();
    const result = checkRouteCoverage(
      { web: ['/', '/new-page'], native: ['/', '/new-page'] },
      manifest,
    );

    expect(result.missing).toContain('web:/new-page');
    expect(result.missing).toContain('native:/new-page');
  });

  test('duplicate scenario ids are rejected even when route coverage is complete', () => {
    const manifest = readScenarioManifest();
    const first = manifest.scenarios[0];
    if (first === undefined) throw new Error('manifest has no scenarios');

    expect(() =>
      checkRouteCoverage(
        { web: ['/'], native: ['/'] },
        { ...manifest, scenarios: [...manifest.scenarios, first] },
      ),
    ).toThrow(/duplicate scenario id/i);
  });

  test('an uncaptured state needs a reason and cannot be a baseline', () => {
    const manifest = readScenarioManifest();
    const errorState = manifest.scenarios.find((scenario) => scenario.id === 'web-error');
    if (errorState === undefined) throw new Error('manifest has no declared error state');

    expect(() =>
      validateScenarioManifest({
        ...manifest,
        scenarios: [
          ...manifest.scenarios.filter((scenario) => scenario.id !== errorState.id),
          { ...errorState, captureReason: null, baseline: true },
        ],
      }),
    ).toThrow(/uncaptured scenario needs a reason|baseline requires capture/i);
  });
});
