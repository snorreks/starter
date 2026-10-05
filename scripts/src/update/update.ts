import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { checkMirrors } from '../setup/pins.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { type BoundedResult, runBounded } from '../shared/run_bounded.ts';

/** Independent update lanes, ordered so packages use the selected Bun runtime. */
export const UPDATE_LANES = ['nix', 'bun', 'packages'] as const;
export type UpdateLane = (typeof UPDATE_LANES)[number];

/** Selected work; no selected flags means all lanes, never no work. */
export interface UpdateOptions {
  lanes: readonly UpdateLane[];
  yes: boolean;
  verify: boolean;
  bunVersion?: string;
}

/** Strict update arguments: typos must not widen the update to all components. */
export const parseUpdateArgs = (args: readonly string[]): UpdateOptions => {
  const selected = new Set<UpdateLane>();
  const excluded = new Set<UpdateLane>();
  let yes = false;
  let verify = false;
  let bunVersion: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === '--verify') {
      verify = true;
      continue;
    }
    if (arg === '--bun-version') {
      bunVersion = args[++index];
      if (bunVersion === undefined || !/^\d+\.\d+\.\d+$/.test(bunVersion)) {
        throw new Error('--bun-version requires a stable exact version, for example 1.4.2.');
      }
      selected.add('bun');
      continue;
    }
    const lane = UPDATE_LANES.find((lane) => arg === `--${lane}` || arg === `--no-${lane}`);
    if (lane === undefined) {
      throw new Error(
        `Unknown update argument. Use --nix, --bun, --packages, --no-<lane>, --bun-version, --verify or --yes.`,
      );
    }
    if (arg === `--no-${lane}`) {
      excluded.add(lane);
    } else {
      selected.add(lane);
    }
  }
  if ([...selected].some((lane) => excluded.has(lane))) {
    throw new Error('A lane cannot be both selected and excluded.');
  }
  const lanes = UPDATE_LANES.filter(
    (lane) => (selected.size === 0 || selected.has(lane)) && !excluded.has(lane),
  );
  if (lanes.length === 0) {
    throw new Error('No update lanes selected.');
  }
  return { lanes, yes, verify, ...(bunVersion === undefined ? {} : { bunVersion }) };
};

const BUN_ASSETS = {
  'x86_64-linux': 'bun-linux-x64-baseline.zip',
  'aarch64-linux': 'bun-linux-aarch64.zip',
  'aarch64-darwin': 'bun-darwin-aarch64.zip',
} as const;

/** Discover all workflow literals instead of maintaining a second mirror list. */
export const bunPinEdits = (options: {
  root: string;
  version: string;
  sources: Record<string, string>;
}): ReadonlyMap<string, string> => {
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error('Bun pin must be a stable exact version.');
  }
  const path = join(options.root, 'config/toolchain.json');
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('config/toolchain.json must be an object.');
  }
  const config = { ...raw, bun: options.version, bunSources: options.sources };
  const changes = new Map<string, string>([
    [path, `${JSON.stringify(config, null, 2)}\n`],
    [join(options.root, '.bun-version'), `${options.version}\n`],
  ]);
  for (const file of new Bun.Glob('.github/workflows/*.{yml,yaml}').scanSync({
    cwd: options.root,
  })) {
    const path = join(options.root, file);
    const source = readFileSync(path, 'utf8');
    if (!source.includes('oven-sh/setup-bun@')) {
      continue;
    }
    if (!/^\s*BUN_VERSION:/m.test(source)) {
      throw new Error(`Cannot update ${file}: setup-bun has no BUN_VERSION mirror.`);
    }
    changes.set(path, source.replace(/^(\s*BUN_VERSION:)\s*[^\n]+$/gm, `$1 '${options.version}'`));
  }
  return changes;
};

interface UpdateDependencies {
  root?: string;
  run?: typeof runBounded;
  fetch?: typeof globalThis.fetch;
  write?: (text: string) => void;
}

