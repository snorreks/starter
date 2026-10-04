// apps/frontend/native/scripts/check_artifacts.test.ts
//
// Artifact naming and origin verification, against real ZIP containers.
//
// The fixture archives are built by this file, with `writeStoredZip`, and opened
// by the same reader the CI lane uses. That is deliberate: a test with a mocked
// reader proves the reader agrees with the mock, and a container format is
// exactly the thing where "the bytes" and "what the code imagines the bytes are"
// come apart. The writer uses *stored* entries so the fixture does not depend on
// a zlib build producing identical compressed output everywhere.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import {
  artifactName,
  isForeignOrigin,
  parseArgs,
  parseArtifactName,
  readZip,
  verifyArtifacts,
  writeStoredZip,
} from './check_artifacts.ts';

const ORIGIN = 'https://api.example.test';
const REVISION = '05adbfa1c3f4e6d70a9b8c2d1e0f3a4b5c6d7e8f';

/** A minimal APK-shaped archive: the frontend assets plus the parts that are not. */
const apkWith = (
  assets: readonly { name: string; data: string }[],
  extra: readonly { name: string; data: string }[] = [
    { name: 'AndroidManifest.xml', data: 'binary-ish manifest' },
    { name: 'lib/arm64-v8a/libstarter.so', data: '\u007fELF not text' },
  ],
): Buffer =>
  writeStoredZip([
    { name: 'assets/index.html', data: `<script src="/_app/immutable/entry.js"></script>` },
    { name: 'assets/_app/immutable/entry.js', data: `const api="${ORIGIN}"; export default api;` },
    ...assets,
    ...extra,
  ]);

const scratch = mkdtempSync(join(tmpdir(), 'starter-artifacts-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const place = (name: string, bytes: Buffer): string => {
  const dir = join(scratch, Math.abs(hash(name)).toString(16));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
  return dir;
};

const hash = (value: string): number => {
  let result = 0;
  for (const character of value) {
    result = (result * 31 + character.charCodeAt(0)) | 0;
  }
  return result;
};

describe('the ZIP reader', () => {
  test('it reads back what the writer wrote', () => {
    const bytes = writeStoredZip([
      { name: 'a.txt', data: 'first' },
      { name: 'nested/b.txt', data: 'second' },
    ]);
    const entries = readZip(bytes);

    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'nested/b.txt']);
    expect(entries[0]?.data.toString('utf8')).toBe('first');
    expect(entries[1]?.data.toString('utf8')).toBe('second');
  });

  test('a corrupt entry is refused rather than read as text', () => {
    // Flip one byte of the payload. A reader that skipped the CRC would scan
    // whatever came out and report an origin it never actually read.
    const bytes = writeStoredZip([{ name: 'a.txt', data: 'https://api.example.test' }]);
    const index = bytes.indexOf('https://api');
    expect(index).toBeGreaterThan(0);
    bytes[index] = 'X'.charCodeAt(0);

    expect(() => readZip(bytes)).toThrow(/CRC|corrupt/i);
  });

  test('a file that is not a ZIP is named as such', () => {
    expect(() => readZip(Buffer.from('not a zip at all'))).toThrow(/end-of-central-directory/);
  });
});

describe('artifact names carry their provenance', () => {
  test('an unsigned Android APK names platform, target, revision and its own state', () => {
    expect(
      artifactName({ platform: 'android', target: 'aarch64', revision: REVISION, extension: 'apk', signed: false }),
    ).toBe(`starter-android-aarch64-${REVISION.slice(0, 12)}-unsigned.apk`);
  });

  test('a signed artifact says so, in the name', () => {
    const signed = artifactName({
      platform: 'ios',
      target: 'aarch64',
      revision: REVISION,
      extension: 'ipa',
      signed: true,
    });
    expect(signed).toBe(`starter-ios-aarch64-${REVISION.slice(0, 12)}-signed.ipa`);
    expect(parseArtifactName(signed)?.signed).toBe(true);
  });

  test('a name with no signing marker is refused, not read as signed', () => {
    // The failure this prevents: an optional marker group parses an absent marker
    // as "not -unsigned", so a file nobody thought about signing is read as a
    // signed release artifact by the check that exists to tell them apart.
    expect(parseArtifactName(`starter-android-aarch64-${REVISION.slice(0, 12)}.apk`)).toBeNull();
    expect(parseArtifactName(`starter-ios-aarch64-${REVISION.slice(0, 12)}.ipa`)).toBeNull();
  });

  test('a name that does not say what it is is refused', () => {
    for (const name of [
      'app-release.apk',
      'starter.apk',
      `starter-android-${REVISION.slice(0, 12)}.apk`,
      `starter-android-aarch64-${REVISION.slice(0, 12)}-unsigned.zip`,
      `starter-android-aarch64-${REVISION.slice(0, 12)}-maybe-signed.apk`,
    ]) {
      expect(parseArtifactName(name)).toBeNull();
    }
  });
});

