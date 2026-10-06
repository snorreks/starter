import { describe, expect, test } from 'bun:test';
import { runScope } from '../src/shared/run_scope.ts';

describe('E2E runtime scopes', () => {
  test('two invocations receive distinct state, logs, and artifact roots', () => {
    const first = runScope('e2e_first', '/checkout');
    const second = runScope('e2e_second', '/checkout');

    expect(first.dir).not.toBe(second.dir);
    expect(first.stateDir).not.toBe(second.stateDir);
    expect(first.logDir).not.toBe(second.logDir);
    expect(first.artifactDir).not.toBe(second.artifactDir);
    expect(first.stateDir).toBe('/checkout/.wrangler/runs/e2e_first/state');
  });

  test('a run scope cannot escape the checkout through its identity', () => {
    expect(() => runScope('../outside', '/checkout')).toThrow(/run id/i);
  });
});
