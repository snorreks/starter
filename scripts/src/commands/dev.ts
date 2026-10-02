// scripts/src/commands/dev.ts
//
// Thin adapter for the local development processes.
//
// `dev app` is the only implementation of "run the application locally". There used
// to be two: this module drove a separate API Worker with `wrangler dev` while a
// Vite dev server served the pages and proxied `/api` to it. They disagreed about
// ports, about where the log file went, and about whether the child survived
// teardown — so a command that worked from the repository root failed from the
// application directory. One implementation, one owner.

import { main as devAppMain } from '../dev-app.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';

const USAGE = [
  'Usage: dev app|built',
  '',
  'Runs the application on PORT (default 5173) and captures its log stream to',
  '.wrangler/logs/app.ndjson inside this checkout.',
  '',
  'One process serves the pages, the assets and /api/*. The Worker bindings — D1',
  'included — come from apps/frontend/client/wrangler.jsonc, so the local API is',
  'the same code path production uses, with no proxy in between.',
  '',
  'Modes:',
  '  app     the Vite dev server. Fast, with hot reload. Runs the server code in',
  '          Node, where cloudflare:workers is a stub and workerd is not involved.',
  '  built   the compiled .svelte-kit/cloudflare/_worker.js in real workerd. Slower,',
  '          and the only mode that can see a bundling mistake. Requires a build.',
  '',
  'State is per-checkout, so two worktrees on one machine run independently. The',
  "child's exit status is this command's exit status, and signals are forwarded,",
  'so a caller that starts and stops the server gets a truthful result.',
].join('\n');

export const devCommand: Command = {
  name: 'dev',
  summary: 'run a local development process',
  usage: USAGE,

  run(argv) {
    if (argv.length === 0) {
      return fail(USAGE, EXIT.usage);
    }
    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }

    const [target] = argv;
    if (target !== 'app' && target !== 'built') {
      return fail(`Unknown dev target "${target}".\n${USAGE}`, EXIT.usage);
    }
    return devAppMain(target);
  },
};
