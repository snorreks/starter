// scripts/src/local/media_image.ts
//
// The finite runner's container image: one definition, two callers.
//
// `bun run test:compute` and `bun run dev --stack container` both need this image
// to exist and to be built from the current sources. They used to be able to
// disagree — the compute lane could verify an image while a dev run used a
// different tag that happened to be stale — so the tag, the Dockerfile, the build
// context and the Rust-test assertion now live here and both callers read them.
//
// **Why the Rust test count is parsed out of the build.** `Dockerfile.job` runs
// `cargo test --locked --offline` as a build stage. A build that succeeds proves
// the code compiled; it does not prove the tests ran, and a cache hit or an
// accidentally removed stage produces a green build with no evidence that the
// encode, cancellation and failure tests ever executed. The compute lane was the
// first thing in this repository to check the count, and this module makes that
// check available to every caller rather than leaving it to whoever remembers.
//
// **Two kinds of cold start, handled differently.** A build is slow because
// compiling the dependency tree in release mode is slow, and `Dockerfile.job` keeps
// that work in BuildKit cache mounts so it survives `--no-cache`. That fixes the
// cost without weakening anything: the crate's own code and its tests are still
// compiled and run on every build.
//
// On top of that, a caller that only needs the image to *exist* can ask whether it
// is already current — see {@link buildMediaImage}'s `reuse`. That is the second,
// larger saving, and it is deliberately opt-in and explicitly reported: a lane that
// skipped a build without saying so would be indistinguishable from one that ran
// it, which is the failure this repository treats as worse than an error.

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';
import { publicToolEnvironment } from '../shared/private_environment.ts';
import { runBounded } from '../shared/run_bounded.ts';

/**
 * The local tag.
 *
 * Shared deliberately. `test:compute` builds with `--no-cache` so it verifies the
 * sources, and a development build is layer-cached so it is fast; sharing the tag
 * means the second of the two is warm rather than paying for a second full Rust
 * build, and neither can end up looking at the other's stale image.
 */
export const MEDIA_IMAGE = 'starter-cloud-run-job:local';

/** Repository-relative, because the build context is the repository root. */
export const MEDIA_DOCKERFILE = 'apps/backend/media/Dockerfile.job';
export const MEDIA_BUILD_CONTEXT = 'apps/backend/media';

/** A Rust build inside the image is minutes, not seconds. */
export const MEDIA_BUILD_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Where the image records how many Cargo tests its build verified.
 *
 * Read out of the artifact rather than parsed from the build log, because a layer
 * cache serves the test step without re-running it: the tests did not produce
 * output, a log-scraping caller sees zero, and it concludes that nothing verified
 * the encode path. The number in the image is the number the build produced whether
 * or not this invocation re-ran the tests.
 */
export const MEDIA_RUST_TESTS_PATH = '/usr/local/share/starter-media/rust-tests';

/**
 * Files whose contents decide whether the image is current.
 *
 * The Dockerfile, the manifests, every Rust source, the tests, the fixtures and the
 * runner. A change to any of them can change the binary, so a change to any of them
 * invalidates the image. Nothing else can: the base images are digest-pinned in the
 * Dockerfile, so their identity is part of its content, and the build argument is
 * stamped into the image but is not what makes it a *different build* of the same
 * code — `BUILD_GIT_REVISION` is deliberately excluded from the checksum so a
 * rebuild after a commit that touched no Rust still counts as current.
 */
const IMAGE_INPUT_FILES = [
  'Dockerfile.job',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'rustfmt.toml',
  'runner/runner.mjs',
] as const;

const IMAGE_INPUT_DIRECTORIES = ['src', 'tests', 'fixtures'] as const;

/**
 * Passing Cargo tests the image build reported, summed over every test binary.
 *
 * Returns 0 when the output contains no passing test line at all — including when
 * the build output was truncated — which is the signal the callers refuse on. A
 * `?.` on the count would turn that into `NaN`, and `NaN` compares false against
 * everything, so a build that tested nothing would slip past a `=== 0` check.
 */
/**
 * Read the recorded count, and refuse anything that is not a positive integer.
 *
 * Returns `null` for a missing file, a blank file, or anything non-numeric: all
 * three mean "this image carries no evidence", which is the condition the caller
 * refuses on. Coercing a blank to `0` and letting `0` fall through to a build
 * failure would report the wrong problem for the right reason.
 */
