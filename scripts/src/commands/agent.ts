import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { runBounded } from '../shared/run_bounded.ts';
import { runScope } from '../shared/run_scope.ts';
import {
  importInteractiveCapture,
  type CaptureCrop,
  type InteractiveCaptureOptions,
} from '../visual/import_interactive_capture.ts';
import { reviewCaptureManifest } from '../visual/review.ts';

const USAGE = `agent describe --json
agent doctor --profile built --json
agent visual capture --json
agent visual import --run <id> --file <png> --sha256 <hex> --url <url> --heading <text> --requirement <text> --viewport desktop|mobile --theme light|dark --json
agent visual review --run <id> --json [--no-cache] [--gate]
agent compute full --json

Describe the project-owned agent capabilities and their current authority. This operation
does not start a runtime, browser, visual provider, or remote service.`;

const reviewUsage = `agent visual review --run <id> --json [--no-cache] [--gate]

Review a complete visual manifest already captured under .wrangler/runs/<id>.
This operation never starts the browser or a runtime.`;

const describe = {
  schemaVersion: 1,
  operation: 'describe',
  status: 'passed',
  runId: null,
  checkout: REPO_ROOT,
  summary: 'Starter capability inventory; runtime/browser handles are not started by describe.',
  artifacts: [],
  limitations: [
    'Runtime profiles are unavailable until the reusable owned runtime authority is implemented.',
    'Interactive browser actions are available only from the portable workflow package and have no project runtime identity.',
    'Interactive captures can be imported for explicitly labeled review, but do not count as declared scenario coverage or baselines.',
    'Persistent runtime start/status/stop profiles remain unavailable; the one-shot full compute journey uses the real Docker-backed E2E authority.',
  ],
  rerun: [
    'bun run agent -- describe --json',
    'bun run agent -- visual capture --json',
    'bun run agent -- visual review --run <run-id> --json',
  ],
  capabilities: [
    { id: 'task', status: 'passed', owner: '.pi/extensions/repo_task.ts', remedy: null },
    { id: 'runtime:dev', status: 'passed', owner: '.pi/extensions/dev_process.ts', remedy: null },
    { id: 'logs', status: 'passed', owner: '.pi/extensions/logs.ts', remedy: null },
    {
      id: 'runtime:built',
      status: 'not-run',
      owner: null,
      remedy: 'Implement the reusable owned runtime authority from the E2E visual plan.',
    },
    {
      id: 'runtime:full',
      status: 'not-run',
      owner: null,
      remedy: 'Implement the owned full runtime and run it with a Docker-compatible engine.',
    },
    {
      id: 'browser',
      status: 'not-run',
      owner: '@sonny/pi-workflow-helpers (exploratory only)',
      remedy:
        'Set CHROMIUM_PATH for exploratory browsing; project-identified QA requires the missing owned runtime descriptor and browser bridge.',
    },
    {
      id: 'visual-review',
      status: 'passed',
      owner: 'scripts/src/commands/visual.ts',
      remedy: null,
    },
    {
      id: 'visual-capture-facade',
      status: 'passed',
      owner: 'scripts/src/commands/agent.ts',
      remedy: null,
    },
    {
      id: 'interactive-capture-import',
      status: 'passed',
      owner: 'scripts/src/visual/import_interactive_capture.ts',
      remedy: null,
    },
    {
      id: 'compute:full',
      status: 'passed',
      owner: 'scripts/src/commands/agent.ts -> apps/e2e test:full',
      remedy: null,
    },
  ],
} as const;

const doctorBuilt = {
  schemaVersion: 1,
  operation: 'doctor',
  profile: 'built',
  status: 'not-run',
  runId: null,
  checkout: REPO_ROOT,
  summary:
    'Built-profile diagnosis cannot run because no owned built-runtime profile is configured.',
  artifacts: [],
  limitations: [
    'The built runtime lifecycle and identity descriptor are not implemented.',
    'This command did not start a Worker, browser, or remote provider.',
  ],
  rerun: ['bun run agent -- doctor --profile built --json'],
  capabilities: [
    {
      id: 'runtime:built',
      status: 'not-run',
      owner: null,
      remedy: 'Implement the owned runtime profile authority.',
    },
    {
      id: 'browser',
      status: 'not-run',
      owner: '@sonny/pi-workflow-helpers (exploratory only)',
      remedy:
        'Configure CHROMIUM_PATH for exploratory browsing; project-owned browser verification requires the missing runtime descriptor.',
    },
  ],
} as const;

