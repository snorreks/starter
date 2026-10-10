// scripts/tests/media_image.test.ts
//
// The Rust test count parsed out of a container build.
//
// A successful `docker build` proves the code compiled. It does not prove the
// Cargo tests ran — a cache hit, or an accidentally removed build stage, produces
// an identical green result. The compute lane was the first thing in this
// repository to check the number, and a caller that forgets to is how a compute
// lane starts certifying images nothing tested.

import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMediaImage,
  MEDIA_IMAGE,
  mediaImageInputsChecksum,
  mediaImageStampPath,
  parseRustTestCount,
} from '../src/local/media_image.ts';

/**
 * A throwaway scratch directory for the stamp.
 *
 * Injected rather than pointing at the repository: the stamp lives under
 * `.wrangler/`, so a test writing the real one would overwrite the state the
 * developer's own next build depends on — asserting against the repository, which
 * is the mistake this repository keeps naming.
 */
const scratch = async (): Promise<{ path: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), 'media-image-'));
  return {
    path: join(dir, 'stamp.json'),
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  };
};

/** A build call with the checksum pinned, so no test walks the real crate. */
const build = async (
  options: Parameters<typeof buildMediaImage>[0] & { checksum?: string },
): Promise<ReturnType<typeof buildMediaImage>> => {
  const { checksum = 'checksum-fixture', ...rest } = options;
  const stamp = await scratch();
  try {
    return await buildMediaImage({
      inputsChecksum: async () => checksum,
      stampPath: stamp.path,
      imageExists: async () => true,
      ...rest,
    });
  } finally {
    await stamp.cleanup();
  }
};

describe('the Rust test count is read out of the build, not assumed', () => {
  test('several test binaries are summed', () => {
    // `cargo test` prints one `test result:` line per binary, and an image with a
    // lib and two integration binaries prints three. Reading only the first would
    // under-report by a factor of three.
    const output = [
      'running 42 tests',
      'test result: ok. 42 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
      'running 7 tests',
      'test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
    ].join('\n');
    expect(parseRustTestCount(output)).toBe(49);
  });

  test('a build that ran nothing reads as zero, not as a parse failure', () => {
    // `Number(undefined)` is `NaN`, and `NaN === 0` is false — so a build that
    // tested nothing would sail past a `=== 0` refusal.
    expect(parseRustTestCount('')).toBe(0);
    expect(parseRustTestCount('Successfully built abc123')).toBe(0);
    expect(parseRustTestCount('error[E0432]: unresolved import')).toBe(0);
  });

  test('a failing test line is not counted as a pass', () => {
    expect(parseRustTestCount('test result: FAILED. 41 passed; 1 failed; 0 ignored')).toBe(0);
  });
});

describe('a build that proves nothing is refused', () => {
  const executeReturning =
    (output: string, code = 0) =>
    async () => ({ code, output });

  test('a green build with no test evidence fails the run and says why', async () => {
    // The distinction this exists to keep: "the image is correct" versus "the
    // image compiled". Without it, a removed build stage looks like a pass.
    await expect(
      build({ engine: 'docker', execute: executeReturning('Successfully built abc123') }),
    ).rejects.toThrow(/carries no record of passing Cargo tests/);
  });

  test('a non-zero build reports the engine output', async () => {
    await expect(
      build({
        engine: 'podman',
        execute: executeReturning('error: failed to solve: no such stage', 1),
      }),
    ).rejects.toThrow(/failed to build \(exit 1\)/);
  });

  test('a build that reports tests is accepted, and says how many', async () => {
    const built = await build({
      engine: 'docker',
      execute: executeReturning(
        'test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
      ),
    });
    expect(built.rustTests).toBe(11);
    expect(built.image).toBe(MEDIA_IMAGE);
    // A reuse is never silent: `reused` is false because a build actually ran, and
    // the tests it saw are reported.
    expect(built.reused).toBe(false);
  });

  test('the tag is the one the compute lane verifies', async () => {
    // Two tags would let a development run and `bun run test:compute` prove
    // different images and neither would notice.
    let seen = '';
    await build({
      engine: 'docker',
      execute: async (args) => {
        if (args.includes('build')) {
          seen = args.join(' ');
          return { code: 0, output: 'test result: ok. 1 passed; 0 failed' };
        }
        return { code: 0, output: '1\n' };
      },
    });
    expect(seen).toContain(MEDIA_IMAGE);
    expect(seen).toContain('--file apps/backend/media/Dockerfile.job');
  });

  test('a development build is incremental and a verification build is not', async () => {
    // Captured from the build only: the image read is a second invocation, and
    // asserting on whichever came last would test the wrong thing.
    const argvFor = async (noCache: boolean) => {
      let seen = '';
      await build({
        engine: 'docker',
        noCache,
        execute: async (args) => {
          if (args.includes('build')) {
            seen = args.join(' ');
            return { code: 0, output: 'test result: ok. 1 passed; 0 failed' };
          }
          return { code: 0, output: '1\n' };
        },
      });
      return seen;
    };

    // `--no-cache` is what makes `test:compute` a verification rather than a
    // warm layer lookup. It must not be the default, or every dev run pays for a
    // full Rust build.
    expect(await argvFor(true)).toContain('--no-cache');
    expect(await argvFor(false)).not.toContain('--no-cache');
  });
});

