import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { REPO_ROOT } from '../src/shared/paths.ts';
import { runScope } from '../src/shared/run_scope.ts';

const originalWrite = process.stdout.write;
let output = '';
afterEach(() => {
  process.stdout.write = originalWrite;
  output = '';
});

describe('agent JSON facade', () => {
  test('describe emits one schema-versioned capability result with unavailable work named', async () => {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    expect(await main(['agent', 'describe', '--json'])).toBe(0);
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(1);
    const first = lines[0];
    expect(first).toBeDefined();
    const result = JSON.parse(first ?? '');
    expect(result).toMatchObject({ schemaVersion: 1, operation: 'describe', status: 'passed' });
    expect(
      result.capabilities.find((capability: { id: string }) => capability.id === 'runtime:built'),
    ).toMatchObject({ status: 'passed', owner: expect.stringContaining('agent.ts') });
    expect(result.rerun).toContain('bun run agent -- describe --json');
    expect(result.rerun).toContain('bun run agent -- visual review --run <run-id> --json');
    expect(
      result.capabilities.find(
        (capability: { id: string }) => capability.id === 'interactive-capture-import',
      ),
    ).toMatchObject({
      status: 'passed',
      owner: expect.stringContaining('import_interactive_capture'),
    });
  });

  test('built doctor reports browser prerequisites without starting a runtime', async () => {
    const originalChromiumPath = process.env.CHROMIUM_PATH;
    // The doctor reports whether an explicit browser path resolves; this command
    // does not launch Chromium. Inject an existing executable path so unit tests
    // do not depend on the browser-install step that follows them in CI.
    process.env.CHROMIUM_PATH = process.execPath;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await main(['agent', 'doctor', '--profile', 'built', '--json'])).toBe(0);
      const result = JSON.parse(output.trim());
      expect(result).toMatchObject({
        schemaVersion: 1,
        operation: 'doctor',
        profile: 'built',
        status: 'passed',
      });
      expect(result.rerun).toContain(
        'bun run agent -- runtime start --profile built --run <run-id> --json',
      );
      expect(result.summary).toContain('No runtime was started');
      expect(
        result.capabilities.find((item: { id: string }) => item.id === 'browser'),
      ).toMatchObject({ status: 'passed', remedy: null });
    } finally {
      if (originalChromiumPath === undefined) {
        delete process.env.CHROMIUM_PATH;
      } else {
        process.env.CHROMIUM_PATH = originalChromiumPath;
      }
    }
  });

  test('review emits one JSON failure for a missing scoped capture without starting services', async () => {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    expect(
      await main(['agent', 'visual', 'review', '--run', 'agent_fixture_missing', '--json']),
    ).toBe(1);
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      schemaVersion: 1,
      operation: 'review',
      status: 'error',
      runId: 'agent_fixture_missing',
      artifacts: [],
      rerun: ['bun run agent -- visual review --run agent_fixture_missing --json'],
    });
  });

  test('review JSON delegates a complete scoped manifest to the configured local provider', async () => {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  schemaVersion: 1,
                  summary: 'The required title is visible.',
                  dimensions: Object.fromEntries(
                    [
                      'layout',
                      'typography',
                      'hierarchy',
                      'consistency',
                      'responsiveFit',
                      'stateClarity',
                    ].map((name) => [
                      name,
                      { score: 4, evidence: 'The page title is visible.', uncertainty: 'low' },
                    ]),
                  ),
                  requirements: [
                    { id: 'title-visible', status: 'met', evidence: 'Visible title.' },
                  ],
                  issues: [],
                  reference: null,
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
    });
    const names = ['E2E_VISION_MODEL', 'E2E_VISION_API_KEY', 'E2E_VISION_BASE_URL'] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    const runId = `agent_review_${crypto.randomUUID().replaceAll('-', '')}`;
    const scope = runScope(runId, REPO_ROOT);
    const manifestPath = join(scope.artifactDir, 'visual', 'run.json');
    const imagePath = join(scope.artifactDir, 'visual', 'capture.png');
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp9sAAAAASUVORK5CYII=',
      'base64',
    );
    try {
      process.env.E2E_VISION_MODEL = 'fixture/vision';
      process.env.E2E_VISION_API_KEY = 'fixture-key';
      process.env.E2E_VISION_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
      await mkdir(join(scope.artifactDir, 'visual'), { recursive: true });
      await writeFile(imagePath, image);
      await writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          runId,
          status: 'passed',
          expectedCaptures: 1,
          expectedCaptureKeys: ['home::desktop-light'],
          coverageGaps: [],
          records: [
            {
              scenarioId: 'home',
              app: 'web',
              state: 'public',
              project: 'desktop-light',
              url: 'http://127.0.0.1/',
              file: imagePath,
              sha256: createHash('sha256').update(image).digest('hex'),
              requirements: ['title-visible'],
              expected: { controls: [], content: [] },
              heading: 'Home',
              status: 'passed',
            },
          ],
        }),
      );
      expect(
        await main(['agent', 'visual', 'review', '--run', runId, '--json', '--no-cache']),
      ).toBe(0);
      const result = JSON.parse(output.trim());
      expect(result).toMatchObject({
        schemaVersion: 1,
        operation: 'review',
        status: 'passed',
        runId,
        review: { reviewed: 1, cached: 0 },
      });
      expect(result.artifacts).toContainEqual(
        expect.objectContaining({
          kind: 'visual-review-json',
          path: `.wrangler/runs/${runId}/artifacts/visual/review.json`,
        }),
      );
    } finally {
      server.stop(true);
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await rm(scope.dir, { recursive: true, force: true });
    }
  });
});

describe('agent CLI JSON boundary', () => {
  test('runtime start rejects the unsupported full profile before building or launching', async () => {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    expect(
      await main([
        'agent',
        'runtime',
        'start',
        '--profile',
        'full',
        '--run',
        'agent_cli_full_refused',
        '--json',
      ]),
    ).toBe(1);
    expect(JSON.parse(output.trim())).toMatchObject({
      operation: 'runtime-start',
      status: 'error',
      runId: 'agent_cli_full_refused',
    });
  });

  test('missing runtime status is explicit not-run JSON with the start remedy', async () => {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    expect(await main(['agent', 'runtime', 'status', '--run', 'agent_cli_missing', '--json'])).toBe(
      3,
    );
    expect(JSON.parse(output.trim())).toMatchObject({
      operation: 'runtime-status',
      status: 'not-run',
      runId: 'agent_cli_missing',
      rerun: expect.arrayContaining([
        'bun run agent -- runtime start --profile built --run agent_cli_missing --json',
      ]),
    });
  });

  test('visual capture requires explicit JSON mode before it can start a browser', async () => {
    expect(await main(['agent', 'visual', 'capture'])).toBe(2);
    expect(output).toBe('');
  });

  test('visual review rejects unknown positional arguments before reading a run', async () => {
    expect(
      await main(['agent', 'visual', 'review', '--run', 'missing_run', 'ignored', '--json']),
    ).toBe(2);
    expect(output).toBe('');
  });

  test('a missing visual manifest is a JSON error, not a failed visual grade', async () => {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(
      'bun',
      ['run', 'scripts/src/cli.ts', 'agent', 'visual', 'review', '--run', 'no_such_run', '--json'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ operation: 'review', status: 'error' });
  });

  test('full compute requires JSON mode before starting Docker work', async () => {
    expect(await main(['agent', 'compute', 'full'])).toBe(2);
    expect(output).toBe('');
  });
});
