// apps/frontend/native/scripts/check_artifacts.ts
//
//   bun run --cwd apps/frontend/native check:artifacts -- <dir> --origin <url>
//     [--supabase-url <url>]
//
// What a mobile artifact is, and what is inside it.
//
// A `.deb`, an `.apk` and an `.ipa` are all just files with a name, and a name is
// the one thing about a build artifact that nothing verifies. Three failures
// produce a green CI run and an artifact nobody should install:
//
//   1. **A name that does not say what it is.** `app-release.apk` in a workflow
//      with a three-OS matrix is a file a reviewer cannot attribute to a target,
//      an architecture or a revision, and a support answer that starts with "which
//      one" is a packaging defect. Every artifact therefore carries product,
//      platform, target, source revision, and — the important one — whether it is
//      signed.
//   2. **Unsigned named as if it were a release.** A build nobody signed and an
//      artifact called `starter-android-aarch64-v1.2.3.aab` are the same file to
//      whoever installs it. `unsigned` is in the name or the artifact does not
//      exist.
//   3. **The wrong API origin inside.** The client embeds one origin at build
//      time, from `VITE_NATIVE_API_ORIGIN`. An artifact built against staging is
//      indistinguishable from one built against production once it is a binary,
//      and the difference is a bearer token posted to the wrong account's API.
//
// The origin check reads the bytes. An `.apk`, an `.aab` and an `.ipa` are all
// ZIP containers, so this opens them and scans the embedded frontend assets —
// which is the only place the origin is, and the only place a reviewer cannot
// look without a tool.
//
// Deliberately no third-party unzip. `unzip` is absent from a Nix dev shell half
// the time, `adm-zip` would be an unpinned transitive dependency in a template,
// and shelling out to a tool that may not exist turns "verify the artifact" into
// "skip if the tool is missing" — a successful no-op, which is worse than not
// checking. The reader below is the ZIP subset those three formats use, and it
// fails loudly on anything it does not understand.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

// ── ZIP reading ──────────────────────────────────────────────────────────────

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 65_535;

/** CRC-32 (IEEE), because a container whose entry does not match its checksum is not an entry. */
const crcTable = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export const crc32 = (data: Uint8Array): number => {
  let crc = 0xff_ff_ff_ff;
  for (const byte of data) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
};

/**
 * Read every entry of a ZIP container.
 *
 * Scans backwards for the end-of-central-directory record rather than assuming
 * it is the last 22 bytes: the last field is a comment, and an `.aab` built by
 * Gradle has been seen with a signing one.
 */
export const readZip = (bytes: Buffer): ZipEntry[] => {
  let eocd = -1;
  const floor = Math.max(0, bytes.length - MAX_COMMENT - 22);
  for (let offset = bytes.length - 22; offset >= floor; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('no ZIP end-of-central-directory record: this is not an .apk/.aab/.ipa');
  }

  const count = bytes.readUInt16LE(eocd + 10);
  let cursor = bytes.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`ZIP central directory entry ${index} has a bad signature`);
    }
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    if (bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`${name}: local header has a bad signature`);
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressedSize);
    const data = decompress(name, method, raw);

    if (crc32(data) !== expectedCrc) {
      throw new Error(`${name}: CRC mismatch, so the container is corrupt`);
    }
    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
};

/**
 * The two methods a ZIP produced by the native build pipeline can carry.
 *
 * A switch rather than a nested conditional because three branches on one value
 * is the shape `noNestedTernary` exists to refuse, and a method this reader does
 * not implement must be a named refusal rather than a silent `undefined`.
 */
const decompress = (name: string, method: number, raw: Buffer): Buffer => {
  switch (method) {
    case 0:
      return Buffer.from(raw);
    case 8:
      return inflateRawSync(raw);
    default:
      return unsupported(name, method);
  }
};

const unsupported = (name: string, method: number): never => {
  throw new Error(`${name}: compression method ${method} is not supported by this reader`);
};

/**
 * Build a ZIP with stored entries. Test fixture only.
 *
 * Stored rather than deflated so a test does not depend on the compressor
 * producing the same bytes on every platform, which would make a fixture hash a
 * property of the zlib build rather than of the reader.
 */