export const readRecordedRustTestCount = async (
  execute: (args: string[]) => Promise<{ code: number; output: string }>,
): Promise<number | null> => {
  const read = await execute([
    'run',
    '--rm',
    '--entrypoint',
    'cat',
    MEDIA_IMAGE,
    MEDIA_RUST_TESTS_PATH,
  ]);
  if (read.code !== 0) {
    return null;
  }
  const recorded = Number.parseInt(read.output.trim(), 10);
  return Number.isSafeInteger(recorded) && recorded > 0 ? recorded : null;
};

export const parseRustTestCount = (output: string): number =>
  [...output.matchAll(/test result: ok\. (\d+) passed/g)].reduce(
    (total, match) => total + Number(match[1]),
    0,
  );

const hashFile = async (root: string, relative: string): Promise<string> => {
  const bytes = await readFile(join(root, relative));
  return createHash('sha256').update(bytes).digest('hex');
};

/**
 * Every file beneath `relative`, sorted by the caller.
 *
 * Checks `isDirectory()` because recursing into a regular file is `scandir` on a
 * non-directory: `ENOTDIR`, with the offending path pointing at a `.rs` file
 * rather than at the walker that guessed it was a directory.
 */
const walk = async (root: string, relative: string): Promise<string[]> => {
  let entries: readonly Dirent[];
  try {
    entries = await readdir(join(root, relative), { withFileTypes: true });
  } catch {
    // A declared input that is not there is a defect, not a condition to tolerate.
    // Skipping it would let the image read as current while a whole category of
    // inputs changed — or appeared — with nothing to show for it.
    throw new Error(
      `The media image inputs include ${relative}, which does not exist under ${root}. ` +
        'Either restore it or remove it from IMAGE_INPUT_DIRECTORIES; ' +
        'a silently-skipped input is an image that can be reused when it must not be.',
    );
  }
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? walk(root, join(relative, entry.name))
        : Promise.resolve([join(relative, entry.name)]),
    ),
  );
  return files.flat();
};

/**
 * A content hash of everything that can change the image.
 *
 * Deterministic across machines and checkouts because it hashes relative paths and
 * file contents, never absolute paths or timestamps. That matters: the stamp is
 * written into the checkout's own scratch directory, and a hash that moved when the
 * directory moved would make every clone rebuild.
 */
export const mediaImageInputsChecksum = async (root: string = REPO_ROOT): Promise<string> => {
  const files = [
    ...IMAGE_INPUT_FILES.map((name) => join(MEDIA_BUILD_CONTEXT, name)),
    ...(
      await Promise.all(
        IMAGE_INPUT_DIRECTORIES.map(async (directory) => {
          const found = await walk(root, join(MEDIA_BUILD_CONTEXT, directory));
          return found.sort();
        }),
      )
    ).flat(),
  ].sort();

  const hash = createHash('sha256');
  for (const file of files) {
    hash
      .update(file)
      .update('\0')
      .update(await hashFile(root, file))
      .update('\n');
  }
  return hash.digest('hex');
};

/**
 * Where the "this image is current for these sources" stamp lives.
 *
 * Under the checkout's own `.wrangler/`, never in `/tmp` and never in the image:
 * two checkouts build the same tag, and a stamp in a shared location would let one
 * checkout's claim satisfy the other's.
 */
export const mediaImageStampPath = (root: string = REPO_ROOT): string =>
  join(root, '.wrangler', 'images', `${MEDIA_IMAGE.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

interface ImageStamp {
  readonly checksum: string;
  /** Cargo tests the recorded build reported passing. `-1` when unknown. */
  readonly rustTests: number;
}

const readStamp = async (path: string): Promise<ImageStamp | null> => {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ImageStamp>;
    if (typeof parsed.checksum !== 'string' || typeof parsed.rustTests !== 'number') {
      return null;
    }
    return { checksum: parsed.checksum, rustTests: parsed.rustTests };
  } catch {
    // Absent or unreadable means "no claim", which is the same as a stale image.
    return null;
  }
};

const writeStamp = async (path: string, stamp: ImageStamp): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ image: MEDIA_IMAGE, ...stamp }, null, 2)}\n`, {
    mode: 0o600,
  });
};

export interface BuildMediaImageOptions {
  /** The container engine, already resolved and proven to answer `info`. */
  engine: string;
  /** Build regardless of layer cache. The compute lane sets this; a dev run does not. */
  noCache?: boolean;
  /**
   * Skip the build when this checkout already built the image from these exact
   * sources, and nothing in the image's inputs has changed since.
   *
   * Off by default, and deliberately so. `test:compute` is a *verification*: it
   * builds with `--no-cache` precisely so that "the image is correct" cannot mean
   * "the layer cache was warm". A caller that reuses must be one that needs the
   * image to exist, not one asserting that it is correct.
   *
   * A reuse is always reported as such. Returning the same shape as a real build
   * without saying so is how a lane ends up certifying an image it never built.
   */
  reuse?: boolean;
  /** Injected so a test can assert the argv rather than run a twenty-minute build. */
  execute?: (args: string[]) => Promise<{ code: number; output: string }>;
  /** Injected so a test can drive the checksum and the stamp. */
  inputsChecksum?: () => Promise<string>;
  stampPath?: string;
  imageExists?: (engine: string, image: string) => Promise<boolean>;
}

