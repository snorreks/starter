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

  test('a signed artifact says so by omission, and an unsigned one never omits it', () => {
    const signed = artifactName({
      platform: 'ios',
      target: 'aarch64',
      revision: REVISION,
      extension: 'ipa',
      signed: true,
    });
    expect(signed).toBe(`starter-ios-aarch64-${REVISION.slice(0, 12)}.ipa`);
    expect(parseArtifactName(signed)?.signed).toBe(true);
  });

  test('a name that does not say what it is is refused', () => {
    for (const name of [
      'app-release.apk',
      'starter.apk',
      `starter-android-${REVISION.slice(0, 12)}.apk`,
      `starter-android-aarch64-${REVISION.slice(0, 12)}-unsigned.zip`,
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
