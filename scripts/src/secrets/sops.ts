// scripts/src/secrets/sops.ts
//
// Real SOPS operations, against the real `sops` and `age` binaries.
//
// Every operation here was previously a refusal that exited 3, which was correct and
// incomplete: the honest thing to do about a missing feature is refuse, and printing
// the invocation that would work. What was missing was the feature.
//
// The design constraint from the audit still holds and shapes all of it: **no
// inherited configuration**. Recipients identify people, not projects, so this
// module never ships a key, never generates one behind the operator's back, and
// never writes a `.sops.yaml` naming somebody else's recipient.
//
// Four properties every operation shares:
//
//   1. **The target file is always explicit.** No operation infers one from a
//      directory scan. `secrets:encrypt` with no path refuses rather than picking
//      something, because encrypting the wrong file publishes it to your team.
//   2. **Decrypted output only ever goes to a gitignored path.** A `--out` inside
//      the tracked tree is refused, not merely warned about.
//   3. **Nothing is reported as done unless it was.** Every exit code here comes
//      from the child process's own status.
//   4. **The tools are probed, not assumed.** `which sops` proves a file exists;
//      running it proves it works, and this host has both a Nix store `sops` and no
//      way to know whether a developer's PATH differs.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';

export const SOPS_CONFIG = join(REPO_ROOT, '.sops.yaml');
export const AGE_DIR = join(REPO_ROOT, '.age');
export const RECIPIENTS_FILE = join(AGE_DIR, 'recipients.txt');

/**
 * The shared exit codes, re-exported.
 *
 * This module used to declare its own table. That is a direct violation of the
 * invariant documented on `shared/command.ts` — "in one place because 'exit 3' only
 * means something if it means the same thing everywhere" — and it had a cost
 * immediately: `secrets exec` with no command returned this table's `usage`, and the
 * dispatcher in `secrets.ts` collapsed it to `failed`, so a caller could not tell a
 * typo from a refusal.
 */
export { EXIT } from '../shared/command.ts';

import { EXIT } from '../shared/command.ts';

/** Does this command actually run? Not merely exist. */
export const toolRuns = (command: string, args: readonly string[]): boolean => {
  const probe = spawnSync(command, [...args], { stdio: 'ignore', cwd: REPO_ROOT });
  return probe.error === undefined && probe.status === 0;
};

export interface ToolReport {
  sops: boolean;
  age: boolean;
}

export const probeTools = (): ToolReport => ({
  sops: toolRuns('sops', ['--version']),
  age: toolRuns('age', ['--version']),
});

/** An age public key, as it appears in a config or on a command line. */
const AGE_KEY = /age1[0-9a-z]{58}/;

/**
 * Read the recipients a `.sops.yaml` names, or none if it is absent or unreadable.
 *
 * Takes the *path*, not a root, so a caller testing against a throwaway repository
 * reads that repository's config. The previous version defaulted to the absolute
 * `SOPS_CONFIG` and ignored its `root` argument entirely, so every `root`-taking
 * operation read the starter's own config — which made a test either vacuous or
 * dependent on this checkout's state.
 */
