// scripts/tests/secrets.test.ts
//
// The SOPS operations, against real `sops` and real `age`.
//
// This suite drives the actual binaries rather than a fixture, because every bug
// found while writing it was a bug in *how sops is invoked* — and no fixture could
// have shown any of them:
//
//   - `age: >-` cannot hold two recipients. YAML folds the lines into one string, so
//     a second recipient became a 124-character token and every encrypt failed with
//     `failed to parse input as age key`. Only a YAML list works.
//   - `update-recipients` dropped the keys already in the config, because the
//     replacement captured the whole recipient block and re-emitted it with only the
//     new ones. One call made every encrypted file unreadable to its owner.
//   - `sops --decrypt` needs an explicit path even with piped stdin
//     (`Error: no file specified`), and `--input-type json --output-type binary` on a
//     json store fails with `no binary data found in tree`.
//   - The generated `path_regex` covered `\.env$`, which does not match `.dev.vars`.
//     sops matches the path *as given on the command line*.
//   - `SOPS_CONFIG` was absolute to this repository, so every `root`-taking operation
//     read the starter's own config instead of the one it was pointed at.
//
// The identity is generated per run into a temp directory and never written
// anywhere else — an ephemeral `age-keygen`, not a fixture key. So the suite proves a
// real round trip rather than that a recorded blob still decrypts.
//
// Skipped, loudly, when sops or age is absent. A skip says so; it does not pass
// silently, because the alternative is a green suite proving nothing on a host that
// cannot encrypt anything.

import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXIT,
  encryptFile,
  initConfig,
  isGitIgnored,
  probeTools,
  readRecipients,
  updateRecipients,
} from '../src/secrets/sops.ts';

/**
 * The module's path, for the checks that run it in a subprocess.
 *
 * `decryptFile` and `execWithSecrets` are exercised that way rather than imported:
 * both need a decrypted value to exist first, so they are driven in the same
 * process that performed the encrypt, with a real `SOPS_AGE_KEY_FILE` in its
 * environment. Calling them in-process would work too, but the subprocess is what
 * proves the *command* behaves as advertised from a shell — which is the thing a
 * user runs.
 */
const SOPTS = new URL('../src/secrets/sops.ts', import.meta.url).pathname;

const tools = probeTools();
const canEncrypt = tools.sops && tools.age;

const created: string[] = [];