type InteractiveImportParse =
  | { options: Parameters<typeof importInteractiveCapture>[0] }
  | { error: string };

const parseInteractiveImport = (argv: string[]): InteractiveImportParse => {
  const single = new Map<string, string>();
  const repeated = new Map<string, string[]>([
    ['--requirement', []],
    ['--control', []],
    ['--content', []],
  ]);
  let jsonCount = 0;
  const known = new Set([
    '--run',
    '--file',
    '--sha256',
    '--url',
    '--heading',
    '--requirement',
    '--control',
    '--content',
    '--viewport',
    '--theme',
    '--crop',
    '--json',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      jsonCount += 1;
      continue;
    }
    if (flag === undefined || !known.has(flag)) {
      return { error: `Unsupported interactive import argument ${JSON.stringify(flag)}.` };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { error: `Interactive import argument ${flag} needs a value.` };
    }
    const list = repeated.get(flag);
    if (list !== undefined) {
      list.push(value);
      index += 1;
      continue;
    }
    if (single.has(flag)) {
      return { error: `Interactive import argument ${flag} may appear only once.` };
    }
    single.set(flag, value);
    index += 1;
  }
  const required = ['--run', '--file', '--sha256', '--url', '--heading', '--viewport', '--theme'];
  const missing = required.filter((flag) => !single.has(flag));
  if (missing.length > 0 || jsonCount !== 1 || repeated.get('--requirement')?.length === 0) {
    return {
      error: `Interactive import requires ${[...missing, ...(jsonCount !== 1 ? ['--json once'] : []), ...(repeated.get('--requirement')?.length === 0 ? ['at least one --requirement'] : [])].join(', ')}.`,
    };
  }
  const viewport = single.get('--viewport');
  const theme = single.get('--theme');
  if (viewport !== 'desktop' && viewport !== 'mobile') {
    return { error: '--viewport must be desktop or mobile.' };
  }
  if (theme !== 'light' && theme !== 'dark') {
    return { error: '--theme must be light or dark.' };
  }
  let crop: CaptureCrop | undefined;
  const cropValue = single.get('--crop');
  if (cropValue !== undefined) {
    const values = cropValue.split(',').map(Number);
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
      return { error: '--crop must be four comma-separated normalized numbers: x,y,width,height.' };
    }
    crop = {
      x: values[0] as number,
      y: values[1] as number,
      width: values[2] as number,
      height: values[3] as number,
    };
  }
  return {
    options: {
      runId: single.get('--run') as string,
      file: single.get('--file') as string,
      sha256: single.get('--sha256') as string,
      url: single.get('--url') as string,
      heading: single.get('--heading') as string,
      requirements: repeated.get('--requirement') as string[],
      controls: repeated.get('--control') ?? [],
      content: repeated.get('--content') ?? [],
      viewport,
      theme,
      ...(crop === undefined ? {} : { crop }),
    },
  };
};