describe('origin verification reads the bytes', () => {
  test('an APK containing the expected origin passes', () => {
    const name = artifactName({
      platform: 'android',
      target: 'aarch64',
      revision: REVISION,
      extension: 'apk',
      signed: false,
    });
    const dir = place(name, apkWith([]));

    expect(verifyArtifacts({ dir, expectedOrigin: ORIGIN, revision: REVISION, platform: 'android' })).toEqual([]);
  });

  test('an APK built against another API fails, naming both', () => {
    const name = artifactName({
      platform: 'android',
      target: 'aarch64',
      revision: REVISION,
      extension: 'apk',
      signed: false,
    });
    const dir = place(
      name,
      apkWith([{ name: 'assets/other.js', data: 'const api="https://staging.example.test";' }]),
    );

    const problems = verifyArtifacts({
      dir,
      expectedOrigin: ORIGIN,
      revision: REVISION,
      platform: 'android',
    });

    // The expected origin is still in `entry.js`, so the failure is the *extra*
    // one: one artifact with two origins is one build that read two values.
    expect(problems.map((problem) => problem.code)).toEqual(['foreign_origin']);
    expect(problems[0]?.message).toContain('staging.example.test');
  });

  test('an APK with no origin at all fails rather than passing vacuously', () => {
    const name = artifactName({
      platform: 'android',
      target: 'armv7',
      revision: REVISION,
      extension: 'apk',
      signed: false,
    });
    const dir = place(
      name,
      writeStoredZip([{ name: 'assets/index.html', data: '<html></html>' }]),
    );

    const problems = verifyArtifacts({
      dir,
      expectedOrigin: ORIGIN,
      revision: REVISION,
      platform: 'android',
    });

    expect(problems.map((problem) => problem.code)).toEqual(['origin_missing']);
    expect(problems[0]?.remedy).toContain('VITE_NATIVE_API_ORIGIN');
  });

  test('the shell\'s own ipc and asset origins are not mistaken for API origins', () => {
    const name = artifactName({
      platform: 'android',
      target: 'aarch64',
      revision: REVISION,
      extension: 'aab',
      signed: true,
    });
    const dir = place(
      name,
      apkWith([
        {
          name: 'assets/csp.js',
          data: 'connect-src http://ipc.localhost http://asset.localhost ipc:',
        },
      ]),
    );

    expect(
      verifyArtifacts({ dir, expectedOrigin: ORIGIN, revision: REVISION, platform: 'android' }),
    ).toEqual([]);
  });

  test('a namespace URI and a documentation host are not a leaked deployment', () => {
    // Every real bundle carries `http://www.w3.org/…` from an SVG namespace or a
    // `viewBox`. A checker that fires on it fails on correct code, and the fix
    // everybody reaches for is deleting the checker.
    const name = artifactName({
      platform: 'android',
      target: 'aarch64',
      revision: REVISION,
      extension: 'apk',
      signed: false,
    });
    const dir = place(
      name,
      apkWith([
        {
          name: 'assets/namespace.js',
          data:
            'const ns = "http://www.w3.org/2000/svg"; ' +
            'const docs = "https://example.com/api"; ' +
            'const sub = "http://cdn.example.com/assets"; ' +
            'const schema = "https://schema.tauri.app/config/2"; ' +
            'const devUrl = "http://127.0.0.1:1420";',
        },
      ]),
    );

    expect(
      verifyArtifacts({ dir, expectedOrigin: ORIGIN, revision: REVISION, platform: 'android' }),
    ).toEqual([]);
  });

  test('a real second origin is still a foreign origin', () => {
    // `.test` is not RFC 2606, so this host is *not* excluded — and the allowance
    // for documentation hosts must not become a hole somebody walks a real
    // deployment through.
    const name = artifactName({
      platform: 'android',
      target: 'aarch64',
      revision: REVISION,
      extension: 'apk',
      signed: false,
    });
    const dir = place(
      name,
      apkWith([{ name: 'assets/other.js', data: 'const api="https://staging.example.test";' }]),
    );

    const problems = verifyArtifacts({
      dir,
      expectedOrigin: ORIGIN,
      revision: REVISION,
      platform: 'android',
    });

    expect(problems.map((problem) => problem.code)).toEqual(['foreign_origin']);
    expect(problems[0]?.message).toContain('staging.example.test');
  });

  test('an artifact from another revision fails: a restored cache is not this build', () => {
    const name = artifactName({
      platform: 'android',
      target: 'aarch64',
      revision: '0000000000000000000000000000000000000000',
      extension: 'apk',
      signed: false,
    });
    const dir = place(name, apkWith([]));

    const problems = verifyArtifacts({
      dir,
      expectedOrigin: ORIGIN,
      revision: REVISION,
      platform: 'android',
    });

    expect(problems.map((problem) => problem.code)).toEqual(['wrong_revision']);
  });

  test('a directory with no package in it is a build failure, not a naming one', () => {
    const dir = place('notes.txt', Buffer.from('the build wrote no artifact'));
    const problems = verifyArtifacts({
      dir,
      expectedOrigin: ORIGIN,
      revision: REVISION,
      platform: 'android',
    });

    expect(problems.map((problem) => problem.code)).toEqual(['no_artifacts']);
    expect(problems[0]?.remedy).toContain('did not produce');
  });

  test('a package with no frontend in it is a build failure too', () => {
    const name = artifactName({
      platform: 'android',
      target: 'aarch64',
      revision: REVISION,
      extension: 'apk',
      signed: false,
    });
    const dir = place(
      name,
      writeStoredZip([{ name: 'lib/arm64-v8a/libstarter.so', data: '\u007fELF' }]),
    );

    const problems = verifyArtifacts({
      dir,
      expectedOrigin: ORIGIN,
      revision: REVISION,
      platform: 'android',
    });

    expect(problems.map((problem) => problem.code)).toEqual(['no_frontend']);
  });

  test('an iOS artifact in the Android lane fails', () => {
    const name = artifactName({
      platform: 'ios',
      target: 'aarch64-sim',
      revision: REVISION,
      extension: 'ipa',
      signed: false,
    });
    const dir = place(name, apkWith([]));

    const problems = verifyArtifacts({
      dir,
      expectedOrigin: ORIGIN,
      revision: REVISION,
      platform: 'android',
    });

    expect(problems.map((problem) => problem.code)).toEqual(['wrong_platform']);
  });
});

