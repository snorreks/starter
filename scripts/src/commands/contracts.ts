// scripts/src/commands/contracts.ts
//
//   bun run contract new "<title>" [--mode standard|full]
//   bun run contract run <path> [--dry-run] [--resume [runId]]
//   bun run contract status
//
// Creating a contract writes a file. It does not schedule a run, open a pull
// request, merge anything, or deploy anything.
//
// `run` without `--dry-run` reports that no execution adapter is available and
// exits 3. It does not silently run the dry adapter. A previous version always
// invoked the dry adapter regardless of the flag, printed the stages, and exited
// 0 — so a non-dry run reported success having done nothing. Phase 5 supplies the
// real Pi adapter; until then the honest exit is "unavailable", not "passed".
//
// Exit codes:
//   0  accepted, or a dry run completed (reported as `dry_run`, never as accepted)
//   1  blocked
//   2  usage error
//   3  execution requested but no real adapter is available

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';
import {
  createManifest,
  type RunManifest,
  type RunMode,
  runContract,
  type StageAdapter,
  type StageOutcome,
} from '../contracts/runner.ts';
import { readContracts } from '../contracts/status.ts';
import type { Command } from '../shared/command.ts';

export const CONTRACTS_DIR = join(REPO_ROOT, 'docs/contracts');
export const RUNS_DIR = join(REPO_ROOT, '.pi/contract-runs');

// Named for this command's domain: `blocked` is a contract that cannot proceed,
// not the same thing as `failed`. The shared EXIT in ../shared/command.ts uses
// `failed` and `unavailable`; the numeric values are identical so a caller
// wrapping either gets the same meaning from the same code.
const EXIT = {
  ok: 0,
  blocked: 1,
  usage: 2,
  adapterUnavailable: 3,
} as const;

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

export interface ParsedContract {
  id: string;
  mode: RunMode;
  title: string;
  path: string;
  body: string;
}