afterAll(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A throwaway git repository with an ignored secrets path.
 *
 * A real `git init`, because `isGitIgnored` asks git rather than reimplementing
 * ignore rules — and a directory that is not a repository makes that check report
 * "not ignored", which would make the tracked-path refusal untestable.
 */
const makeRepo = (): {
  root: string;
  identity: string;
  publicKey: string;
  env: NodeJS.ProcessEnv;
} => {
  const root = mkdtempSync(join(tmpdir(), 'starter-secrets-'));
  created.push(root);

  execFileSync('git', ['init', '-q', root], { cwd: root });
  // Ciphertext lives under a name that says so. Encrypting `app.env` in place is
  // refused precisely because a tracked name reads like a plain env file.
  writeFileSync(join(root, '.gitignore'), 'secrets/\n*.enc.env\n', 'utf8');

  // Ephemeral identity: created here, used here, never persisted.
  execFileSync('age-keygen', ['-o', join(root, 'identity.txt')], { cwd: root });
  const publicKey = readFileSync(join(root, 'identity.txt'), 'utf8').match(/age1[0-9a-z]+/)?.[0];
  if (publicKey === undefined) {
    throw new Error('age-keygen produced no public key');
  }

  return {
    root,
    identity: join(root, 'identity.txt'),
    publicKey,
    env: { ...process.env, SOPS_AGE_KEY_FILE: join(root, 'identity.txt') },
  };
};

const run = (script: string, env: NodeJS.ProcessEnv, root: string): string =>
  execFileSync('bun', ['-e', script], { cwd: root, env, encoding: 'utf8' });

describe('secrets: refusals that need no tools', () => {
  test('isGitIgnored asks git, so a tracked file is reported as tracked', () => {
    const root = mkdtempSync(join(tmpdir(), 'starter-ignore-'));
    created.push(root);
    execFileSync('git', ['init', '-q', root], { cwd: root });
    writeFileSync(join(root, '.gitignore'), 'secrets/\n', 'utf8');
    writeFileSync(join(root, 'tracked.env'), 'A=1\n', 'utf8');
    mkdirSync(join(root, 'secrets'), { recursive: true });
    writeFileSync(join(root, 'secrets', 'x.env'), 'A=1\n', 'utf8');

    expect(isGitIgnored(join(root, 'secrets', 'x.env'), root)).toBe(true);
    expect(isGitIgnored(join(root, 'tracked.env'), root)).toBe(false);
  });

  test('readRecipients returns nothing for an absent config', () => {
    const root = mkdtempSync(join(tmpdir(), 'starter-noconf-'));
    created.push(root);

    expect(readRecipients(join(root, '.sops.yaml'))).toEqual([]);
  });

  test('readRecipients finds every key in a list-shaped config', () => {
    const root = mkdtempSync(join(tmpdir(), 'starter-conf-'));
    created.push(root);
    writeFileSync(
      join(root, '.sops.yaml'),
      'creation_rules:\n  - path_regex: \\.env$\n    age:\n      - age1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n      - age1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n',
      'utf8',
    );

    expect(readRecipients(join(root, '.sops.yaml'))).toHaveLength(2);
  });

  test('init refuses a key that is not an age public key', () => {
    const root = mkdtempSync(join(tmpdir(), 'starter-badkey-'));
    created.push(root);

    expect(initConfig('not-a-key', root)).toBe(EXIT.usage);
    expect(initConfig(undefined, root)).toBe(EXIT.usage);
    expect(() => readFileSync(join(root, '.sops.yaml'))).toThrow();
  });

  test('update-recipients refuses when there is no config to update', () => {
    // "update" that silently creates is how a colleague's recipient list gets
    // replaced by yours.
    const root = mkdtempSync(join(tmpdir(), 'starter-noupd-'));
    created.push(root);

    expect(
      updateRecipients(['age1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], root),
    ).toBe(EXIT.unavailable);
  });
});

describe.skipIf(!canEncrypt)('secrets: a real round trip', () => {
  test('init writes a config that sops can actually encrypt with', () => {
    const repo = makeRepo();

    expect(initConfig(repo.publicKey, repo.root)).toBe(EXIT.ok);

    const config = readFileSync(join(repo.root, '.sops.yaml'), 'utf8');
    expect(config).toContain(repo.publicKey);
    // A list, not a folded scalar. sops folds `>-` lines into one string, so a
    // second recipient becomes one unparseable key and *every* encrypt fails.
    expect(config).toMatch(/age:\n\s+- age1/);
  });

  test('init refuses to replace an existing config', () => {
    const repo = makeRepo();
    initConfig(repo.publicKey, repo.root);

    // Replacing would drop every other person's recipient, making their files
    // unreadable to them.
    expect(initConfig(repo.publicKey, repo.root)).toBe(EXIT.refused);
    expect(readRecipients(join(repo.root, '.sops.yaml'))).toHaveLength(1);
  });

  test('encrypt then decrypt returns the original bytes', () => {
    const repo = makeRepo();
    initConfig(repo.publicKey, repo.root);

    const original = 'API_TOKEN=super-secret-value\nDB_NAME=production\n';
    writeFileSync(join(repo.root, 'app.enc.env'), original, 'utf8');

    const encrypted = run(
      `const { encryptFile } = await import('${SOPTS}');\nconst r = encryptFile('app.enc.env', process.cwd());\nconsole.log('ok=' + r.ok);`,
      repo.env,
      repo.root,
    );
    expect(encrypted).toContain('ok=true');

    const ciphertext = readFileSync(join(repo.root, 'app.enc.env'), 'utf8');
    expect(ciphertext).not.toContain('super-secret-value');

    const decrypted = spawnSync('sops', ['--decrypt', 'app.enc.env'], {
      cwd: repo.root,
      env: repo.env,
      encoding: 'utf8',
    });
    expect(decrypted.stdout).toBe(original);
  });

  test('decrypt refuses a git-tracked output path and writes nothing', () => {
    const repo = makeRepo();
    initConfig(repo.publicKey, repo.root);
    writeFileSync(join(repo.root, 'app.enc.env'), 'A=1\n', 'utf8');
    writeFileSync(join(repo.root, 'leaked.env'), 'untouched\n', 'utf8');
    execFileSync('git', ['add', '-f', 'leaked.env'], { cwd: repo.root });
    encryptFile('app.enc.env', repo.root);

    const result = run(
      `const { decryptFile } = await import('${SOPTS}');\nconst r = decryptFile('app.enc.env', 'leaked.env', process.cwd());\nconsole.log('ok=' + r.ok + ' code=' + r.code);`,
      repo.env,
      repo.root,
    );

    expect(result).toContain('ok=false code=4');
    expect(readFileSync(join(repo.root, 'leaked.env'), 'utf8')).toBe('untouched\n');
  });

  test('decrypt --out writes only to an ignored path, and creates its directory', () => {
    const repo = makeRepo();
    initConfig(repo.publicKey, repo.root);
    writeFileSync(join(repo.root, 'app.enc.env'), 'A=1\n', 'utf8');
    encryptFile('app.enc.env', repo.root);

    // `secrets/` is gitignored and therefore absent from a fresh clone, so writing
    // there without creating it threw ENOENT *after* a successful decrypt.
    const result = run(
      `const { decryptFile } = await import('${SOPTS}');\nconst r = decryptFile('app.enc.env', 'secrets/out.env', process.cwd());\nconsole.log('ok=' + r.ok);`,
      repo.env,
      repo.root,
    );

    expect(result).toContain('ok=true');
    expect(readFileSync(join(repo.root, 'secrets', 'out.env'), 'utf8')).toBe('A=1\n');
  });

  test('exec puts the decrypted value in the environment, with no braces attached', () => {
    const repo = makeRepo();
    initConfig(repo.publicKey, repo.root);
    writeFileSync(join(repo.root, 'exec.env'), 'API_TOKEN=exec-secret-value\n', 'utf8');

    const ciphertext = execFileSync(
      'sops',
      ['--encrypt', '--output-type', 'json', join(repo.root, 'exec.env')],
      { cwd: repo.root, env: repo.env, encoding: 'utf8' },
    );

    // The store is a json *document*, so the value must be extracted from it. Using
    // stdout whole would put `{"API_TOKEN":"…"}` into the environment — a secret that
    // is subtly wrong in a way nothing notices until something authenticates with it.
    const seen = spawnSync(
      'bun',
      [
        '-e',
        `const { execWithSecrets } = await import('${SOPTS}');\n` +
          `execWithSecrets(['sh', '-c', 'printf "%s" "$API_TOKEN"'], { API_TOKEN: ${JSON.stringify(ciphertext)} }, process.cwd());`,
      ],
      { cwd: repo.root, env: repo.env, encoding: 'utf8' },
    );

    expect(seen.stdout).toBe('exec-secret-value');
  });

  test('update-recipients keeps the existing recipient', () => {
    const repo = makeRepo();
    initConfig(repo.publicKey, repo.root);

    execFileSync('age-keygen', ['-o', join(repo.root, 'second.txt')], { cwd: repo.root });
    const second = readFileSync(join(repo.root, 'second.txt'), 'utf8').match(/age1[0-9a-z]+/)?.[0];
    expect(second).toBeDefined();

    expect(updateRecipients([second as string], repo.root)).toBe(EXIT.ok);

    // The original survives. The previous implementation captured the whole recipient
    // block and re-emitted it with only the new keys, so one call made every
    // already-encrypted file unreadable to the person who owned it.
    const recipients = readRecipients(join(repo.root, '.sops.yaml'));
    expect(recipients).toContain(repo.publicKey);
    expect(recipients).toContain(second as string);
  });

  test('a recipient added later cannot read what was encrypted before they joined', () => {
    // sops being correct, and the ordering is the whole test: encrypt *first*, then
    // add the recipient. My first attempt added the key before encrypting and then
    // asserted the opposite of what happened, which is a reminder that a test whose
    // setup contradicts its assertion will pass or fail for reasons unrelated to the
    // code under test.
    const repo = makeRepo();
    initConfig(repo.publicKey, repo.root);

    writeFileSync(join(repo.root, 'early.enc.env'), 'A=1\n', 'utf8');
    expect(encryptFile('early.enc.env', repo.root).ok).toBe(true);

    execFileSync('age-keygen', ['-o', join(repo.root, 'second.txt')], { cwd: repo.root });
    const second = readFileSync(join(repo.root, 'second.txt'), 'utf8').match(/age1[0-9a-z]+/)?.[0];
    expect(second).toBeDefined();
    expect(updateRecipients([second as string], repo.root)).toBe(EXIT.ok);

    const asSecond = { ...repo.env, SOPS_AGE_KEY_FILE: join(repo.root, 'second.txt') };

    // Before: not readable, because the data key was wrapped for the old recipient.
    const early = spawnSync('sops', ['--decrypt', 'early.enc.env'], {
      cwd: repo.root,
      env: asSecond,
      encoding: 'utf8',
    });
    expect(early.status).not.toBe(0);

    // After encrypting something new, it is.
    writeFileSync(join(repo.root, 'later.enc.env'), 'A=1\n', 'utf8');
    expect(encryptFile('later.enc.env', repo.root).ok).toBe(true);

    const later = spawnSync('sops', ['--decrypt', 'later.enc.env'], {
      cwd: repo.root,
      env: asSecond,
      encoding: 'utf8',
    });
    expect(later.status).toBe(0);

    // And the original recipient is not locked out by their colleague joining.
    const forFirst = spawnSync('sops', ['--decrypt', 'later.enc.env'], {
      cwd: repo.root,
      env: repo.env,
      encoding: 'utf8',
    });
    expect(forFirst.status).toBe(0);
  });

  test('encrypt refuses with no recipient, and leaves the file untouched', () => {
    const repo = makeRepo();
    writeFileSync(join(repo.root, 'x.env'), 'SECRET=1\n', 'utf8');

    // A file nobody can decrypt is not protected, it is lost.
    const result = run(
      `const { encryptFile } = await import('${SOPTS}');\nconst r = encryptFile('x.env', process.cwd());\nconsole.log('ok=' + r.ok + ' code=' + r.code);`,
      repo.env,
      repo.root,
    );

    expect(result).toContain('ok=false code=3');
    expect(readFileSync(join(repo.root, 'x.env'), 'utf8')).toBe('SECRET=1\n');
  });

  test('encrypt refuses a path git tracks', () => {
    const repo = makeRepo();
    initConfig(repo.publicKey, repo.root);
    writeFileSync(join(repo.root, 'tracked.env'), 'SECRET=1\n', 'utf8');
    execFileSync('git', ['add', '-f', 'tracked.env'], { cwd: repo.root });

    const result = run(
      `const { encryptFile } = await import('${SOPTS}');\nconst r = encryptFile('tracked.env', process.cwd());\nconsole.log('ok=' + r.ok + ' code=' + r.code);`,
      repo.env,
      repo.root,
    );

    expect(result).toContain('ok=false code=4');
    expect(readFileSync(join(repo.root, 'tracked.env'), 'utf8')).toBe('SECRET=1\n');
  });
});