export const writeStoredZip = (entries: readonly { name: string; data: string }[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDirectory, eocd]);
};

// ── Naming ───────────────────────────────────────────────────────────────────

export const ARTIFACT_EXTENSIONS = ['apk', 'aab', 'ipa'] as const;
export type ArtifactExtension = (typeof ARTIFACT_EXTENSIONS)[number];

export interface ArtifactNameInput {
  readonly platform: string;
  readonly target: string;
  /** The full source revision. The first 12 characters are what goes in the name. */
  readonly revision: string;
  readonly extension: ArtifactExtension;
  /**
   * Whether this artifact was signed with a real identity.
   *
   * `false` puts `unsigned` in the name. It is the only way a download of an
   * unsigned build can be told from a signed one without installing it, and it is
   * the difference between "I could not get a signing key" and a false claim that
   * a distribution build exists.
   */
  readonly signed: boolean;
}

export const artifactName = (input: ArtifactNameInput): string => {
  const revision = input.revision.slice(0, 12);
  // The marker is always present. `signed` by omission would make an artifact
  // that somebody renamed by hand indistinguishable from one this function
  // produced, and the parser could not tell "signed" from "nobody said".
  return `starter-${input.platform}-${input.target}-${revision}-${
    input.signed ? 'signed' : 'unsigned'
  }.${input.extension}`;
};

/**
 * The signing marker is a required group, not an optional one.
 *
 * With `?` on the group, a name with no marker parsed as *signed* — so a file
 * named by a script that never thought about signing would be read as a signed
 * release artifact by the very check that exists to tell the two apart.
 */
const NAME_PATTERN =
  /^starter-(?<platform>[a-z]+)-(?<target>[a-z0-9_-]+)-(?<revision>[0-9a-f]{7,40})-(?<signing>signed|unsigned)\.(?<extension>apk|aab|ipa)$/;

export interface ParsedArtifactName {
  readonly platform: string;
  readonly target: string;
  readonly revision: string;
  readonly signed: boolean;
  readonly extension: ArtifactExtension;
}

/** Parse an artifact name, or null when it does not carry its provenance. */
export const parseArtifactName = (name: string): ParsedArtifactName | null => {
  const matched = NAME_PATTERN.exec(name);
  if (matched?.groups === undefined) {
    return null;
  }
  const groups = matched.groups;
  return {
    platform: groups.platform ?? '',
    target: groups.target ?? '',
    revision: groups.revision ?? '',
    // The marker is required by the pattern above, so this reads what the name
    // says rather than inferring it from its absence.
    signed: groups.signing === 'signed',
    extension: (groups.extension ?? 'apk') as ArtifactExtension,
  };
};

// ── Origin verification ──────────────────────────────────────────────────────

/**
 * Entries that could carry the origin.
 *
 * The frontend is HTML and JavaScript. An APK also holds a `.so`, a resource table
 * and a signature block; none of them can contain the client, and reading 40 MB of
 * ELF to find a string that is not there would make this check slow enough that
 * somebody would eventually mark it optional.
 */
const isFrontendAsset = (name: string): boolean =>
  /\.(?:js|mjs|cjs|html|css|json)$/.test(name) || name.endsWith('.html');

export interface ArtifactProblem {
  readonly code:
    | 'no_artifacts'
    | 'unattributable_name'
    | 'wrong_revision'
    | 'wrong_platform'
    | 'origin_missing'
    | 'foreign_origin'
    | 'unreadable_container'
    | 'no_frontend';
  readonly message: string;
  readonly remedy: string;
}

/** Absolute `http(s)://host[:port]` strings, which is what an API origin is. */
const ORIGIN_PATTERN = /https?:\/\/[a-z0-9.-]+(?::\d{1,5})?/gi;

