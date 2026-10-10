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
//
// This module owns the question "what should be running", and nothing else. The
// answer is a *stack*: a named set of local services, resolved in `dev-stack.ts`
// and started through the one lifecycle in `local/service.ts`. A bare `bun run
// dev` on a terminal asks; with a flag it never does, so the answer a script gets
// is the answer it wrote down.

import { main as devAppMain } from '../dev-app.ts';
import { DEV_STACK_NAMES, resolveStack, stackChoices } from '../dev-stack.ts';
import { LOCAL_SERVICE_IDS } from '../local/service.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';
import { askOnce, canAsk } from '../shared/prompt.ts';

const STACK_CHOICES = stackChoices().map((choice) => ({
  id: choice.id,
  label: choice.id.padEnd(10),
  detail: `${choice.services.join(', ')} — ${choice.detail}`,
}));

const USAGE = [
  'Usage: bun run dev [--stack <name|services>]',
  '       bun run dev app|built [--stack <name|services>]',
  '',
  'Runs the application and the local services it needs, and captures the',
  "application's log stream to .wrangler/logs/app.ndjson inside this checkout.",
  '',
  'One process serves the pages, the assets and /api/*. The Worker bindings,',
  'included — come from apps/frontend/client/wrangler.jsonc, so the local API is',
  'the same code path production uses, with no proxy in between.',
  '',
  'Stacks:',
  ...STACK_CHOICES.map((choice, index) => `  ${index + 1}) ${choice.label}${choice.detail}`),
  '',
  '  Services can be combined by name:  --stack supabase,stripe',
  `  Every service individually:      ${LOCAL_SERVICE_IDS.join(', ')}`,
  '',
  'Modes (app is the default):',
  '  app     the Vite dev server. Fast, with hot reload. Runs the server code in',
  '          Node, where cloudflare:workers is a stub and workerd is not involved.',
  '  built   the compiled .svelte-kit/cloudflare/_worker.js in real workerd. Slower,',
  '          and the only mode that can see a bundling mistake. Requires a build.',
  '',
  'With no arguments and no terminal this refuses rather than guessing a stack:',
  'a stack that silently started everything would build a container on a laptop',
  'that was only trying to look at a page. Use:  bun run dev --stack client',
].join('\n');

const parseStackFlag = (argv: readonly string[]): { spec?: string; rest: string[] } => {
  const rest: string[] = [];
  let spec: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--stack' || arg === '--profile') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { spec: '', rest: [...argv.slice(0, index), ...argv.slice(index + 1)] };
      }
      spec = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--stack=')) {
      spec = arg.slice('--stack='.length);
      continue;
    }
    rest.push(arg);
  }
  return { spec, rest };
};

export const devCommand: Command = {
  name: 'dev',
  summary: 'run a local development process',
  usage: USAGE,

  async run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }

    const { spec, rest } = parseStackFlag(argv);
    const [target] = rest;
    if (target !== undefined && target !== 'app' && target !== 'built') {
      return fail(`Unknown dev target "${target}".\n${USAGE}`, EXIT.usage);
    }

    // A mode word means the caller was specific. Without one, the stack is the
    // question, and the question is asked — or refused.
    const mode = target === 'built' ? 'built' : 'app';
    let stackSpec = spec;

    if (stackSpec === undefined) {
      if (target !== undefined) {
        // `bun run dev app` keeps its historical meaning: the app and its database.
        stackSpec = 'client';
      } else if (!canAsk()) {
        return fail(
          'No stack named, and this is not an interactive terminal.\n' +
            `  Named stacks: ${DEV_STACK_NAMES.join(', ')}\n` +
            '  Example:      bun run dev --stack client\n' +
            '  Or name a mode: bun run dev app --stack full',
          EXIT.usage,
        );
      } else {
        const chosen = await askOnce('What should this run start?', STACK_CHOICES);
        if (chosen === null || chosen.length === 0) {
          return fail('Cancelled.', EXIT.ok);
        }
        stackSpec = chosen.join(',');
      }
    }

    if (stackSpec === '') {
      return fail(`--stack needs a value.\n${USAGE}`, EXIT.usage);
    }

    // The application itself is a service in the registry's `requires`, so `--stack
    // stripe` still brings up the database the app reads from.
    const resolved = resolveStack(stackSpec);
    if (!resolved.ok) {
      return fail(`${resolved.problem}\n  ${resolved.remedy}`, EXIT.usage);
    }

    return devAppMain(mode, resolved.services);
  },
};
