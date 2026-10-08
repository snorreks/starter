import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { REPO_ROOT } from '../src/shared/paths.ts';
import { runScope } from '../src/shared/run_scope.ts';

const originalWrite = process.stdout.write;
const temporary: string[] = [];
let output = '';
afterEach(async () => {
  process.stdout.write = originalWrite;
  output = '';
  for (const path of temporary.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp9sAAAAASUVORK5CYII=',
  'base64',
);
const runImport = async (extra: string[] = []) => {
  const directory = join(REPO_ROOT, '.wrangler', 'interactive-import-tests', randomUUID());
  temporary.push(directory);
  await mkdir(directory, { recursive: true });
  const source = join(directory, 'capture.png');
  await writeFile(source, png);
  const runId = `interactive_fixture_${randomUUID().replaceAll('-', '')}`;
  const scope = runScope(runId, REPO_ROOT);
  temporary.push(scope.dir);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  const args = [
    'agent',
    'visual',
    'import',
    '--run',
    runId,
    '--file',
    source,
    '--sha256',
    createHash('sha256').update(png).digest('hex'),
    '--url',
    'http://127.0.0.1:4173/notes?token=must-not-be-recorded',
    '--heading',
    'Notes',
    '--requirement',
    'The saved note is visible.',
    '--viewport',
    'desktop',
    '--theme',
    'light',
    '--json',
    ...extra,
  ];
  const hashOverride = extra.indexOf('--sha256');
  if (hashOverride >= 0) {
    const originalHash = args.indexOf('--sha256');
    const appendedHash = args.lastIndexOf('--sha256');
    if (appendedHash !== originalHash) {
      args.splice(appendedHash, 2);
    }
    args[originalHash + 1] = extra[hashOverride + 1] as string;
  }
  const code = await main(args);
  return { code, source, runId, scope };
};

describe('interactive visual capture import', () => {
  test('copies a hash-verified screenshot and labels it outside declared scenario coverage', async () => {
    const { code, runId, scope } = await runImport();
    expect(code).toBe(0);
    const result = JSON.parse(output.trim());
    expect(result).toMatchObject({ operation: 'visual-import', status: 'passed', runId });
    expect(result.rerun).toContain(`bun run agent -- visual review --run ${runId} --json`);
    const manifest = JSON.parse(
      await readFile(join(scope.artifactDir, 'visual', 'run.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({
      runId,
      status: 'passed',
      expectedCaptures: 1,
      coverageGaps: [expect.stringMatching(/interactive/i)],
      records: [
        {
          captureKind: 'interactive',
          heading: 'Notes',
          url: 'http://127.0.0.1:4173/notes',
          project: 'desktop-light',
          requirements: ['The saved note is visible.'],
        },
      ],
    });
    expect(JSON.stringify(manifest)).not.toContain('must-not-be-recorded');
    const capture = manifest.records[0].file as string;
    expect(await readFile(join(REPO_ROOT, capture))).toEqual(png);
  });

  test('rejects a stale or tampered source hash without creating a manifest', async () => {
    const { code, scope } = await runImport(['--sha256', '0'.repeat(64)]);
    expect(code).toBe(1);
    expect(JSON.parse(output.trim())).toMatchObject({
      operation: 'visual-import',
      status: 'error',
      artifacts: [],
    });
    await expect(readFile(join(scope.artifactDir, 'visual', 'run.json'))).rejects.toThrow();
  });

  test('refuses an invalid crop before importing bytes', async () => {
    const { code } = await runImport(['--crop', '0.9,0.9,0.5,0.5']);
    expect(code).toBe(1);
    expect(JSON.parse(output.trim())).toMatchObject({
      operation: 'visual-import',
      status: 'error',
    });
  });

  test('reviews an imported capture explicitly and preserves capture and crop provenance', async () => {
    const { runId, scope } = await runImport(['--crop', '0.1,0.2,0.7,0.6']);
    let providerRequest: Record<string, unknown> | undefined;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        providerRequest = (await request.json()) as Record<string, unknown>;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  schemaVersion: 1,
                  summary: 'The saved note remains visible.',
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
                      { score: 4, evidence: 'The saved note is visible.', uncertainty: 'low' },
                    ]),
                  ),
                  requirements: [
                    {
                      id: 'The saved note is visible.',
                      status: 'met',
                      evidence: 'The note is visible.',
                    },
                  ],
                  issues: [],
                  reference: null,
                }),
              },
              finish_reason: 'stop',
            },
          ],
        });
      },
    });
    const names = ['E2E_VISION_MODEL', 'E2E_VISION_API_KEY', 'E2E_VISION_BASE_URL'] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    process.env.E2E_VISION_MODEL = 'fixture/vision';
    process.env.E2E_VISION_API_KEY = 'fixture-key';
    process.env.E2E_VISION_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
    output = '';
    try {
      expect(
        await main(['agent', 'visual', 'review', '--run', runId, '--json', '--no-cache']),
      ).toBe(0);
      const result = JSON.parse(output.trim());
      expect(result).toMatchObject({ operation: 'review', status: 'passed', runId });
      expect(result.provenance[0]).toMatchObject({
        captureKind: 'interactive',
        crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
      });
      const providerBody = JSON.stringify(providerRequest);
      expect(providerBody).toContain('data:image/png;base64,');
      expect(providerBody).toContain('response_format');
      const report = JSON.parse(
        await readFile(join(scope.artifactDir, 'visual', 'review.json'), 'utf8'),
      );
      expect(report.results[0]).toMatchObject({
        captureKind: 'interactive',
        crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
        originalSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
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
    }
  });
});