/**
 * Hosts that are never an API origin, however they appear in a bundle.
 *
 * These are identifiers, not locations:
 *
 *   * `www.w3.org` — an SVG namespace or a `viewBox`, in every bundle that ships
 *     one.
 *   * `schema.tauri.app` — the `$schema` of the **embedded `tauri.conf.json`**.
 *     CI found this one: the Tauri CLI copies the config into the app's assets,
 *     so every APK and AAB carries it. It is the schema of the file, in the same
 *     way `www.w3.org` is the schema of an SVG.
 *   * `example.com` and subdomains — reserved by RFC 2606 for documentation and
 *     fixtures.
 *
 * Excluding a real deployment from this list would defeat the check, so it is
 * named rather than pattern-matched and tested from both sides: each entry has a
 * case that must be ignored and a case that must still be reported.
 */
const NEVER_AN_API_HOST = new Set(['www.w3.org', 'schema.tauri.app']);

/**
 * Loopback: the development `devUrl` the config carries, and nothing else.
 *
 * Stored bare. `new URL('http://[::1]:5173').hostname` is `'[::1]'` — brackets
 * included — so an IPv6 entry kept without them would never match, and the IPv6
 * loopback would be reported as a foreign deployment.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Is this URL something other than a deployment this client might call?
 *
 * `expected` is passed in rather than assumed, because a development build *can*
 * legitimately be configured against loopback — and that origin must still be
 * found, not excluded.
 */