describe('a build that is already current is reused, and says so', () => {
  /**
   * Counts *builds* only.
   *
   * A build calls the engine twice: once to build, once to read the recorded test
   * count out of the resulting image. Counting both would make every reuse
   * assertion look like a second build.
   */
  const executeCounting = () => {
    let builds = 0;
    const execute = async (args: string[]): Promise<{ code: number; output: string }> => {
      if (args.includes('build')) {
        builds += 1;
        return { code: 0, output: 'test result: ok. 3 passed; 0 failed' };
      }
      return { code: 0, output: '3\n' };
    };
    return { builds: (): number => builds, execute };
  };

  test('an unchanged source tree skips the build, and reports the reuse', async () => {
    const stamp = await scratch();
    const counter = executeCounting();
    try {
      await build({
        engine: 'docker',
        reuse: true,
        checksum: 'same',
        stampPath: stamp.path,
        execute: counter.execute,
      });
      expect(counter.builds()).toBe(1);

      const second = await buildMediaImage({
        engine: 'docker',
        reuse: true,
        inputsChecksum: async () => 'same',
        stampPath: stamp.path,
        imageExists: async () => true,
        execute: counter.execute,
      });

      // No second build, and the reuse is reported rather than being
      // indistinguishable from a build that ran. A caller that cannot tell the two
      // apart can certify an image it never built.
      expect(counter.builds()).toBe(1);
      expect(second.reused).toBe(true);
      // The count travels with the reuse rather than becoming a sentinel. A
      // verification lane reporting "0 tests" after a skip would be reporting less
      // evidence than the build it skipped, which is the wrong direction.
      expect(second.rustTests).toBe(3);
      expect(second.checksum).toBe('same');
    } finally {
      await stamp.cleanup();
    }
  });

  test('a changed source tree rebuilds', async () => {
    const stamp = await scratch();
    const counter = executeCounting();
    try {
      await build({
        engine: 'docker',
        reuse: true,
        checksum: 'first',
        stampPath: stamp.path,
        execute: counter.execute,
      });
      const second = await buildMediaImage({
        engine: 'docker',
        reuse: true,
        inputsChecksum: async () => 'second',
        stampPath: stamp.path,
        imageExists: async () => true,
        execute: counter.execute,
      });
      expect(counter.builds()).toBe(2);
      expect(second.reused).toBe(false);
    } finally {
      await stamp.cleanup();
    }
  });

  test('a stamp without the image rebuilds, because the image is gone', async () => {
    const stamp = await scratch();
    const counter = executeCounting();
    try {
      await build({
        engine: 'docker',
        reuse: true,
        checksum: 'same',
        stampPath: stamp.path,
        execute: counter.execute,
      });
      // `docker image rm` leaves the stamp behind. Honouring it would leave the
      // caller dispatching to an image that no longer exists.
      const second = await buildMediaImage({
        engine: 'docker',
        reuse: true,
        inputsChecksum: async () => 'same',
        stampPath: stamp.path,
        imageExists: async () => false,
        execute: counter.execute,
      });
      expect(counter.builds()).toBe(2);
      expect(second.reused).toBe(false);
    } finally {
      await stamp.cleanup();
    }
  });

  test('reuse is off by default, so a verification lane always builds', async () => {
    // `test:compute` builds with `--no-cache` precisely so that "correct" cannot
    // mean "the cache was warm". A default-on reuse would silently remove that.
    const stamp = await scratch();
    const counter = executeCounting();
    try {
      await build({
        engine: 'docker',
        checksum: 'same',
        stampPath: stamp.path,
        execute: counter.execute,
      });
      await build({
        engine: 'docker',
        checksum: 'same',
        stampPath: stamp.path,
        execute: counter.execute,
      });
      expect(counter.builds()).toBe(2);
    } finally {
      await stamp.cleanup();
    }
  });

  test('a failed build leaves no stamp for a later run to reuse', async () => {
    const stamp = await scratch();
    try {
      await expect(
        build({
          engine: 'docker',
          reuse: true,
          checksum: 'failed-build',
          stampPath: stamp.path,
          execute: async () => ({ code: 1, output: 'failed' }),
        }),
      ).rejects.toThrow('failed to build');
      // A stamp written on failure would satisfy the next reuse for an image that
      // was never produced.
      expect(await Bun.file(stamp.path).exists()).toBe(false);
      const reuse = await buildMediaImage({
        engine: 'docker',
        reuse: true,
        inputsChecksum: async () => 'failed-build',
        stampPath: stamp.path,
        imageExists: async () => true,
        execute: async () => ({ code: 0, output: 'test result: ok. 1 passed' }),
      });
      expect(reuse.reused).toBe(false);
    } finally {
      await stamp.cleanup();
    }
  });
});