export interface MediaImageBuild {
  readonly image: string;
  /** Passing Cargo tests observed in the build output. `-1` for a reused image. */
  readonly rustTests: number;
  /** True when no build ran, because the existing image matches these sources. */
  readonly reused: boolean;
  /** The content hash the decision was made on. Reported so a skip is auditable. */
  readonly checksum: string;
}

const executeBounded = async (
  engine: string,
  args: string[],
): Promise<{ code: number; output: string }> => {
  const result = await runBounded({
    command: engine,
    args: [...args],
    cwd: REPO_ROOT,
    timeoutMs: MEDIA_BUILD_TIMEOUT_MS,
    maxBytes: 16 * 1024 * 1024,
    env: publicToolEnvironment(process.env),
  });
  return { code: result.code, output: `${result.stdout}\n${result.stderr}` };
};

const defaultImageExists = async (engine: string, image: string): Promise<boolean> => {
  const probe = await runBounded({
    command: engine,
    args: ['image', 'inspect', image],
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
    maxBytes: 256 * 1024,
    env: publicToolEnvironment(process.env),
  });
  return probe.code === 0;
};

/**
 * Build the image, and refuse a build that proved nothing.
 *
 * Two refusals, both naming the evidence: a non-zero exit, and a successful build
 * whose output contained no passing Cargo test. The second is the one that matters
 * — it is the difference between "the image is correct" and "the image compiled".
 */
export const buildMediaImage = async (
  options: BuildMediaImageOptions,
): Promise<MediaImageBuild> => {
  const execute = options.execute ?? ((args: string[]) => executeBounded(options.engine, args));
  const checksumOf = options.inputsChecksum ?? (() => mediaImageInputsChecksum());
  const stampPath = options.stampPath ?? mediaImageStampPath();
  const imageExists = options.imageExists ?? defaultImageExists;

  const checksum = await checksumOf();

  if (options.reuse === true) {
    const stamp = await readStamp(stampPath);
    // Both halves must hold: this checkout recorded a build for these sources, *and*
    // the engine still has the image. A stamp surviving `docker image rm` is a
    // claim about an image that no longer exists, and honouring it would leave the
    // caller dispatching to something that is not there.
    if (stamp?.checksum === checksum && (await imageExists(options.engine, MEDIA_IMAGE))) {
      // The recorded count travels with the reuse rather than becoming `-1`. A
      // verification lane reporting "0 tests" or "unknown" would be a downgrade in
      // evidence, and the number it is reporting is the number this image's tests
      // actually produced.
      return { image: MEDIA_IMAGE, rustTests: stamp.rustTests, reused: true, checksum };
    }
  }

  const args = [
    'build',
    ...(options.noCache === true ? ['--no-cache'] : []),
    '--file',
    MEDIA_DOCKERFILE,
    '--tag',
    MEDIA_IMAGE,
    '--build-arg',
    `BUILD_GIT_REVISION=${process.env.GITHUB_SHA ?? 'local'}`,
    MEDIA_BUILD_CONTEXT,
  ];

  const built = await execute(args);
  if (built.code !== 0) {
    throw new Error(
      `The finite runner image failed to build (exit ${built.code}).\n${built.output.slice(-4000)}`,
    );
  }

  // The image is the record. The build log is only a fallback for an engine that
  // cannot run the image, and a refusal names both facts when neither produced a
  // number.
  const recorded = await readRecordedRustTestCount(execute);
  const rustTests = recorded ?? parseRustTestCount(built.output);
  if (rustTests <= 0) {
    throw new Error(
      'The image carries no record of passing Cargo tests, so nothing verified the encode, ' +
        'cancellation or failure paths inside it.\n' +
        `  Read ${MEDIA_RUST_TESTS_PATH} from ${MEDIA_IMAGE}: no positive count.\n` +
        '  The build succeeded, which proves compilation and nothing else.\n' +
        built.output.slice(-4000),
    );
  }

  // Recorded only after a build that passed, so a failed or abandoned build never
  // leaves a stamp that would satisfy a later reuse.
  await writeStamp(stampPath, { checksum, rustTests });

  return { image: MEDIA_IMAGE, rustTests, reused: false, checksum };
};