const fieldOf = (body: string, key: string): string | undefined => {
  // The templates write `**Type:** full` / `**Status:** draft` in the body. A
  // front-matter parser finds nothing, which is why `contract status` used to
  // print `unknown` for every column of every row.
  const match = new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.+)$`, 'm').exec(body);
  return match?.[1]?.trim();
};

/**
 * Read the contract's own identity and mode from its content.
 *
 * The runner is driven by what the document says, not by a hardcoded `'adhoc'`.
 */
export const parseContract = (path: string): ParsedContract => {
  const body = readFileSync(path, 'utf8');
  const heading = /^#\s+(\S+)\s+—\s+(.+)$/m.exec(body);

  const idFromHeading = heading?.[1];
  const idFromName = /^C-(\d+)/.exec(path.split('/').pop() ?? '');

  const id = idFromHeading ?? (idFromName ? `C-${idFromName[1]}` : 'C-000');
  const declared = fieldOf(body, 'Type');
  const mode: RunMode = declared === 'full' ? 'full' : 'standard';

  return { id, mode, title: heading?.[2]?.trim() ?? id, path, body };
};

/** Current source revision, recorded on the manifest so evidence can bind to it. */
export const currentRevision = (): string | undefined => {
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: REPO_ROOT });
  if (head.exitCode !== 0) {
    return undefined;
  }
  const value = head.stdout.toString().trim();
  return value.length === 0 ? undefined : value;
};

const runPath = (runId: string, dir = RUNS_DIR): string => join(dir, `${runId}.json`);

/**
 * Persist a manifest.
 *
 * Atomic: written to a sibling temp file and renamed. A run state file truncated
 * by an interrupted write is a run that can never be resumed, which is worse than
 * no resume at all.
 */
export const saveManifest = (manifest: RunManifest, dir = RUNS_DIR): void => {
  mkdirSync(dir, { recursive: true });
  const target = runPath(manifest.runId, dir);
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temp, target);
};

export const loadManifest = (runId: string, dir = RUNS_DIR): RunManifest | undefined => {
  const path = runPath(runId, dir);
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as RunManifest;
};

export const listRuns = (dir = RUNS_DIR): RunManifest[] => {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as RunManifest);
};

/** Most recent run for a contract, or the newest run overall. */
export const findResumable = (contractId?: string, dir = RUNS_DIR): RunManifest | undefined => {
  const runs = listRuns(dir).filter(
    (run) => run.state === 'blocked' || run.state === 'in_progress',
  );
  const matching =
    contractId === undefined ? runs : runs.filter((run) => run.contractId === contractId);
  return matching.sort((a, b) => b.startedAt - a.startedAt)[0];
};

/**
 * The dry adapter.
 *
 * Performs no work and says so. It exists so `--dry-run` can show the lifecycle
 * without a model provider. Its output is never acceptance evidence — a dry run
 * ends in `dry_run`, and `runContract` refuses to promote it to `accepted`.
 */
const dryAdapter: StageAdapter = {
  async runStage(stage): Promise<StageOutcome> {
    return { ok: true, summary: `dry-run: would execute "${stage}"` };
  },
};

const describeManifest = (manifest: RunManifest): string => {
  const rows = manifest.plannedStages.map((stage) => {
    const record = manifest.stages[stage];
    const status = record?.status ?? 'pending';
    const attempts = record?.attempts ?? 0;
    const evidence = record?.evidence === undefined ? '' : ' [evidence]';
    return `  ${stage.padEnd(10)} ${status.padEnd(10)} attempts=${attempts}${evidence}`;
  });
  return [
    `${manifest.runId}  contract=${manifest.contractId}  mode=${manifest.mode}`,
    ...rows,
  ].join('\n');
};

const usage = (): string =>
  [
    'Usage:',
    '  bun run contract new "<title>" [--mode standard|full]',
    '  bun run contract run <path> [--dry-run] [--resume [runId]]',
    '  bun run contract status [runId]',
    '',
    'Exit codes: 0 accepted/dry-run, 1 blocked, 2 usage, 3 no execution adapter available.',
  ].join('\n');

export const main = async (args: readonly string[]): Promise<number> => {
  const [command, ...rest] = args;

  if (command === 'new') {
    const title = rest.find((value) => !value.startsWith('-'));
    if (title === undefined) {
      process.stderr.write('Usage: bun run contract new "<title>" [--mode standard|full]\n');
      return EXIT.usage;
    }
    const modeIndex = rest.indexOf('--mode');
    const mode: RunMode =
      rest[modeIndex + 1] === 'full' || rest[modeIndex + 1] === 'standard'
        ? (rest[modeIndex + 1] as RunMode)
        : 'standard';

    const path = scaffold(title, mode);
    process.stdout.write(
      `Created ${path}\n\n` +
        'This created a document. Nothing has been run, merged or deployed.\n' +
        `Next: edit the acceptance criteria, then \`bun run contract run ${path}\`\n`,
    );
    return EXIT.ok;
  }

  if (command === 'status') {
    const wanted = rest.find((value) => !value.startsWith('-'));

    if (wanted !== undefined) {
      const manifest = loadManifest(wanted);
      if (manifest === undefined) {
        process.stderr.write(`No run named ${wanted} in ${RUNS_DIR}.\n`);
        return EXIT.blocked;
      }
      process.stdout.write(`${describeManifest(manifest)}\n\nstate: ${manifest.state}\n`);
      return EXIT.ok;
    }

    const contracts = readContracts();
    if (contracts.length === 0) {
      process.stdout.write('No contracts yet. Create one with: bun run contract new "<title>"\n');
      return EXIT.ok;
    }

    process.stdout.write(`${contracts.length} contract(s)\n\n`);
    for (const row of contracts) {
      process.stdout.write(
        `  ${row.id.padEnd(8)} ${row.type.padEnd(9)} ${row.status.padEnd(10)} ${row.file}\n`,
      );
    }

    const runs = listRuns();
    if (runs.length === 0) {
      return EXIT.ok;
    }

    process.stdout.write(`\n${runs.length} run(s)\n\n`);
    for (const run of runs) {
      const failed = Object.values(run.stages).filter((stage) => stage.status === 'failed');
      process.stdout.write(
        `  ${run.runId.padEnd(28)} ${run.state.padEnd(11)} ${run.contractId}` +
          `${failed.length === 0 ? '' : `  (${failed.map((stage) => stage.stage).join(', ')} failed)`}\n`,
      );
    }
    return EXIT.ok;
  }

  if (command === 'run') {
    const path = rest.find((value) => !value.startsWith('-'));
    if (path === undefined) {
      process.stderr.write('Usage: bun run contract run <path-to-contract> [--dry-run]\n');
      return EXIT.usage;
    }
    if (!existsSync(path)) {
      process.stderr.write(`No contract at ${path}.\n`);
      return EXIT.blocked;
    }

    const contract = parseContract(path);
    const dryRun = rest.includes('--dry-run');
    const resumeIndex = rest.indexOf('--resume');
    const resuming = resumeIndex !== -1;
    const requestedRunId = resuming ? rest[resumeIndex + 1] : undefined;

    // Resume takes precedence over creating a new manifest: the whole point is to
    // continue the run whose failed stages must not be skipped.
    let existing: RunManifest | undefined;
    if (requestedRunId !== undefined) {
      existing = loadManifest(requestedRunId);
    } else if (resuming) {
      existing = findResumable(contract.id);
    }

    if (resuming && existing === undefined) {
      process.stderr.write(
        'Nothing to resume. Pass a run id (`--resume run-…`) or start without it.\n',
      );
      return EXIT.blocked;
    }

    if (existing !== undefined && existing.contractId !== contract.id) {
      process.stderr.write(
        `Run ${existing.runId} belongs to contract ${existing.contractId}, not ${contract.id}.\n`,
      );
      return EXIT.usage;
    }

    if (!dryRun && existing === undefined) {
      process.stderr.write(
        'No execution adapter is available.\n\n' +
          '`contract run` performs work through a bounded Pi adapter, which phase 5 wires up.\n' +
          'Until then this command refuses rather than running the dry adapter and reporting\n' +
          'success. To inspect the lifecycle without a model provider, use --dry-run:\n\n' +
          '  bun run contract run ' +
          path +
          ' --dry-run\n',
      );
      return EXIT.adapterUnavailable;
    }

    const manifest =
      existing ??
      createManifest(contract.id, contract.mode, Date.now(), {
        dryRun,
        sourceRevision: currentRevision(),
      });

    process.stdout.write(`${describeManifest(manifest)}\n\n${dryRun ? 'DRY RUN\n\n' : ''}`);
    saveManifest(manifest);

    const result = await runContract(manifest, dryAdapter);

    // Persist whatever happened, including a blocked stage's status. A resume that
    // cannot see the failure is the bug this whole area started with.
    saveManifest(result.manifest);

    if (!result.ok) {
      process.stderr.write(`Blocked: ${result.reason}\n`);
      process.stdout.write(`\n${describeManifest(result.manifest)}\n`);
      return EXIT.blocked;
    }

    process.stdout.write(`${describeManifest(result.manifest)}\n`);

    if (result.manifest.state === 'dry_run') {
      process.stdout.write(
        '\nDry run complete. Nothing was executed, nothing was verified, and this run is ' +
          'recorded as dry_run — not accepted.\n',
      );
      return EXIT.ok;
    }

    process.stdout.write('\nAccepted.\n');
    return EXIT.ok;
  }

  process.stderr.write(`${usage()}\n`);
  return EXIT.usage;
};

/** Dispatcher descriptor. The argv work above is the whole implementation. */
export const contractCommand: Command = {
  name: 'contract',
  summary: 'create, run and inspect implementation contracts',
  usage: 'contract new|run|status|list|cancel [options]',
  run: main,
};
