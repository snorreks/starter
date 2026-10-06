import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative } from 'node:path';
import { readWorkspacePackages } from '../guards/module_graph.ts';
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

/** Dependency fields a pinned range may be written back into. */
const PINNED_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/**
 * The pinned ranges declared by `.syncpackrc`, keyed by package name.
 *
 * That file is the repository's stated policy for the packages whose newest major
 * is not automatically safe — `typescript` and `@biomejs/biome` — and it is read
 * rather than restated here, so a pin changed in one place is the pin this lane
 * honours. It is read rather than *enforced* because no script in this repository
 * runs `syncpack`: the config existed with nothing checking it, which is how
 * `typescript` came to be installed at 7.x against a group pinning `6.0.3`.
 */
export const readPinnedRanges = (root: string): ReadonlyMap<string, string> => {
  const path = join(root, '.syncpackrc');
  if (!existsSync(path)) {
    return new Map();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `.syncpackrc is not readable JSON: ${error instanceof Error ? error.message : 'unknown cause'}`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('.syncpackrc must be a JSON object.');
  }
  const groups = (raw as { semverGroups?: unknown }).semverGroups;
  if (!Array.isArray(groups)) {
    throw new Error('.syncpackrc declares no semverGroups, so nothing holds a pin.');
  }
  const pins = new Map<string, string>();
  for (const [index, group] of groups.entries()) {
    if (typeof group !== 'object' || group === null || Array.isArray(group)) {
      throw new Error(`.syncpackrc semverGroups[${index}] must be an object.`);
    }
    const { packages, range } = group as { packages?: unknown; range?: unknown };
    if (!Array.isArray(packages) || packages.some((name) => typeof name !== 'string')) {
      throw new Error(`.syncpackrc semverGroups[${index}] needs a packages array of names.`);
    }
    if (typeof range !== 'string' || range.length === 0) {
      throw new Error(`.syncpackrc semverGroups[${index}] needs a non-empty range.`);
    }
    for (const name of packages as string[]) {
      const held = pins.get(name);
      if (held !== undefined && held !== range) {
        throw new Error(
          `.syncpackrc pins ${name} to both ${held} and ${range}. One package cannot hold two ranges.`,
        );
      }
      pins.set(name, range);
    }
  }
  return pins;
};

/**
 * Every manifest that can declare a dependency: the root plus each workspace
 * package, discovered from the root manifest rather than listed, so a package
 * added to the repository is covered the moment it exists.
 */
const dependencyManifests = (root: string): string[] => [
  join(root, 'package.json'),
  ...[...readWorkspacePackages(root).values()].map((pkg) => join(root, pkg.dir, 'package.json')),
];

/** One declared range that the `--latest` sweep moved off its pin. */
export interface PinRestore {
  readonly path: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Put every pinned package back on its declared range, in every manifest that
 * declares it.
 *
 * Runs after resolution and before anything installs. `--latest` resolves a
 * pinned package to its newest major regardless of what the manifest says, and an
 * install at that point runs every `prepare` script against a tree built from a
 * range the repository has ruled out — so restoring afterwards would be restoring
 * after the failure, not before it.
 */
export const restorePinnedRanges = (options: {
  root: string;
  pins: ReadonlyMap<string, string>;
}): PinRestore[] => {
  const restored: PinRestore[] = [];
  for (const path of dependencyManifests(options.root)) {
    if (!existsSync(path)) {
      continue;
    }
    const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      throw new Error(`${relative(options.root, path)} is not a JSON object.`);
    }
    const record = manifest as Record<string, unknown>;
    let changed = false;
    for (const field of PINNED_FIELDS) {
      const table = record[field];
      if (typeof table !== 'object' || table === null || Array.isArray(table)) {
        continue;
      }
      const declared = table as Record<string, unknown>;
      for (const [name, pin] of options.pins) {
        const current = declared[name];
        if (typeof current === 'string' && current !== pin) {
          declared[name] = pin;
          restored.push({ path: relative(options.root, path), name, from: current, to: pin });
          changed = true;
        }
      }
    }
    if (changed) {
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    }
  }
  return restored;
};

