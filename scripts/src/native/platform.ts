// scripts/src/native/platform.ts
//
// What the native commands actually run: argv, cwd, and what has to be true first.
//
// Split from `commands/native.ts` for one reason, and it is the reason this
// repository's other tooling is written the way it is: the decision can be tested
// without a Rust toolchain, a webview or a display. Every command below is a
// function of its arguments, so `scripts/tests/native_cli.test.ts` asserts the
// exact argv a maintainer will see in CI, on a machine that cannot build a Tauri
// app at all.
//
// Three things this deliberately refuses to do, each of which the snapshot's
// launcher did:
//
//   1. **No platform/target mixing, and no platform flags the CLI does not have.**
//     A Rust target is a *triple* (`x86_64-unknown-linux-gnu`), a desktop platform
//     is a name (`linux`), and the Tauri 2 CLI accepts only the first as a flag —
//     `tauri build --windows` is a usage error, which is what the snapshot's
//     launcher produced for every request that named a platform. So `--target`
//     takes a triple and nothing else; `--platform` takes a name, resolves to
//     *this host's* triple, and refuses any platform that is not this one, naming
//     the runner to use instead.
//   2. **No `.ok()`.** A launch failure is propagated with the CLI's own exit
//     status. A mobile entry point that discarded it reported success on a
//     device that had not started.
//   3. **No default port.** The dev URL comes from `apps/frontend/native/dev_ports.ts`,
//     read by both the dev server and the launcher, so the shell cannot be
//     pointed at another project's dev server.

/** The native project's own directory, relative to the repository root. */
export const NATIVE_DIR = 'apps/frontend/native';

/** Where the Tauri CLI lives, relative to the repository root. */
export const TAURI_SUBDIR = 'src-tauri';

/** Desktop platforms a build can target. Deliberately not Rust triples. */
export const PLATFORMS = ['linux', 'macos', 'windows'] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * Rust target triples this command accepts.
 *
 * A closed list rather than a pattern, because the failure being prevented is a
 * build for a triple nobody has a linker for: that surfaces as a rustc error
 * about a target spec, which names the toolchain rather than the argument.
 */
export const TARGET_TRIPLES = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-pc-windows-msvc',
] as const;
export type TargetTriple = (typeof TARGET_TRIPLES)[number];

/** The platform this process is running on, in the vocabulary above. */
export const hostPlatform = (): Platform => {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return 'linux';
  }
};