export const readRecipients = (configPath: string): string[] => {
  if (!existsSync(configPath)) {
    return [];
  }
  const text = readFileSync(configPath, 'utf8');
  return [...new Set(text.match(new RegExp(AGE_KEY.source, 'g')) ?? [])];
};

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/** Run sops with the given arguments, never throwing. */
export const runSops = (
  args: readonly string[],
  options: { input?: string; root?: string } = {},
): RunResult => {
  const result = spawnSync('sops', [...args], {
    cwd: options.root ?? REPO_ROOT,
    encoding: 'utf8',
    input: options.input,
  });

  if (result.error !== undefined) {
    return {
      ok: false,
      code: EXIT.unavailable,
      stdout: result.stdout ?? '',
      stderr: `sops could not be run: ${result.error.message}`,
    };
  }

  return {
    ok: result.status === 0,
    code: result.status ?? EXIT.failed,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

/**
 * Is this path one git would track?
 *
 * Deliberately asks git rather than reimplementing ignore rules: a hand-rolled
 * matcher disagrees with `.gitignore` in at least one case per release, and the
 * failure here is writing a decrypted secret into a file that gets committed.
 * `git check-ignore` exits 0 for ignored, 1 for tracked, and >1 for "not a repo" —
 * the last is treated as *not ignored*, because that is the safe direction.
 */
export const isGitIgnored = (path: string, root: string = REPO_ROOT): boolean => {
  const result = spawnSync('git', ['check-ignore', '-q', path], { cwd: root, stdio: 'ignore' });
  return result.status === 0;
};

/** Paths outside the repository are never tracked, so always acceptable. */
const isOutsideRepo = (path: string, root: string): boolean => {
  const rel = relative(root, resolve(path));
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

/**
 * Encrypt a file in place.
 *
 * In place rather than writing a new file, because a copy left beside the original
 * is a plaintext secret that outlives the command that was meant to protect it. sops
 * writes a temporary file and renames, so a failure leaves the input untouched.
 */
export const encryptFile = (path: string, root: string = REPO_ROOT): RunResult => {
  const absolute = resolve(root, path);

  if (!existsSync(absolute)) {
    return {
      ok: false,
      code: EXIT.usage,
      stdout: '',
      stderr: `${path} does not exist. Nothing was encrypted.\n  Pass the file explicitly; this command never guesses a target.`,
    };
  }

  if (readRecipients(join(root, '.sops.yaml')).length === 0) {
    return {
      ok: false,
      code: EXIT.unavailable,
      stdout: '',
      stderr:
        'No age recipient is configured.\n' +
        '  Run `bun run secrets:init` to add your own public key.\n' +
        '  Nothing was encrypted: a file nobody can decrypt is not protected, it is lost.',
    };
  }

  // Already ciphertext, or genuinely secret material in the tracked tree.
  if (!isGitIgnored(absolute, root) && !isOutsideRepo(absolute, root)) {
    return {
      ok: false,
      code: EXIT.refused,
      stdout: '',
      stderr:
        `${relative(root, absolute)} is tracked by git.\n` +
        '  Encrypting it in place would commit the ciphertext under a name that reads\n' +
        '  like a plain env file. Add it to .gitignore first, or encrypt a copy in a\n' +
        '  gitignored path. Nothing was changed.',
    };
  }

  return runSops(['--encrypt', '--in-place', absolute], { root });
};

/**
 * Decrypt to stdout, or to a file when one is named.
 *
 * With no `--out`, the plaintext goes to stdout and nothing is written to disk. That
 * is the safe default: `sops -d f > somewhere` is where secrets end up in files
 * nobody chose.
 */
export const decryptFile = (
  path: string,
  out: string | undefined,
  root: string = REPO_ROOT,
): RunResult => {
  const absolute = resolve(root, path);

  if (!existsSync(absolute)) {
    return {
      ok: false,
      code: EXIT.usage,
      stdout: '',
      stderr: `${path} does not exist. Nothing was decrypted.`,
    };
  }

  if (out !== undefined) {
    const absoluteOut = resolve(root, out);
    if (!isOutsideRepo(absoluteOut, root) && !isGitIgnored(absoluteOut, root)) {
      return {
        ok: false,
        code: EXIT.refused,
        stdout: '',
        stderr:
          `Refusing to write decrypted output to ${relative(root, absoluteOut)}, which git tracks.\n` +
          '  A decrypted secret in a tracked file is committed by the next `git add`.\n' +
          '  Name a gitignored path, or omit --out to print to stdout.\n' +
          '  Nothing was decrypted.',
      };
    }
  }

  const result = runSops(['--decrypt', absolute], { root });
  if (!result.ok || out === undefined) {
    return result;
  }

  const absoluteOut = resolve(root, out);

  // The output directory may not exist yet — `secrets/` is gitignored, so a fresh
  // clone does not have it. Writing without creating it threw ENOENT *after* a
  // successful decrypt, which reports as a crash and loses the plaintext.
  try {
    mkdirSync(dirname(absoluteOut), { recursive: true });
  } catch (error) {
    return {
      ok: false,
      code: EXIT.failed,
      stdout: '',
      stderr:
        `Could not create ${relative(root, dirname(absoluteOut))}: ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        '  Nothing was written.',
    };
  }

  try {
    writeFileSync(absoluteOut, result.stdout, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    return {
      ok: false,
      code: EXIT.failed,
      stdout: '',
      stderr:
        `Could not write ${relative(root, absoluteOut)}: ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        '  Nothing was written.',
    };
  }

  return {
    ok: true,
    code: EXIT.ok,
    stdout: '',
    stderr: `Wrote ${relative(root, absoluteOut)} (mode 600).`,
  };
};

/**
 * Run a command with secrets in its environment.
 *
 * The whole point of a secret store: the value reaches the process and never reaches
 * a file. `--` is passed so a value beginning with `-` is not read as a flag of this
 * command.
 */
export const execWithSecrets = (
  command: readonly string[],
  env: Readonly<Record<string, string>>,
  root: string = REPO_ROOT,
): RunResult => {
  if (command.length === 0) {
    return {
      ok: false,
      code: EXIT.usage,
      stdout: '',
      stderr: 'No command given. Usage: secrets exec --env KEY=<ciphertext> -- <command>',
    };
  }

  const decrypted: Record<string, string> = {};
  const failures: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    // All four flags are load-bearing, and each absence fails in a way that names the
    // wrong thing. Verified by running sops:
    //
    //  - no `--input-type`   sops treats the input as a file path and reads it as an age
    //                        key: `failed to parse input as age key … invalid character`
    //  - no file argument    `Error: no file specified` — sops does not read piped
    //                        stdin without one, so `/dev/stdin` is explicit
    //  - `--output-type binary` on a json store
    //                        `error emitting binary store: no binary data found in tree`
    //
    // The store is json because a ciphertext is a whole JSON document, not one value:
    // it carries the key's own metadata alongside the data.
    const result = runSops(
      ['--decrypt', '--input-type', 'json', '--output-type', 'json', '/dev/stdin'],
      { input: value, root },
    );
    if (!result.ok) {
      failures.push(`${key}: ${result.stderr.trim() || `sops exited ${result.code}`}`);
      continue;
    }

    // The store is json, so stdout is a JSON *document*, not the value. Taking it
    // wholesale would put `{"API_TOKEN":"…"}` into the environment, with braces and
    // quotes attached — a secret that is subtly wrong in a way no test would notice
    // until something tried to authenticate with it.
    let extracted: string | null = null;

    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (typeof parsed === 'object' && parsed !== null) {
        const value = (parsed as Record<string, unknown>)[key];
        extracted = typeof value === 'string' ? value : null;
      } else if (typeof parsed === 'string') {
        extracted = parsed;
      }
    } catch {
      extracted = null;
    }

    if (extracted === null) {
      failures.push(
        `${key}: the ciphertext decrypted, but not to a "${key}" value.\n` +
          `    sops returned: ${result.stdout.slice(0, 120).trim() || '(empty)'}`,
      );
      continue;
    }

    decrypted[key] = extracted;
  }

  if (failures.length > 0) {
    return {
      ok: false,
      code: EXIT.failed,
      stdout: '',
      stderr:
        'Could not decrypt every value, so the command was not run.\n' +
        failures.map((line) => `  ${line}`).join('\n') +
        '\n  Nothing was executed: a process started with some secrets missing fails in a way that blames the program.',
    };
  }

  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...decrypted },
  });

  if (result.error !== undefined) {
    return {
      ok: false,
      code: EXIT.failed,
      stdout: '',
      stderr: `Could not run ${command[0]}: ${result.error.message}`,
    };
  }

  return { ok: result.status === 0, code: result.status ?? EXIT.failed, stdout: '', stderr: '' };
};

