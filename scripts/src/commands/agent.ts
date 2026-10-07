import { join } from 'node:path';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { runScope } from '../shared/run_scope.ts';
import { reviewCaptureManifest } from '../visual/review.ts';

const USAGE = `agent describe --json
agent doctor --profile built --json
agent review --run <id> --json [--no-cache] [--gate]

Describe the project-owned agent capabilities and their current authority. This operation
does not start a runtime, browser, visual provider, or remote service.`;

const reviewUsage = `agent review --run <id> --json [--no-cache] [--gate]

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
    'Visual review JSON delegates to the existing manifest reviewer; visual capture JSON facade is not implemented.',
    'Full compute QA requires the real Docker-backed jobs lane; it is not substituted or disabled here.',
  ],
  rerun: ['bun run agent -- describe --json', 'bun run e2e:visual:review -- --run <run-id>'],
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
        'Set CHROMIUM_PATH for exploratory browsing; project-identified QA requires the owned runtime/browser bridge.',
    },
    {
      id: 'visual-review',
      status: 'passed',
      owner: 'scripts/src/commands/visual.ts',
      remedy: null,
    },
    {
      id: 'visual-capture-facade',
      status: 'not-run',
      owner: null,
      remedy: 'Add the JSON capture facade after runtime ownership is available.',
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
      remedy: 'Configure CHROMIUM_PATH; project-owned browser verification is not available.',
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
    if (argv[0] === 'review') {
      const allowed = new Set(['review', '--run', '--json', '--no-cache', '--gate']);
      if (argv.some((argument) => argument.startsWith('--') && !allowed.has(argument))) {
        return fail(`Unsupported agent review argument.\n\n${reviewUsage}`, EXIT.usage);
      }
      const runIndex = argv.indexOf('--run');
      const runId = argv[runIndex + 1];
      if (
        runIndex !== 1 ||
        runId === undefined ||
        argv.filter((argument) => argument === '--run').length !== 1 ||
        !argv.includes('--json') ||
        argv.filter((argument) => argument === '--json').length !== 1 ||
        argv.filter((argument) => argument === '--no-cache').length > 1 ||
        argv.filter((argument) => argument === '--gate').length > 1
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
          gate: argv.includes('--gate'),
          noCache: argv.includes('--no-cache'),
        });
        const status = result.status === 'passed' ? 'passed' : 'failed';
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            operation: 'review',
            status,
            runId: result.runId,
            summary: `Visual review ${result.status}: ${result.reviewed} capture(s), ${result.cached} cached.`,
            artifacts: [result.report, result.report.replace(/\.json$/, '.html')],
            rerun: [`bun run agent -- review --run ${runId} --json`],
            review: result,
          })}\n`,
        );
        return status === 'passed' ? EXIT.ok : EXIT.failed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unavailable = /Set E2E_VISION_(?:MODEL|API_KEY)|provide OPENROUTER_API_KEY/.test(
          message,
        );
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            operation: 'review',
            status: unavailable ? 'not-run' : 'failed',
            runId,
            summary: message,
            artifacts: [],
            rerun: [`bun run agent -- review --run ${runId} --json`],
          })}\n`,
        );
        return unavailable ? EXIT.unavailable : EXIT.failed;
      }
    }
    return fail(`Unsupported agent operation.\n\n${USAGE}`, EXIT.usage);
  },
};
