import { join } from 'node:path';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { runBounded } from '../shared/run_bounded.ts';
import { runScope } from '../shared/run_scope.ts';
import { reviewCaptureManifest } from '../visual/review.ts';

const USAGE = `visual review (--run <id-or-manifest> | --capture) [--gate] [--no-cache]

Evaluate a complete local visual capture manifest. An id resolves inside .wrangler/runs;
a manifest path may point directly at run.json. Provider keys remain in .env.e2e or
the process environment. --capture starts a fresh owned browser run before review.`;

export const visualCommand: Command = {
  name: 'visual',
  summary: 'capture review evidence and run optional structured vision review',
  usage: USAGE,
  async run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }
    if (argv[0] !== 'review') {
      return fail(`Unknown visual operation ${JSON.stringify(argv[0])}.\n\n${USAGE}`, EXIT.usage);
    }
    const rest = argv.slice(1);
    const known = new Set(['--run', '--capture', '--gate', '--no-cache']);
    for (const argument of rest) {
      if (
        (argument.startsWith('--') && !known.has(argument)) ||
        (!argument.startsWith('--') && !rest[rest.indexOf(argument) - 1]?.startsWith('--run'))
      ) {
        return fail(
          `Unexpected visual review argument ${JSON.stringify(argument)}.\n\n${USAGE}`,
          EXIT.usage,
        );
      }
    }
    const runIndex = rest.indexOf('--run');
    const runValue = runIndex < 0 ? undefined : rest[runIndex + 1];
    const capture = rest.includes('--capture');
    if ((runValue === undefined) === !capture) {
      return fail(
        `Pass exactly one of --run <id-or-manifest> or --capture.\n\n${USAGE}`,
        EXIT.usage,
      );
    }
    let manifestPath: string;
    if (capture) {
      const runId = `visual_review_${crypto.randomUUID()}`;
      runScope(runId, REPO_ROOT);
      process.stdout.write(`Starting owned capture ${runId}.\n`);
      const processResult = await runBounded({
        command: process.execPath,
        args: ['run', '--cwd', 'apps/e2e', 'test:visual'],
        cwd: REPO_ROOT,
        env: { ...process.env, E2E_RUN_ID: runId },
        timeoutMs: 30 * 60_000,
        maxBytes: 16 * 1024 * 1024,
        stdio: 'inherit',
      });
      if (processResult.code !== 0) {
        return fail(
          `Visual browser capture failed with exit code ${processResult.code}. Review its run directory under .wrangler/runs/${runId}.`,
          EXIT.failed,
        );
      }
      manifestPath = join(runScope(runId, REPO_ROOT).artifactDir, 'visual', 'run.json');
    } else {
      if (runValue === undefined) {
        return fail('Missing --run value.', EXIT.usage);
      }
      manifestPath =
        runValue.endsWith('.json') || runValue.includes('/')
          ? runValue
          : join('.wrangler', 'runs', runValue, 'artifacts', 'visual', 'run.json');
    }
    try {
      const result = await reviewCaptureManifest({
        manifestPath,
        gate: rest.includes('--gate'),
        noCache: rest.includes('--no-cache'),
      });
      process.stdout.write(
        `Visual review ${result.status}: ${result.reviewed} capture(s), ${result.cached} cached.\n` +
          `Report: ${result.report}\n`,
      );
      return result.status === 'failed' ? EXIT.failed : EXIT.ok;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingConfiguration = /Set E2E_VISION_(?:MODEL|API_KEY)/.test(message);
      return fail(
        `Visual review error: ${message}`,
        missingConfiguration ? EXIT.unavailable : EXIT.failed,
      );
    }
  },
};
