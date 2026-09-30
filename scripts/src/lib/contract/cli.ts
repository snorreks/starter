// scripts/src/lib/contract/cli.ts
//
//   bun run contract new "<title>" [--mode standard|full]
//   bun run contract run <path> [--dry-run]
//   bun run contract status
//
// Creating a contract writes a file. It does not schedule a run, open a pull
// request, merge anything, or deploy anything. The runner has no code path that
// could do any of those, and this CLI does not call git or Wrangler at all.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../guards/boundary.ts';
import { createManifest, MODES, type RunMode, runContract, type StageOutcome } from './runner.ts';

export const CONTRACTS_DIR = join(REPO_ROOT, 'docs/contracts');
const RUNS_DIR = join(REPO_ROOT, '.pi/contract-runs');

const slugify = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Next numeric contract id. Reads the directory rather than a counter file. */
export const nextContractId = (dir = CONTRACTS_DIR): string => {
  if (!existsSync(dir)) {
    return 'C-001';
  }
  const highest = readdirSync(dir)
    .map((name) => /^C-(\d+)/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .reduce((max, match) => Math.max(max, Number(match[1])), 0);
  return `C-${String(highest + 1).padStart(3, '0')}`;
};

const THIN_TEMPLATE = 'THIN_TEMPLATE.md';
const FULL_TEMPLATE = 'TEMPLATE.md';

export const scaffold = (title: string, mode: RunMode): string => {
  const id = nextContractId();
  const templatePath = join(CONTRACTS_DIR, mode === 'full' ? FULL_TEMPLATE : THIN_TEMPLATE);

  if (!existsSync(templatePath)) {
    throw new Error(`No template at ${templatePath}.`);
  }

  const body = readFileSync(templatePath, 'utf8')
    .replace(/\{\{TITLE\}\}/g, title)
    .replace(/\{\{ID\}\}/g, id)
    .replace(/\{\{TYPE\}\}/g, mode);

  mkdirSync(CONTRACTS_DIR, { recursive: true });
  const path = join(CONTRACTS_DIR, `${id}-${slugify(title)}.md`);
  writeFileSync(path, body);
  return path;
};

/**
 * A dry adapter.
 *
 * `--dry-run` uses this so the plan can be inspected without a model provider.
 * It performs no work and reports that plainly; it does not pretend to verify
 * anything, and its output says "dry-run" rather than "passed".
 */
const dryAdapter = {
  async runStage(stage: string): Promise<StageOutcome> {
    return { ok: true, summary: `dry-run: would execute "${stage}"` };
  },
};

export const main = async (args: readonly string[]): Promise<number> => {
  const [command, ...rest] = args;

  if (command === 'new') {
    const title = rest.find((value) => !value.startsWith('--'));
    if (title === undefined) {
      process.stderr.write('Usage: bun run contract new "<title>" [--mode standard|full]\n');
      return 2;
    }
    const modeIndex = rest.indexOf('--mode');
    const mode: RunMode =
      modeIndex !== -1 && (rest[modeIndex + 1] === 'full' || rest[modeIndex + 1] === 'standard')
        ? (rest[modeIndex + 1] as RunMode)
        : 'standard';

    const path = scaffold(title, mode);
    process.stdout.write(
      `Created ${path}\n\n` +
        `Stages: ${MODES[mode].join(' -> ')}\n\n` +
        'This created a document. Nothing has been run, merged or deployed.\n' +
        `Next: edit the acceptance criteria, then \`bun run contract run ${path}\`\n`,
    );
    return 0;
  }

  if (command === 'run') {
    const path = rest.find((value) => !value.startsWith('--'));
    if (path === undefined) {
      process.stderr.write('Usage: bun run contract run <path-to-contract>\n');
      return 2;
    }
    if (!existsSync(path)) {
      process.stderr.write(`No contract at ${path}.\n`);
      return 1;
    }

    const manifest = createManifest('adhoc', 'standard', Date.now());
    process.stdout.write(
      `Run ${manifest.runId}\nStages: ${manifest.plannedStages.join(' -> ')}\n\n`,
    );

    const result = await runContract(manifest, dryAdapter);
    if (!result.ok) {
      process.stderr.write(`Blocked: ${result.reason}\n`);
      return 1;
    }
    for (const [stage, summary] of Object.entries(result.summaries)) {
      process.stdout.write(`  ${stage}: ${summary}\n`);
    }
    process.stdout.write(
      '\nDry run only. No model provider was called and nothing was verified.\n',
    );
    return 0;
  }

  process.stderr.write(
    'Usage:\n' +
      '  bun run contract new "<title>" [--mode standard|full]\n' +
      '  bun run contract run <path>\n' +
      '  bun run contract status\n',
  );
  return 2;
};

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}

export { RUNS_DIR };