const stableBunVersion = async (doFetch: typeof globalThis.fetch): Promise<string> => {
  const response = await doFetch('https://api.github.com/repos/oven-sh/bun/releases/latest', {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(
      `Bun release lookup failed: HTTP ${response.status}. Use --bun-version to select a reviewed release.`,
    );
  }
  const release: unknown = await response.json();
  if (
    typeof release !== 'object' ||
    release === null ||
    !('tag_name' in release) ||
    typeof release.tag_name !== 'string'
  ) {
    throw new Error('Bun release lookup returned no tag.');
  }
  const version = /^bun-v(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1];
  if (version === undefined) {
    throw new Error('Bun release lookup did not name a stable version.');
  }
  return version;
};

/** Execute the selected updates, stopping on the first real failure. Never cached. */
export const runUpdate = async (
  options: UpdateOptions,
  dependencies: UpdateDependencies = {},
): Promise<number> => {
  const root = dependencies.root ?? REPO_ROOT;
  const run = dependencies.run ?? runBounded;
  const write = dependencies.write ?? ((text: string) => process.stdout.write(`${text}\n`));
  if (!options.yes) {
    write(
      `Update preview (no writes, no network): ${options.lanes.join(' → ')}\n` +
        'nix: update flake.lock; bun: pin stable release + verified Nix sources + CI mirrors;\n' +
        'packages: bun update --recursive --latest --exact (including .pi workspace).\n' +
        'Apply with --yes; add --verify for lint, typecheck and unit tests. Major upgrades are included.',
    );
    return 0;
  }
  const execute = async (options: {
    command: string;
    args: readonly string[];
  }): Promise<BoundedResult> => {
    const result = await run({
      ...options,
      cwd: root,
      env: { ...process.env, PATH: `${dirname(bun)}${delimiter}${process.env.PATH ?? ''}` },
    });
    if (result.code !== 0) {
      write(result.stdout);
      write(result.stderr);
      throw new Error(
        `Update step failed: ${options.command} ${options.args.join(' ')} (exit ${result.code}). Changes already made remain for review; no automatic rollback.`,
      );
    }
    return result;
  };
  // Check every requested external prerequisite before changing any file.
  if (options.lanes.includes('nix') || options.lanes.includes('bun')) {
    const probe = await run({ command: 'nix', args: ['--version'], cwd: root, timeoutMs: 5_000 });
    if (probe.code !== 0) {
      write(
        'Nix is required for --nix/--bun. Bun is built from verified release sources, never globally self-upgraded. For non-Nix package updates use --packages.',
      );
      return 3;
    }
  }
  let bun = process.execPath;
  try {
    if (options.lanes.includes('nix')) {
      write('Updating Nix flake inputs…');
      await execute({ command: 'nix', args: ['flake', 'update'] });
    }
    if (options.lanes.includes('bun')) {
      const version =
        options.bunVersion ?? (await stableBunVersion(dependencies.fetch ?? globalThis.fetch));
      const sources: Record<string, string> = {};
      for (const [system, asset] of Object.entries(BUN_ASSETS)) {
        const result = await execute({
          command: 'nix',
          args: [
            'store',
            'prefetch-file',
            '--json',
            `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${asset}`,
          ],
        });
        const parsed: unknown = JSON.parse(result.stdout);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('hash' in parsed) ||
          typeof parsed.hash !== 'string' ||
          !/^sha256-[A-Za-z0-9+/]{43}=$/.test(parsed.hash)
        ) {
          throw new Error(`No SHA-256 returned for Bun ${system}. Pins have not been written.`);
        }
        sources[system] = parsed.hash;
      }
      // Prepare every edit before writing: a missing mirror cannot leave a partial bump.
      const edits = bunPinEdits({ root, version, sources });
      for (const [path, content] of edits) {
        if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
          writeFileSync(path, content);
        }
      }
      write(`Bun pin and all mirrors: ${version}. Building the verified runtime…`);
      const built = await execute({
        command: 'nix',
        args: ['build', '--no-link', '--print-out-paths', '.#bun'],
      });
      const paths = built.stdout.trim().split('\n');
      if (paths.length !== 1 || !paths[0]?.startsWith('/nix/store/')) {
        throw new Error('Nix did not return one Bun store path.');
      }
      bun = join(paths[0], 'bin/bun');
      const runtime = await execute({ command: bun, args: ['--version'] });
      if (runtime.stdout.trim() !== version) {
        throw new Error('Built Bun does not match the selected pin.');
      }
    }
    if (options.lanes.includes('packages')) {
      write('Updating exact-pinned dependencies in every Bun workspace…');
      await execute({ command: bun, args: ['update', '--recursive', '--latest', '--exact'] });
    } else if (options.lanes.includes('bun')) {
      // Regenerate the shared lockfile with the selected runtime, not the old one.
      await execute({ command: bun, args: ['install'] });
    }
    const drift = checkMirrors(root);
    if (drift.length > 0) {
      throw new Error(`Version mirror drift: ${drift.map((entry) => entry.mirror).join(', ')}`);
    }
    await execute({ command: bun, args: ['run', 'guard'] });
    if (options.verify) {
      for (const command of ['lint', 'typecheck', 'test']) {
        write(`Verifying ${command}…`);
        await execute({ command: bun, args: ['run', command] });
      }
    }
    write(
      'Selected updates completed. Review git diff, then run the browser/Worker/E2E lanes. Re-enter nix develop (or direnv reload) after Nix/Bun changes; the running shell cannot replace itself.',
    );
    return 0;
  } catch (error) {
    write(error instanceof Error ? error.message : 'Update failed.');
    return 1;
  }
};