/**
 * Create `.sops.yaml` naming one recipient.
 *
 * Never generates a key: `age-keygen` writes a private key, and this module has no
 * business creating one. The operator runs it and supplies the *public* half, which
 * is the only part that belongs in a repository.
 *
 * Refuses to overwrite an existing config. Replacing one silently would drop every
 * other person's recipient, and their files would become undecryptable by anyone
 * reading them.
 */
export const initConfig = (recipient: string | undefined, root: string = REPO_ROOT): number => {
  if (recipient === undefined || !AGE_KEY.test(recipient)) {
    process.stderr.write(
      'secrets:init needs your age *public* key.\n' +
        '  Generate one:  age-keygen -o .age/key.txt   (keep that file out of git)\n' +
        '  Then:          bun run secrets:init -- age1...\n' +
        '  Nothing was written.\n',
    );
    return EXIT.usage;
  }

  const configPath = join(root, '.sops.yaml');

  if (existsSync(configPath)) {
    process.stderr.write(
      '.sops.yaml already exists. Not replacing it: every recipient in it may be\n' +
        '  someone else, and removing them would make their files unreadable.\n' +
        '  To add a recipient:  bun run secrets:update-recipients -- age1...\n',
    );
    return EXIT.refused;
  }

  // `age` is written as a YAML **list**, and that is not cosmetic. Both a folded
  // scalar (`>-`) and a block scalar (`|`) join the lines with a space, so two
  // recipients become one 124-character token and every subsequent encrypt fails
  // with `failed to parse input as age key … invalid character`. A list keeps them
  // separate. Verified by running sops against all four forms: `>-`, `|`, `[a, b]`
  // and a block list — only the two list forms accept more than one recipient.
  //
  // The rules also have to cover the names this repository actually uses, and sops
  // matches `path_regex` against the path *as given on the command line* — not
  // resolved, not absolute. A rule for `\.env$` therefore does not match
  // `.dev.vars`, and such a file fails with `no matching creation rules found`.
  const config = [
    '# SOPS configuration.',
    '#',
    '# Recipients are public keys identifying people, so they are yours to add and',
    '# yours to keep. This file is committed; the matching private keys are not.',
    '#',
    '# `age` is a list, not a folded scalar: `>-` joins lines with a space, so two',
    '# recipients become one unparseable key.',
    '#',
    '# `path_regex` is matched against the path as given on the command line, so a rule',
    '# for `\\.env$` does not match `.dev.vars`. This one covers the names used here.',
    'creation_rules:',
    '  - path_regex: \\.(dev\\.vars|env(\\.[a-z]+)?|json|ya?ml|toml)$',
    '    age:',
    `      - ${recipient}`,
    '',
  ].join('\n');

  writeFileSync(configPath, config, 'utf8');
  process.stdout.write(
    `Wrote .sops.yaml with 1 recipient.\n` +
      `  Add more people:  bun run secrets:update-recipients -- age1...\n` +
      '  Then encrypt:      bun run secrets:encrypt -- <gitignored-path>\n',
  );
  return EXIT.ok;
};