const readBoundedStdin = async (maximumBytes: number): Promise<string> => {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        throw new Error(`Interactive import stdin exceeds its ${maximumBytes} byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
};

const parseInteractiveImportJson = (value: unknown): InteractiveImportParse => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'Interactive import JSON must be an object.' };
  }
  const data = value as Record<string, unknown>;
  const allowed = new Set([
    'runId',
    'file',
    'sha256',
    'url',
    'heading',
    'requirements',
    'controls',
    'content',
    'viewport',
    'theme',
    'crop',
  ]);
  const unknown = Object.keys(data).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return { error: `Interactive import JSON contains unknown keys: ${unknown.join(', ')}.` };
  }
  const strings = ['runId', 'file', 'sha256', 'url', 'heading'];
  const missing = strings.filter((key) => typeof data[key] !== 'string');
  if (
    missing.length > 0 ||
    !Array.isArray(data.requirements) ||
    !data.requirements.every((item) => typeof item === 'string') ||
    (data.controls !== undefined &&
      (!Array.isArray(data.controls) ||
        !data.controls.every((item) => typeof item === 'string'))) ||
    (data.content !== undefined &&
      (!Array.isArray(data.content) || !data.content.every((item) => typeof item === 'string'))) ||
    (data.viewport !== 'desktop' && data.viewport !== 'mobile') ||
    (data.theme !== 'light' && data.theme !== 'dark')
  ) {
    return {
      error: `Interactive import JSON has invalid or missing fields: ${missing.join(', ')}.`,
    };
  }
  let crop: CaptureCrop | undefined;
  if (data.crop !== undefined) {
    if (typeof data.crop !== 'object' || data.crop === null || Array.isArray(data.crop)) {
      return { error: 'Interactive import JSON crop must be an object.' };
    }
    const source = data.crop as Record<string, unknown>;
    if (
      Object.keys(source).some((key) => !['x', 'y', 'width', 'height'].includes(key)) ||
      !['x', 'y', 'width', 'height'].every((key) => typeof source[key] === 'number')
    ) {
      return { error: 'Interactive import JSON crop needs only numeric x, y, width and height.' };
    }
    crop = {
      x: source.x as number,
      y: source.y as number,
      width: source.width as number,
      height: source.height as number,
    };
  }
  return {
    options: {
      runId: data.runId as string,
      file: data.file as string,
      sha256: data.sha256 as string,
      url: data.url as string,
      heading: data.heading as string,
      requirements: data.requirements as string[],
      controls: (data.controls ?? []) as string[],
      content: (data.content ?? []) as string[],
      viewport: data.viewport,
      theme: data.theme,
      ...(crop === undefined ? {} : { crop }),
    } as InteractiveCaptureOptions,
  };
};

export const agentCommand: Command = {
  name: 'agent',
  summary: 'describe project-owned agent capabilities as JSON',
  usage: USAGE,
  async run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }
    if (argv[0] === 'describe' && argv.length === 2 && argv[1] === '--json') {
      process.stdout.write(`${JSON.stringify(describe)}\n`);
      return EXIT.ok;
    }
    if (
      argv.length === 4 &&
      argv[0] === 'doctor' &&
      argv[1] === '--profile' &&
      argv[2] === 'built' &&
      argv[3] === '--json'
    ) {
      process.stdout.write(`${JSON.stringify(doctorBuilt)}\n`);
      return EXIT.unavailable;
    }
    if (argv[0] === 'visual' && argv[1] === 'capture') {
      if (argv.length !== 3 || argv[2] !== '--json') {
        return fail(`Invalid agent visual capture invocation.\n\n${USAGE}`, EXIT.usage);
      }
      const runId = `agent_visual_${crypto.randomUUID()}`;
      let scope: ReturnType<typeof runScope>;
      try {
        scope = runScope(runId, REPO_ROOT);
      } catch (error) {
        return fail(`Could not allocate visual run: ${(error as Error).message}`, EXIT.failed);
      }
      const result = await runBounded({
        command: process.execPath,
        args: ['run', '--cwd', 'apps/e2e', 'test:visual'],
        cwd: REPO_ROOT,
        env: { ...process.env, E2E_RUN_ID: runId },
        timeoutMs: 30 * 60_000,
        maxBytes: 16 * 1024 * 1024,
        onOutput: (_stream, chunk) => process.stderr.write(chunk),
      });
      if (result.code !== 0) {
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            operation: 'visual-capture',
            status: 'failed',
            runId,
            checkout: REPO_ROOT,
            summary: `Visual capture exited ${result.code}: ${result.stderr.slice(-2500) || result.stdout.slice(-2500)}`,
            artifacts: [],
            limitations: ['No complete capture manifest was verified.'],
            rerun: [`bun run agent -- visual capture --json`],
          })}\n`,
        );
        return EXIT.failed;
      }
      try {
        const manifestPath = join(scope.artifactDir, 'visual', 'run.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          schemaVersion?: number;
          runId?: string;
          status?: string;
          expectedCaptures?: number;
          records?: Array<{ file?: string; sha256?: string }>;
        };
        if (
          manifest.schemaVersion !== 1 ||
          manifest.runId !== runId ||
          manifest.status !== 'passed' ||
          !Array.isArray(manifest.records) ||
          manifest.records.length === 0 ||
          manifest.records.length !== manifest.expectedCaptures
        ) {
          throw new Error('Capture manifest is incomplete or has the wrong run identity.');
        }
        const files = [manifestPath, ...manifest.records.map((record) => record.file)];
        const artifacts = [];
        for (const file of files) {
          if (typeof file !== 'string') {
            throw new Error('Capture manifest contains an invalid image path.');
          }
          const absolute = resolve(REPO_ROOT, file);
          const path = relative(REPO_ROOT, absolute);
          if (
            path === '..' ||
            path.startsWith(`..${process.platform === 'win32' ? '\\\\' : '/'}`)
          ) {
            throw new Error('Capture manifest references a file outside the checkout.');
          }
          const bytes = await readFile(absolute);
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const record = manifest.records.find((entry) => entry.file === file);
          if (record?.sha256 !== undefined && record.sha256 !== sha256) {
            throw new Error(`Capture hash mismatch for ${path}.`);
          }
          artifacts.push({
            kind: file === manifestPath ? 'visual-manifest' : 'screenshot',
            path,
            sha256,
            bytes: bytes.byteLength,
          });
        }
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            operation: 'visual-capture',
            status: 'passed',
            runId,
            checkout: REPO_ROOT,
            summary: `Captured and verified ${manifest.records.length} screenshots. Visual review was NOT RUN.`,
            artifacts,
            limitations: [
              'Capture proves declared browser scenarios only; model review is a separate explicit operation.',
            ],
            rerun: [`bun run agent -- visual review --run ${runId} --json`],
          })}\n`,
        );
        return EXIT.ok;
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            operation: 'visual-capture',
            status: 'error',
            runId,
            checkout: REPO_ROOT,
            summary: (error as Error).message,
            artifacts: [],
            limitations: [
              'A successful browser process without a verified run manifest is not a pass.',
            ],
            rerun: [`bun run agent -- visual capture --json`],
          })}\n`,
        );
        return EXIT.failed;
      }
    }
    if (argv[0] === 'visual' && argv[1] === 'import') {
      let parsed: InteractiveImportParse;
      if (argv.includes('--input-json')) {
        if (argv.length !== 4 || argv[2] !== '--input-json' || argv[3] !== '--json') {
          return fail(
            `Use --input-json --json with one JSON object on stdin.\n\n${USAGE}`,
            EXIT.usage,
          );
        }
        try {
          parsed = parseInteractiveImportJson(JSON.parse(await readBoundedStdin(32 * 1024)));
        } catch (error) {
          return fail(`Invalid interactive import JSON: ${(error as Error).message}`, EXIT.usage);
        }
      } else {
        parsed = parseInteractiveImport(argv.slice(2));
      }
      if ('error' in parsed) {
        return fail(`${parsed.error}\n\n${USAGE}`, EXIT.usage);
      }
      const options = parsed.options;
      if (options === undefined) {
        return fail(`Invalid interactive capture import.\n\n${USAGE}`, EXIT.usage);
      }
      const rerun = [`bun run agent -- visual review --run ${options.runId} --json`];
      try {
        const imported = await importInteractiveCapture(options);
        const manifest = await readFile(imported.manifestPath);
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            operation: 'visual-import',
            status: 'passed',
            runId: imported.runId,
            checkout: REPO_ROOT,
            summary: `Imported one ${imported.dimensions.width}x${imported.dimensions.height} interactive screenshot; declared scenario coverage and baselines are unchanged.`,
            artifacts: [
              {
                kind: 'interactive-screenshot',
                path: imported.relativeCapturePath,
                sha256: imported.sha256,
                bytes: imported.bytes,
              },
              {
                kind: 'interactive-manifest',
                path: relative(REPO_ROOT, imported.manifestPath),
                sha256: createHash('sha256').update(manifest).digest('hex'),
                bytes: manifest.byteLength,
              },
            ],
            limitations: [
              'Interactive screenshots are exploratory review inputs, not declared scenario coverage, runtime identity proof, or baseline approval.',
              'Visual review requires E2E_VISION_MODEL and a configured E2E_VISION_API_KEY or OPENROUTER_API_KEY.',
            ],
            rerun,
            capture: {
              url: imported.url,
              dimensions: imported.dimensions,
              crop: imported.crop,
              originalSha256: imported.sha256,
              captureKind: 'interactive',
            },
          })}\n`,
        );
        return EXIT.ok;
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            operation: 'visual-import',
            status: 'error',
            runId: options.runId,
            checkout: REPO_ROOT,
            summary: (error as Error).message,
            artifacts: [],
            limitations: ['No manifest or review result was accepted.'],
            rerun: ['bun run agent -- visual import --run <new-run-id> ... --json'],
          })}\n`,
        );
        return EXIT.failed;
      }
    }
    if (argv[0] === 'compute' && argv[1] === 'full') {
      if (argv.length !== 3 || argv[2] !== '--json') {
        return fail(`Invalid agent full compute invocation.\n\n${USAGE}`, EXIT.usage);
      }
      const runId = `agent_full_${crypto.randomUUID()}`;
      const scope = runScope(runId, REPO_ROOT);
      const result = await runBounded({
        command: process.execPath,
        args: ['run', '--cwd', 'apps/e2e', 'test:full'],
        cwd: REPO_ROOT,
        env: { ...process.env, E2E_RUN_ID: runId },
        timeoutMs: 35 * 60_000,
        maxBytes: 16 * 1024 * 1024,
        onOutput: (_stream, chunk) => process.stderr.write(chunk),
      });
      const rerun = ['bun run agent -- compute full --json'];
      if (result.code !== 0) {
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            operation: 'compute-full',
            status: 'failed',
            runId,
            checkout: REPO_ROOT,
            summary: `Full compute journey exited ${result.code}: ${result.stderr.slice(-2500) || result.stdout.slice(-2500)}`,
            artifacts: [],
            limitations: [
              'The full Docker-backed journey failed; no successful output evidence was accepted.',
            ],
            rerun,
          })}\n`,
        );
        return EXIT.failed;
      }
      try {
        const reportPath = join(scope.artifactDir, 'compute', 'encode.json');
        const evidence = JSON.parse(await readFile(reportPath, 'utf8')) as {
          schemaVersion?: number;
          runId?: string;
          profile?: string;
          status?: string;
          output?: { path?: string; sha256?: string; bytes?: number };
          probe?: { codec?: string; width?: number; height?: number };
        };
        if (
          evidence.schemaVersion !== 1 ||
          evidence.runId !== runId ||
          evidence.profile !== 'full' ||
          evidence.status !== 'passed' ||
          evidence.output?.path === undefined ||
          evidence.probe?.codec !== 'h264' ||
          evidence.probe.width !== 320 ||
          evidence.probe.height !== 180
        ) {
          throw new Error(
            'Full compute evidence is incomplete or identifies the wrong runtime/output.',
          );
        }
        const outputPath = resolve(REPO_ROOT, evidence.output.path);
        const outputRelative = relative(REPO_ROOT, outputPath);
        if (
          outputRelative === '..' ||
          outputRelative.startsWith(`..${process.platform === 'win32' ? '\\\\' : '/'}`)
        ) {
          throw new Error('Full compute output path escapes the checkout.');
        }
        const outputBytes = await readFile(outputPath);
        const outputHash = createHash('sha256').update(outputBytes).digest('hex');
        if (
          outputBytes.byteLength !== evidence.output.bytes ||
          outputHash !== evidence.output.sha256
        ) {
          throw new Error('Full compute output bytes do not match the recorded hash.');
        }
        const reportBytes = await readFile(reportPath);
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            operation: 'compute-full',
            status: 'passed',
            runId,
            checkout: REPO_ROOT,
            summary: `Full compute produced verified ${evidence.probe.codec} ${evidence.probe.width}x${evidence.probe.height} output (${outputBytes.byteLength} bytes).`,
            artifacts: [
              {
                kind: 'encoded-media',
                path: outputRelative,
                sha256: outputHash,
                bytes: outputBytes.byteLength,
              },
              {
                kind: 'compute-evidence',
                path: relative(REPO_ROOT, reportPath),
                sha256: createHash('sha256').update(reportBytes).digest('hex'),
                bytes: reportBytes.byteLength,
              },
            ],
            limitations: [],
            rerun,
            evidence,
          })}\n`,
        );
        return EXIT.ok;
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            operation: 'compute-full',
            status: 'error',
            runId,
            checkout: REPO_ROOT,
            summary: (error as Error).message,
            artifacts: [],
            limitations: [
              'Successful Playwright exit without verified FFmpeg output evidence is not accepted.',
            ],
            rerun,
          })}\n`,
        );
        return EXIT.failed;
      }
    }
    if (argv[0] === 'visual' && argv[1] === 'review') {
      const args = argv.slice(1);
      const allowed = new Set(['review', '--run', '--json', '--no-cache', '--gate']);
      if (args.some((argument) => argument.startsWith('--') && !allowed.has(argument))) {
        return fail(`Unsupported agent review argument.\n\n${reviewUsage}`, EXIT.usage);
      }
      const runIndex = args.indexOf('--run');
      const runId = args[runIndex + 1];
      const unexpected = args.some(
        (argument, index) =>
          !argument.startsWith('--') &&
          !(index === 0 && argument === 'review') &&
          !(index === runIndex + 1 && argument === runId),
      );
      if (
        runIndex !== 1 ||
        runId === undefined ||
        unexpected ||
        args.filter((argument) => argument === '--run').length !== 1 ||
        !args.includes('--json') ||
        args.filter((argument) => argument === '--json').length !== 1 ||
        args.filter((argument) => argument === '--no-cache').length > 1 ||
        args.filter((argument) => argument === '--gate').length > 1
      ) {
        return fail(`Invalid agent review invocation.\n\n${reviewUsage}`, EXIT.usage);
      }
      let manifestPath: string;
      try {
        manifestPath = join(runScope(runId, REPO_ROOT).artifactDir, 'visual', 'run.json');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`Agent review failed: ${message}`, EXIT.usage);
      }
      try {
        const result = await reviewCaptureManifest({
          manifestPath,
          gate: false,
          noCache: args.includes('--no-cache'),
        });
        const status = result.status;
        const report = JSON.parse(await readFile(result.report, 'utf8')) as {
          schemaVersion?: number;
          runId?: string;
          status?: string;
          results?: Array<Record<string, unknown>>;
        };
        if (
          report.schemaVersion !== 1 ||
          report.runId !== result.runId ||
          report.status !== status ||
          !Array.isArray(report.results) ||
          report.results.length !== result.reviewed
        ) {
          throw new Error('Visual review report is incomplete or has the wrong run identity.');
        }
        const reportArtifacts = [];
        for (const [kind, path] of [
          ['visual-review-json', result.report],
          ['visual-review-html', result.report.replace(/\.json$/, '.html')],
        ] as const) {
          const absolute = resolve(path);
          const relativePath = relative(REPO_ROOT, absolute);
          if (
            relativePath === '..' ||
            relativePath.startsWith(`..${process.platform === 'win32' ? '\\\\' : '/'}`)
          ) {
            throw new Error('Visual review report path escapes the checkout.');
          }
          const bytes = await readFile(absolute);
          reportArtifacts.push({
            kind,
            path: relativePath,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytes: bytes.byteLength,
          });
        }
        const provenance = report.results.map((item) => ({
          scenarioId: item.scenarioId,
          captureKind: item.captureKind,
          crop: item.crop,
          project: item.project,
          originalSha256: item.originalSha256,
          provider: item.provider,
          endpoint: item.endpoint,
          model: item.model,
          grade: item.grade,
          cache: item.provenance,
        }));
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            operation: 'review',
            status,
            runId: result.runId,
            checkout: REPO_ROOT,
            summary: `Visual review ${result.status}: ${result.reviewed} capture(s), ${result.cached} cached.`,
            artifacts: reportArtifacts,
            limitations: [],
            gate: args.includes('--gate'),
            rerun: [
              `bun run agent -- visual review --run ${runId} --json${args.includes('--no-cache') ? ' --no-cache' : ''}${args.includes('--gate') ? ' --gate' : ''}`,
            ],
            provenance,
            review: result,
          })}\n`,
        );
        return status === 'failed' || (args.includes('--gate') && status !== 'passed')
          ? EXIT.failed
          : EXIT.ok;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unavailable = /Set E2E_VISION_(?:MODEL|API_KEY)|provide OPENROUTER_API_KEY/.test(
          message,
        );
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            operation: 'review',
            status: unavailable ? 'not-run' : 'error',
            runId,
            checkout: REPO_ROOT,
            summary: message,
            artifacts: [],
            limitations: [],
            rerun: [
              `bun run agent -- visual review --run ${runId} --json${args.includes('--no-cache') ? ' --no-cache' : ''}${args.includes('--gate') ? ' --gate' : ''}`,
            ],
          })}\n`,
        );
        return unavailable ? EXIT.unavailable : EXIT.failed;
      }
    }
    return fail(`Unsupported agent operation.\n\n${USAGE}`, EXIT.usage);
  },
};