describe('the image checksum follows the inputs and nothing else', () => {
  /**
   * A minimal crate with the same layout the real one has.
   *
   * Two of these at different paths prove the hash is relative: if it included an
   * absolute path, every clone would compute a different value and the reuse would
   * never fire — a silent loss of the optimisation rather than a visible failure.
   */
  const crate = async (
    root: string,
    mutate?: (file: string, body: string) => string,
  ): Promise<string> => {
    const media = join(root, 'apps/backend/media');
    await mkdir(join(media, 'src'), { recursive: true });
    await mkdir(join(media, 'tests'), { recursive: true });
    await mkdir(join(media, 'runner'), { recursive: true });
    await mkdir(join(media, 'fixtures'), { recursive: true });
    await writeFile(join(media, 'Cargo.toml'), '[package]\nname = "x"\n');
    await writeFile(join(media, 'Cargo.lock'), 'version = 4\n');
    await writeFile(join(media, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.98.1"\n');
    await writeFile(join(media, 'rustfmt.toml'), 'max_width = 100\n');
    await writeFile(join(media, 'Dockerfile.job'), 'FROM scratch\n');
    await writeFile(join(media, 'runner/runner.mjs'), 'export {};\n');
    await writeFile(
      join(media, 'src/lib.rs'),
      mutate?.('src/lib.rs', 'pub fn encode() {}\n') ?? 'pub fn encode() {}\n',
    );
    await writeFile(join(media, 'tests/encode.rs'), '#[test]\nfn t() {}\n');
    await writeFile(join(media, 'runner/runner.mjs'), 'export {};\n');
    return root;
  };

  test('two checkouts with identical sources hash the same', async () => {
    const one = await mkdtemp(join(tmpdir(), 'checksum-one-'));
    const two = await mkdtemp(join(tmpdir(), 'checksum-two-'));
    try {
      await crate(one);
      await crate(two);
      expect(await mediaImageInputsChecksum(one)).toBe(await mediaImageInputsChecksum(two));
    } finally {
      await rm(one, { recursive: true, force: true });
      await rm(two, { recursive: true, force: true });
    }
  });

  test('a changed source file changes the hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checksum-change-'));
    try {
      await crate(root);
      const before = await mediaImageInputsChecksum(root);
      await writeFile(join(root, 'apps/backend/media/src/lib.rs'), 'pub fn encode() { todo!() }\n');
      expect(await mediaImageInputsChecksum(root)).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a changed Dockerfile changes the hash', async () => {
    // The base images are digest-pinned inside the Dockerfile, so its content is
    // how a changed base image reaches the checksum. A hash that ignored it would
    // keep an image built against the old base.
    const root = await mkdtemp(join(tmpdir(), 'checksum-dockerfile-'));
    try {
      await crate(root);
      const before = await mediaImageInputsChecksum(root);
      await writeFile(join(root, 'apps/backend/media/Dockerfile.job'), 'FROM debian@sha256:dead\n');
      expect(await mediaImageInputsChecksum(root)).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the real crate hashes to a stable value', async () => {
    expect(await mediaImageInputsChecksum()).toMatch(/^[a-f0-9]{64}$/);
    expect(await mediaImageInputsChecksum()).toBe(await mediaImageInputsChecksum());
  });

  test('a declared input that is missing is refused rather than skipped', async () => {
    // Silently skipping would let the image read as current while a whole category
    // of inputs changed — or appeared — with nothing to show for it.
    const root = await mkdtemp(join(tmpdir(), 'checksum-missing-'));
    try {
      await crate(root);
      await rm(join(root, 'apps/backend/media/fixtures'), { recursive: true, force: true });
      await expect(mediaImageInputsChecksum(root)).rejects.toThrow(/does not exist/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the stamp path is inside this checkout, not a shared temporary directory', () => {
    // Two checkouts build the same tag; a stamp in a shared location would let one
    // checkout's claim satisfy the other's.
    expect(mediaImageStampPath('/checkouts/one')).toContain('/checkouts/one/.wrangler/');
    expect(mediaImageStampPath('/checkouts/two')).not.toBe(mediaImageStampPath('/checkouts/one'));
  });
});