export const isForeignOrigin = (candidate: string, expected: string): boolean => {
  if (candidate === expected) {
    return false;
  }
  let host: string;
  try {
    host = new URL(candidate).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (NEVER_AN_API_HOST.has(host)) {
    return false;
  }
  if (host === 'example.com' || host.endsWith('.example.com')) {
    return false;
  }
  // A packaged app cannot reach the developer's machine, and `tauri.conf.json`
  // carries `build.devUrl` — `http://127.0.0.1:1420` — into every artifact by
  // design. It is a *development* address, not the one the client calls.
  if (LOOPBACK_HOSTS.has(host)) {
    return false;
  }
  return true;
};

export interface VerifyOptions {
  readonly dir: string;
  /** The origin the artifact is supposed to talk to. */
  readonly expectedOrigin: string;
  /** The revision this run built. Compared against each name. */
  readonly revision: string;
  readonly platform: 'android' | 'ios';
  /** The configured Auth origin, allowed as a second deployment destination. */
  readonly supabaseUrl?: string;
}

export const verifyArtifacts = (options: VerifyOptions): ArtifactProblem[] => {
  let entries: string[];
  try {
    entries = readdirSync(options.dir).filter((entry) =>
      statSync(join(options.dir, entry)).isFile(),
    );
  } catch {
    return [
      {
        code: 'no_artifacts',
        message: `${options.dir} does not exist.`,
        remedy:
          'The build ran but produced nothing. Check the preceding step; a build that ' +
          'wrote no artifact must fail, not report success.',
      },
    ];
  }

  const candidates = entries.filter(
    (entry) => entry.endsWith('.apk') || entry.endsWith('.aab') || entry.endsWith('.ipa'),
  );
  if (candidates.length === 0) {
    return [
      {
        code: 'no_artifacts',
        message: `No .apk, .aab or .ipa in ${options.dir} (found: ${entries.join(', ') || 'nothing'}).`,
        remedy:
          'The mobile build did not produce a distributable. Run the build step again and ' +
          'read its output; this is not a packaging-naming problem.',
      },
    ];
  }

  const problems: ArtifactProblem[] = [];
  const shortRevision = options.revision.slice(0, 12);

  for (const candidate of candidates) {
    const parsed = parseArtifactName(candidate);
    if (parsed === null) {
      problems.push({
        code: 'unattributable_name',
        message: `"${candidate}" does not say what it is.`,
        remedy:
          'Rename it with artifactName(): product, platform, target, the first 12 ' +
          'characters of the source revision, and the literal `-signed` or ' +
          '`-unsigned`. A file nobody can attribute to a target, or whose signing ' +
          'state nothing states, is not a release artifact.',
      });
      continue;
    }
    if (parsed.platform !== options.platform) {
      problems.push({
        code: 'wrong_platform',
        message: `"${candidate}" is a ${parsed.platform} artifact in the ${options.platform} lane.`,
        remedy: 'Each lane uploads only its own platform, so this is a copy/paste in the workflow.',
      });
      continue;
    }
    if (!options.revision.startsWith(parsed.revision)) {
      problems.push({
        code: 'wrong_revision',
        message: `"${candidate}" was built from ${parsed.revision}, not ${shortRevision}.`,
        remedy:
          'The artifact and the run must agree. Stale artifacts in a restored cache are ' +
          'the usual cause; this lane does not cache build outputs.',
      });
      continue;
    }

    problems.push(...scanContainer(join(options.dir, candidate), candidate, options));
  }

  return problems;
};

const scanContainer = (path: string, name: string, options: VerifyOptions): ArtifactProblem[] => {
  let entries: ZipEntry[];
  try {
    entries = readZip(readFileSync(path));
  } catch (error) {
    return [
      {
        code: 'unreadable_container',
        message: `${name}: ${String(error).slice(0, 200)}`,
        remedy:
          'An .apk/.aab/.ipa is a ZIP. One that will not open here is either corrupt or not ' +
          'the file the build claimed, and neither may be uploaded.',
      },
    ];
  }

  const frontend = entries.filter((entry) => isFrontendAsset(entry.name));
  if (frontend.length === 0) {
    return [
      {
        code: 'no_frontend',
        message: `${name} contains no HTML or JavaScript.`,
        remedy:
          'The bundle was built without `frontendDist`, so the app would open a blank ' +
          'window. Check that `bun run build` ran before the Tauri build.',
      },
    ];
  }

  const expected = new URL(options.expectedOrigin).origin;
  const problems: ArtifactProblem[] = [];
  let found = false;
  const foreign = new Set<string>();

  for (const entry of frontend) {
    const text = entry.data.toString('utf8');
    for (const match of text.matchAll(ORIGIN_PATTERN)) {
      const candidate = match[0];
      if (candidate === expected) {
        found = true;
        continue;
      }
      // The local asset protocol and the packaged IPC channel are not API
      // origins. They are named in the CSP and would otherwise be reported as a
      // leaked deployment.
      if (
        candidate.startsWith('http://ipc.localhost') ||
        candidate.startsWith('http://asset.localhost')
      ) {
        continue;
      }
      const authOrigin =
        options.supabaseUrl === undefined ? null : new URL(options.supabaseUrl).origin;
      if (candidate === authOrigin) {
        continue;
      }
      if (isForeignOrigin(candidate, expected)) {
        foreign.add(candidate);
      }
    }
  }

  if (!found) {
    problems.push({
      code: 'origin_missing',
      message: `${name} does not contain ${expected} anywhere in its frontend.`,
      remedy:
        'The client was built against a different origin than this lane expects. Check ' +
        'VITE_NATIVE_API_ORIGIN; a bundle without it would fall back to the loopback ' +
        'default and fail every request on a phone.',
    });
  }
  if (foreign.size > 0) {
    problems.push({
      code: 'foreign_origin',
      message: `${name} also contains: ${[...foreign].join(', ')}.`,
      remedy:
        'One artifact talking to two origins means one build read two configurations. ' +
        "The extra origin is either a stale value or somebody's real API; both are wrong.",
    });
  }

  return problems;
};

// ── Entry point ──────────────────────────────────────────────────────────────

const USAGE = `check:artifacts <dir> [<dir> …] --origin <url> [--supabase-url <url>] --revision <sha> --platform <android|ios>
check:artifacts --name <platform> <target> <apk|aab|ipa> <signed|unsigned>

Verifies that every .apk/.aab/.ipa in each <dir> names its platform, target and
source revision, says whether it is signed, and actually contains the expected
API origin.

\`--name\` prints the one spelling of a file name, so a workflow renames the
artifact with the same function that checks it. Two implementations of a naming
scheme is how a lane starts uploading files nothing can attribute.

  bun run --cwd apps/frontend/native check:artifacts \\
    -- src-tauri/gen/android/app/build/outputs/apk/release \\
    --origin "\${VITE_NATIVE_API_ORIGIN}" --revision "\${GITHUB_SHA}" --platform android`;

/**
 * Split argv into directories and flags.
 *
 * A naive `filter((arg) => !arg.startsWith('--'))` treats every flag *value* as a
 * directory — `--origin https://api.example.test` yields one "directory" that is
 * a URL — and then checks the wrong one while reporting success about it. So the
 * flags that take a value consume it here, and `--` is dropped rather than being
 * handed to a path resolver as a file called `--`.
 */
const VALUE_FLAGS: readonly string[] = ['--origin', '--revision', '--platform', '--supabase-url'];

export const parseArgs = (
  args: readonly string[],
): { dirs: string[]; flags: Map<string, string>; failure: string | null } => {
  const dirs: string[] = [];
  const flags = new Map<string, string>();
  let naming = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';

    if (arg === '--') {
      continue;
    }
    if (naming || !arg.startsWith('--')) {
      dirs.push(arg);
      continue;
    }
    if (arg === '--name') {
      // Everything after this is the name's own positional arguments, not
      // directories to scan.
      naming = true;
      continue;
    }

    if (!VALUE_FLAGS.includes(arg)) {
      return { dirs, flags, failure: `Unknown flag "${arg}".` };
    }
    const value = args[index + 1] ?? '';
    if (value.length === 0 || value.startsWith('--')) {
      return { dirs, flags, failure: `${arg} needs a value.` };
    }
    index += 1;
    flags.set(arg, value);
  }

  return { dirs, flags, failure: null };
};

