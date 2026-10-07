import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { runBounded } from '../shared/run_bounded.ts';
import { runScope } from '../shared/run_scope.ts';
import { reviewCaptureManifest } from '../visual/review.ts';

const USAGE = `agent describe --json
agent doctor --profile built --json
agent visual capture --json
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
    'Visual capture/review use the existing E2E matrix and manifest reviewer; interactive browser captures cannot yet be imported.',
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
      status: 'not-run',
      owner: null,
      remedy:
        'Add hash-validated interactive capture import after project-owned browser identity is available.',
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
