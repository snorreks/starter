// scripts/src/commands/deploy.ts
//
// Thin adapter: argv, help, exit code. Planning and execution are in
// `../deploy/deploy.ts`.

import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';
import {
  executePlan,
  parseDeployArgs,
  planDeploy,
  renderPlan,
  usageText,
} from '../deploy/deploy.ts';
import { wranglerAvailable } from '../cloudflare/wrangler.ts';

export const deployCommand: Command = {
  name: 'deploy',
  summary: 'plan and apply the Cloudflare deployment',
  usage: 'deploy [api|client] [--env staging|production] [--json] [--dry-run] --yes',

  run(argv) {
    const parsed = parseDeployArgs(argv);

    if (!parsed.ok) {
      return fail(`${parsed.errors.join('\n')}\n\n${usageText()}`, EXIT.usage);
    }

    if (parsed.help || wantsHelp(argv)) {
      process.stdout.write(`${usageText()}\n`);
      return EXIT.ok;
    }

    // Planning and execution consume the same plan object. A dry run is not a
    // second, looser implementation of this command: it is this one, stopping
    // before the point where a remote call would start.
    const plan = planDeploy(parsed.targets, parsed.environment);

    if (!plan.ok) {
      return fail(`${plan.reason}\n${plan.remedy}`, EXIT.failed);
    }

    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            environment: parsed.environment,
            targets: parsed.targets,
            dryRun: parsed.dryRun,
            steps: plan.steps,
            notices: plan.notices,
          },
          null,
          2,
        )}\n`,
      );
      return EXIT.ok;
    }

    if (parsed.dryRun) {
      process.stdout.write(`${renderPlan(plan, parsed.environment)}\n`);
      process.stdout.write('\nDry run: nothing was changed.\n');
      return EXIT.ok;
    }

    if (!wranglerAvailable()) {
      return fail('wrangler is not available. Run `bun install` first.', EXIT.unavailable);
    }

    return executePlan(plan, parsed.environment, argv).code;
  },
};