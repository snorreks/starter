import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { REPO_ROOT } from '../src/shared/paths.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a workflow mapping.');
  }
  return value as Record<string, unknown>;
};

const workflowSteps = (
  options: { file?: string; job?: string } = {},
): Record<string, unknown>[] => {
  const workflow: unknown = parse(
    readFileSync(join(REPO_ROOT, '.github/workflows', options.file ?? 'deploy.yml'), 'utf8'),
  );
  const steps = record(record(record(workflow).jobs)[options.job ?? 'apply']).steps;
  if (!Array.isArray(steps)) {
    throw new Error('The selected workflow job has no steps.');
  }
  return steps.map(record);
};

const runTargetExtraction = (target: unknown) => {
  const step = workflowSteps().find((value) => value.id === 'target');
  if (typeof step?.run !== 'string') {
    throw new Error('The deployment target extraction step is missing.');
  }
  const script = /node -e '([^']+)'/.exec(step.run)?.[1];
  if (script === undefined) {
    throw new Error('The target extraction script is missing.');
  }
  const directory = mkdtempSync(join(tmpdir(), 'starter-workload-target-'));
  directories.push(directory);
  const input = join(directory, 'target.json');
  const output = join(directory, 'output.txt');
  writeFileSync(input, JSON.stringify({ phase: 'plan', target }));
  writeFileSync(output, '');
  const result = spawnSync('node', ['-e', script], {
    env: { ...process.env, TARGET_FILE: input, GITHUB_OUTPUT: output },
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  return { result, output: readFileSync(output, 'utf8') };
};

test('the retained D1 CI migration selects legacy rather than inheriting deployment defaults', () => {
  const migration = workflowSteps({ file: 'ci.yml', job: 'e2e' }).find(
    (step) => step.name === 'Apply migrations to local D1',
  );
  expect(migration?.run).toBe('bun run db:migrate');
  expect(migration?.env).toMatchObject({ STARTER_BACKEND_PROFILE: 'legacy' });
});

describe('deployment workload identity follows resolved compute policy', () => {
  test('disabled compute requires no Google project', () => {
    const { result, output } = runTargetExtraction({
      deploymentProfile: 'supabase',
      compute: { enabled: false },
      supabase: {},
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(output).toContain('compute_enabled=false\n');
    expect(output).toContain('google_project_id=\n');
  });

  test('enabled compute exports the resolved Google project', () => {
    const { result, output } = runTargetExtraction({
      deploymentProfile: 'supabase',
      compute: { enabled: true },
      supabase: { googleProjectId: 'starter-staging' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(output).toContain('compute_enabled=true\n');
    expect(output).toContain('google_project_id=starter-staging\n');
  });

  test.each([{}, { enabled: true }])(
    'missing compute policy or project refuses without outputs',
    (compute) => {
      const { result, output } = runTargetExtraction({
        deploymentProfile: 'supabase',
        compute,
        supabase: {},
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(output).toBe('');
    },
  );

  test('Google authentication is gated on the resolved enabled flag', () => {
    const authentication = workflowSteps().find((value) => value.id === 'google-auth');
    expect(authentication?.if).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expressions are literal workflow configuration, not JavaScript interpolation.
      "${{ inputs.backend_profile == 'supabase' && steps.target.outputs.compute_enabled == 'true' }}",
    );
  });
});