/** The version `bun.lock` resolved a package to, or null when it resolves none. */
const lockedVersion = (root: string, name: string): string | null => {
  const lockPath = join(root, 'bun.lock');
  if (!existsSync(lockPath)) {
    return null;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Whitespace between the key and its array is Bun's formatting to choose, not
  // ours: matching it exactly would pass against this repository's lockfile and
  // fail against any writer that does not indent it the same way.
  const found = new RegExp(`"${escaped}":\\s*\\["${escaped}@([^"@]+)`).exec(
    readFileSync(lockPath, 'utf8'),
  );
  return found?.[1] ?? null;
};

/**
 * Fail when a pin did not survive the install.
 *
 * Restoring is not the same as holding: `bun install` rewrites a range it
 * considers non-canonical, and the lockfile — not the manifest — decides the
 * version that reaches `node_modules`. Both are checked, because the failure this
 * exists to catch otherwise surfaces much later as whatever a consumer does with
 * an API the wrong major does not have.
 */
export const verifyPinnedRanges = (options: {
  root: string;
  pins: ReadonlyMap<string, string>;
}): void => {
  const problems: string[] = [];
  for (const path of dependencyManifests(options.root)) {
    if (!existsSync(path)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    for (const field of PINNED_FIELDS) {
      const table = manifest[field];
      if (typeof table !== 'object' || table === null || Array.isArray(table)) {
        continue;
      }
      for (const [name, pin] of options.pins) {
        const declared = (table as Record<string, unknown>)[name];
        if (typeof declared === 'string' && declared !== pin) {
          problems.push(
            `${relative(options.root, path)} declares ${name} ${declared}, not the pinned ${pin}`,
          );
        }
      }
    }
  }
  for (const [name, pin] of options.pins) {
    // A range pin is a policy statement, not a resolvable version; only an exact
    // pin says what the lockfile must contain.
    if (!/^\d+\.\d+\.\d+$/.test(pin)) {
      continue;
    }
    const locked = lockedVersion(options.root, name);
    if (locked === null) {
      problems.push(`bun.lock has no resolution for ${name}, expected the pinned ${pin}`);
    } else if (locked !== pin) {
      problems.push(`bun.lock resolves ${name} to ${locked}, not the pinned ${pin}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Pinned ranges did not hold after the update:\n  ${problems.join('\n  ')}\n` +
        'A pin changed deliberately is a change to .syncpackrc and every manifest that declares it.',
    );
  }
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
        'packages: bun update --recursive --latest --exact --lockfile-only, then restore and\n' +
        '  verify every .syncpackrc pin, then bun install. Major upgrades are included except\n' +
        '  where a pin in .syncpackrc excludes one.\n' +
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
      const pins = readPinnedRanges(root);
      const held = pins.size > 0 ? [...pins.keys()].join(', ') : 'none';
      write(`Pinned ranges from .syncpackrc: ${held}`);
      // `--lockfile-only` resolves and writes every manifest without installing,
      // so no `prepare` script runs against a tree built from a pinned major that
      // is about to be restored. The install that follows is the first one that
      // touches node_modules, and it installs the restored ranges.
      await execute({
        command: bun,
        args: ['update', '--recursive', '--latest', '--exact', '--lockfile-only'],
      });
      const restored = restorePinnedRanges({ root, pins });
      for (const entry of restored) {
        write(`  restored ${entry.name} ${entry.from} → ${entry.to} in ${entry.path}`);
      }
      await execute({ command: bun, args: ['install'] });
      verifyPinnedRanges({ root, pins });
      write(
        restored.length === 0
          ? 'Every pinned range already held; nothing to restore.'
          : `Restored ${restored.length} pinned range(s) and verified them against bun.lock.`,
      );
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