describe('the fixture archives are real files', () => {
  test('a written archive round-trips through the filesystem, not just memory', () => {
    // The reader takes a `Buffer`, and CI hands it one read from disk. Asserting
    // only the in-memory form would leave the file path untested.
    const name = artifactName({
      platform: 'android',
      target: 'i686',
      revision: REVISION,
      extension: 'apk',
      signed: false,
    });
    const dir = place(name, apkWith([]));
    const entries = readZip(readFileSync(join(dir, name)));

    expect(entries.some((entry) => entry.name === 'assets/index.html')).toBe(true);
  });
});

describe('argument parsing', () => {
  test('a flag value is not mistaken for a directory', () => {
    // The failure this prevents: `filter((arg) => !arg.startsWith('--'))` treats
    // `--origin https://api.example.test` as one directory, so the check runs
    // against a URL, finds nothing, and reports success.
    const parsed = parseArgs([
      '--',
      'build/apk',
      '--origin',
      'https://api.example.test',
      '--revision',
      REVISION,
      '--platform',
      'android',
    ]);

    expect(parsed.failure).toBeNull();
    expect(parsed.dirs).toEqual(['build/apk']);
    expect(parsed.flags.get('--origin')).toBe('https://api.example.test');
    expect(parsed.flags.get('--platform')).toBe('android');
  });

  test('several directories are all directories', () => {
    const parsed = parseArgs([
      'apk/debug',
      'bundle/release',
      '--origin',
      'https://api.example.test',
      '--revision',
      REVISION,
      '--platform',
      'android',
    ]);

    expect(parsed.dirs).toEqual(['apk/debug', 'bundle/release']);
  });

  test('a flag with no value is refused rather than reading the next flag', () => {
    for (const args of [
      ['apk', '--origin', '--revision', REVISION, '--platform', 'android'],
      ['apk', '--origin', '', '--revision', REVISION, '--platform', 'android'],
      ['apk', '--origin', '--revision', REVISION, '--platform', 'android'],
    ]) {
      expect(parseArgs(args).failure).toBe('--origin needs a value.');
    }
  });

  test('an unknown flag is refused and named', () => {
    expect(parseArgs(['apk', '--orign', 'https://x.test']).failure).toContain('--orign');
  });

  test('--name takes its arguments positionally and not as directories to scan', () => {
    const parsed = parseArgs(['--name', 'android', 'aarch64', 'apk', 'unsigned']);

    expect(parsed.failure).toBeNull();
    expect(parsed.dirs).toEqual(['android', 'aarch64', 'apk', 'unsigned']);
    expect(parsed.flags.size).toBe(0);
  });
});