/** The default Rust target triple for a desktop platform, by architecture. */
export const hostTriple = (): TargetTriple => {
  const platform = hostPlatform();
  const arm = process.arch === 'arm64';

  if (platform === 'macos') {
    return arm ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (platform === 'windows') {
    return 'x86_64-pc-windows-msvc';
  }
  return arm ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
};

export interface NativeInvocation {
  /** The binary to run. Resolved through `resolveWorkspaceBin`, never `bunx`. */
  readonly bin: string;
  readonly args: readonly string[];
  /** Working directory. The CLI is always run from `src-tauri`. */
  readonly cwd: string;
}

export interface PlanOptions {
  /** `dev` or `build`. */
  readonly mode: 'dev' | 'build';
  readonly platform?: Platform | undefined;
  readonly target?: TargetTriple | undefined;
  /** Passed as `--features`. */
  readonly features?: readonly string[] | undefined;
  /** `--no-bundle` builds the binary without an installer. */
  readonly bundle?: boolean | undefined;
}

export type PlanResult =
  | { readonly ok: true; readonly invocation: NativeInvocation }
  | { readonly ok: false; readonly message: string; readonly remedy: string };

const isTriple = (value: string): value is TargetTriple =>
  (TARGET_TRIPLES as readonly string[]).includes(value);

/**
 * Plan one invocation, or explain the refusal.
 *
 * Refusals are returned rather than thrown so the caller chooses the exit code:
 * a wrong flag is exit 2 (`EXIT.usage`), and a capability this host lacks is
 * exit 3 (`EXIT.unavailable`).
 */
export const planInvocation = (options: PlanOptions): PlanResult => {
  const { mode, platform, target, features } = options;

  if (platform !== undefined && !PLATFORMS.includes(platform)) {
    return {
      ok: false,
      message: `"${platform}" is not a desktop platform this command knows.`,
      remedy: `Use one of: ${PLATFORMS.join(', ')}. A Rust target triple goes in --target, not --platform.`,
    };
  }

  if (target !== undefined && !isTriple(target)) {
    return {
      ok: false,
      message: `--target "${target}" is not a Rust target triple.`,
      remedy: `Use one of: ${TARGET_TRIPLES.join(', ')}.`,
    };
  }

  if (platform !== undefined && platform !== hostPlatform()) {
    // Refusing, not forwarding. This is not a preference: the Tauri 2 CLI has no
    // `--linux`/`--macos`/`--windows` flag at all, so the snapshot's
    // `tauri build --windows` was a usage error, and the nearest thing that
    // "works" — naming another platform's triple — asks cargo for a toolchain the
    // machine may not have, and cannot link a desktop app there anyway.
    //
    // The remedy is a machine, not a flag: `.github/workflows/native.yml` runs one
    // runner per desktop operating system.
    return {
      ok: false,
      message: `--platform ${platform} cannot be built on this host (${hostPlatform()}).`,
      remedy:
        'A desktop binary is built on its own operating system. Run this on a ' +
        `${platform} machine, or let the desktop matrix in .github/workflows/native.yml ` +
        `build it: its ${platform} runner passes --platform ${platform}.`,
    };
  }

  if (platform !== undefined && target !== undefined) {
    // Two ways of naming one thing, and the pair can disagree. A `--platform
    // windows --target x86_64-apple-darwin` build is not a thing.
    const platformMatches =
      (platform === 'macos' && target.includes('apple-darwin')) ||
      (platform === 'windows' && target.includes('windows')) ||
      (platform === 'linux' && target.includes('linux'));
    if (!platformMatches) {
      return {
        ok: false,
        message: `--platform ${platform} and --target ${target} disagree.`,
        remedy:
          'Name the platform or the triple, not both unless they describe the same ' +
          'machine. Cross-compiling desktop targets is a CI matrix, not a flag.',
      };
    }
  }

  // The CLI's own vocabulary is a Rust target triple. A named platform therefore
  // becomes this host's triple, stated rather than implied, so the argv a maintainer
  // reads in CI names the machine it is building for.
  const args: string[] = [mode];
  const effectiveTarget = target ?? (platform === undefined ? undefined : hostTriple());
  if (effectiveTarget !== undefined) {
    args.push('--target', effectiveTarget);
  }
  if (features !== undefined && features.length > 0) {
    args.push('--features', features.join(','));
  }
  if (options.bundle === false) {
    args.push('--no-bundle');
  }

  return {
    ok: true,
    invocation: { bin: 'tauri', args, cwd: `${NATIVE_DIR}/${TAURI_SUBDIR}` },
  };
};

/**
 * Parse the flags this command accepts. Unknown flags are refused.
 *
 * Refusing rather than forwarding is the point: the snapshot's launcher passed
 * unrecognised arguments to the CLI, so `--tauri-deb` became a silent no-op and
 * `--target windwos` became a build for this machine. An unknown flag here names
 * the flags that exist.
 */
export const parseNativeArgs = (
  args: readonly string[],
): { ok: true; options: PlanOptions } | { ok: false; message: string; remedy: string } => {
  const options: {
    mode: 'dev' | 'build';
    platform?: Platform;
    target?: TargetTriple;
    features?: string[];
    bundle?: boolean;
  } = { mode: 'build' };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';

    if (arg === 'dev') {
      options.mode = 'dev';
    } else if (arg === 'build') {
      options.mode = 'build';
    } else if (arg === '--no-bundle') {
      options.bundle = false;
    } else if (arg === '--linux' || arg === '--macos' || arg === '--windows') {
      options.platform = arg.slice(2) as Platform;
    } else if (arg === '--platform') {
      const value = args[index + 1] ?? '';
      options.platform = value as Platform;
      index += 1;
    } else if (arg === '--target') {
      options.target = (args[index + 1] ?? '') as TargetTriple;
      index += 1;
    } else if (arg === '--features') {
      options.features = (args[index + 1] ?? '').split(',').filter((entry) => entry.length > 0);
      index += 1;
    } else if (arg.startsWith('-')) {
      return {
        ok: false,
        message: `Unknown flag "${arg}".`,
        remedy:
          'Accepted: dev, build, --linux, --macos, --windows, --platform <name>, ' +
          '--target <triple>, --features <a,b>, --no-bundle.',
      };
    } else {
      return {
        ok: false,
        message: `Unexpected argument "${arg}".`,
        remedy: 'The command takes a mode and flags, and nothing else.',
      };
    }
  }

  return { ok: true, options: options as PlanOptions };
};