/**
 * Add recipients to an existing config, keeping the ones already there.
 *
 * Refuses without a config rather than creating one, because "update" that silently
 * creates is how a colleague's recipient list gets replaced by yours.
 */
export const updateRecipients = (
  recipients: readonly string[],
  root: string = REPO_ROOT,
): number => {
  const valid = recipients.filter((recipient) => AGE_KEY.test(recipient));
  const invalid = recipients.filter((recipient) => !AGE_KEY.test(recipient));

  const configPath = join(root, '.sops.yaml');

  if (valid.length === 0) {
    process.stderr.write(
      'No valid age public key given. A recipient looks like `age1...`.\n' +
        '  Nothing was changed.\n',
    );
    return EXIT.usage;
  }

  if (!existsSync(configPath)) {
    process.stderr.write(
      'No .sops.yaml to update.\n' +
        '  Run `bun run secrets:init -- age1...` first.\n' +
        '  Nothing was changed.\n',
    );
    return EXIT.unavailable;
  }

  const text = readFileSync(configPath, 'utf8');
  const existing = readRecipients(configPath);
  const added = valid.filter((recipient) => !existing.includes(recipient));

  if (added.length === 0) {
    process.stdout.write(`All ${valid.length} recipient(s) are already in .sops.yaml.\n`);
    return EXIT.ok;
  }

  // Appended after the existing `- age1…` entries of every rule, keeping them. Two
  // things were wrong before, and both were found by running sops rather than by
  // reading this:
  //
  //  - The original keys were *dropped*. The replacement captured the whole
  //    recipient block and re-emitted it with only the new keys, so after one
  //    `update-recipients` the config named the new person and nobody else, making
  //    every already-encrypted file unreadable to its owner.
  //  - New keys were appended as folded-scalar lines, which sops joins into a single
  //    token. A second recipient therefore broke *every* encrypt, with an error about
  //    age key encoding. Only the list form accepts more than one.
  const updated = text.replace(
    /(age:[ \t]*\n)((?:[ \t]*-[ \t]+age1[0-9a-z]+[ \t]*\n)+)/g,
    (_match: string, head: string, block: string) =>
      `${head}${block}${added.map((recipient) => `      - ${recipient}\n`).join('')}`,
  );

  if (updated === text) {
    process.stderr.write('No age list could be extended in .sops.yaml. Nothing was changed.\n');
    return EXIT.failed;
  }

  writeFileSync(configPath, updated, 'utf8');
  process.stdout.write(
    `Added ${added.length} recipient(s) to .sops.yaml; ${existing.length} kept.\n` +
      '  Files already encrypted can still only be read by the recipients that were\n' +
      '  listed when they were encrypted. To give the new recipients access, decrypt and\n' +
      '  re-encrypt each one:\n' +
      '    sops --decrypt <file> > <plaintext>   # then encrypt it again\n' +
      '  There is deliberately no bulk re-key here: every holder of the data key can read\n' +
      '  every secret, so widening access is a decision a person makes per file.\n',
  );
  for (const bad of invalid) {
    process.stderr.write(`  ignored, not an age public key: ${bad}\n`);
  }
  return EXIT.ok;
};

export { dirname };