describe('what counts as a foreign origin', () => {
  const expected = 'https://api.example.test';

  test('another deployment is reported, whatever it is called', () => {
    // The whole point of the check. `.test` is not RFC 2606, and a real host is
    // not a documentation host.
    for (const host of [
      'https://staging.example.test',
      'https://api.prod.invalid',
      'https://someone-elses-api.example.org',
    ]) {
      expect(isForeignOrigin(host, expected)).toBe(true);
    }
  });

  test('the expected origin is never foreign to itself', () => {
    expect(isForeignOrigin(expected, expected)).toBe(false);
  });

  test('loopback is only ignored because a packaged app cannot reach it', () => {
    // And it is ignored *only* when it is not the expected origin — a development
    // build legitimately targets loopback, and that must still be found.
    for (const loopback of ['http://127.0.0.1:1420', 'http://localhost:5173', 'http://[::1]:5173']) {
      expect(isForeignOrigin(loopback, expected)).toBe(false);
      expect(isForeignOrigin(loopback, loopback)).toBe(false);
    }
  });

  test('a loopback-looking name is not loopback', () => {
    // `127.0.0.1.evil.invalid` is an ordinary DNS name somebody controls. Note
    // the `.example.com` forms are deliberately *not* here: they really are
    // RFC 2606 documentation hosts, and the rule below already and correctly
    // treats them as such.
    expect(isForeignOrigin('http://127.0.0.1.evil.invalid', expected)).toBe(true);
    expect(isForeignOrigin('http://localhost.evil.invalid', expected)).toBe(true);
    // And the documentation rule covers those, lookalike or not.
    expect(isForeignOrigin('http://127.0.0.1.example.com', expected)).toBe(false);
  });

  test('the identifier hosts are named, not pattern-matched', () => {
    for (const identifier of [
      'http://www.w3.org/2000/svg',
      'https://schema.tauri.app/config/2',
      'https://example.com/anything',
    ]) {
      expect(isForeignOrigin(identifier, expected)).toBe(false);
    }
    // …and a lookalike is still caught.
    expect(isForeignOrigin('https://schema.tauri.app.evil.invalid/config', expected)).toBe(true);
    expect(isForeignOrigin('https://www.w3.org.evil.invalid/', expected)).toBe(true);
  });

  test('a development origin on a LAN is still reported', () => {
    // The dev-only LAN allowance is exactly the case this must not blind itself to.
    expect(isForeignOrigin('http://192.168.1.20:8787', expected)).toBe(true);
  });
});
