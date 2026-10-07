import { describe, expect, test } from 'bun:test';
import type { Target } from '../src/dev-app.ts';
import { runScope } from '../src/shared/run_scope.ts';

const targetWithRunScope = async (runId: string): Promise<Target> => {
  const previousId = process.env.E2E_RUN_ID;
  process.env.E2E_RUN_ID = runId;
  try {
    const module: { buildTarget: (mode: 'app' | 'built') => Target } = await import(
      /* @vite-ignore */ `../src/dev-app.ts?scope=${encodeURIComponent(runId)}`
    );
    return module.buildTarget('built');
  } finally {
    if (previousId === undefined) {
      delete process.env.E2E_RUN_ID;
    } else {
      process.env.E2E_RUN_ID = previousId;
    }
  }
};

describe('owned E2E Worker persistence', () => {
  test('Wrangler uses the invocation state directory and its identity', async () => {
    const target = await targetWithRunScope('e2e_run_a');
    const args = target.args;

    expect(args).toContain('--persist-to');
    expect(args[args.indexOf('--persist-to') + 1]).toBe(runScope('e2e_run_a').stateDir);
    expect(args).toContain('TEST_RUN_ID:e2e_run_a');
  });

  test('different invocations cannot resolve to the same Wrangler state directory', async () => {
    const first = await targetWithRunScope('e2e_run_a');
    const second = await targetWithRunScope('e2e_run_b');

    expect(first.args[first.args.indexOf('--persist-to') + 1]).not.toBe(
      second.args[second.args.indexOf('--persist-to') + 1],
    );
  });
});