export const main = (args: readonly string[]): number => {
  const parsed = parseArgs(args);

  if (parsed.failure !== null) {
    process.stderr.write(`${parsed.failure}\n\n${USAGE}\n`);
    return 2;
  }
  const positional = parsed.dirs;
  const flag = (name: string): string | undefined => parsed.flags.get(name);

  if (args.includes('--name')) {
    const nameAt = args.indexOf('--name');
    const [platform, target, extension, signing] = args
      .slice(nameAt + 1)
      .filter((arg) => !arg.startsWith('--'));
    const extensions = ARTIFACT_EXTENSIONS as readonly string[];
    if (
      platform === undefined ||
      target === undefined ||
      extension === undefined ||
      signing === undefined ||
      !extensions.includes(extension) ||
      (signing !== 'signed' && signing !== 'unsigned')
    ) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    // The revision comes from the environment rather than argv: a workflow sets
    // GITHUB_SHA once, and passing a revision as an argument is how a stale one
    // gets typed.
    process.stdout.write(
      `${artifactName({
        platform,
        target,
        revision: process.env.GITHUB_SHA ?? process.env.REVISION ?? 'unknown',
        extension: extension as ArtifactExtension,
        signed: signing === 'signed',
      })}\n`,
    );
    return 0;
  }

  const expectedOrigin = flag('--origin');
  const revision = flag('--revision');
  const platform = flag('--platform');
  const supabaseUrl = flag('--supabase-url');

  if (
    positional.length === 0 ||
    expectedOrigin === undefined ||
    revision === undefined ||
    platform === undefined
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (platform !== 'android' && platform !== 'ios') {
    process.stderr.write(`--platform must be android or ios, not "${platform}".\n`);
    return 2;
  }

  // Every directory, combined. One lane's `apk/debug` and `bundle/release` are
  // the same claim about the same build, and checking only the first is how a
  // release `.aab` with the wrong origin ships next to a verified `.apk`.
  const problems = positional.flatMap((dir) =>
    verifyArtifacts({
      dir,
      expectedOrigin,
      revision,
      platform,
      ...(supabaseUrl === undefined ? {} : { supabaseUrl }),
    }),
  );

  if (problems.length === 0) {
    process.stdout.write(
      `artifacts ok: ${expectedOrigin} in every artifact under ${positional.join(', ')}\n`,
    );
    return 0;
  }
  process.stderr.write(`artifact check failed for ${positional.join(', ')}\n`);
  for (const problem of problems) {
    process.stderr.write(`  [${problem.code}] ${problem.message}\n      ${problem.remedy}\n`);
  }
  return 1;
};

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
