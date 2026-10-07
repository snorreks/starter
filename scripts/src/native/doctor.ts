// scripts/src/native/doctor.ts
//
// What this host can actually do with the native app.
//
// Same contract as `setup/doctor.ts`, narrower: this one asks only about the
// native lane, so a contributor on a machine with no Rust toolchain learns that
// *specifically* rather than discovering it four minutes into a build.
//
// Every check runs the thing and reads what it reports. `which cargo` proves a
// file exists; `cargo --version` proves it loads — and the difference is the one
// that bites on a fresh checkout, where the pinned toolchain is installed by
// `rustup` and everything else is a directory listing.
//
// Two severities, and the split matters:
//
//   * `required` for what `bun run native:dev` and `bun run native:build` need. A
//     missing one exits 3 (`EXIT.unavailable`) with the remedy, rather than
//     failing later inside Cargo with an error about a directory that does not
//     exist.
//   * `optional` for what only one platform needs (a Linux webview library, a
//     Windows SDK). Those report NOT AVAILABLE. They never report success for a
//     capability they could not check, and they never fail the command, because a
//     template cannot require an Android SDK to be useful.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, Severity } from '../setup/doctor.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { resolveWorkspaceBin } from '../shared/tools.ts';
import { NATIVE_DIR, TAURI_SUBDIR } from './platform.ts';

/** Run a command and take its first line of output. Null means it did not run. */
const probe = (command: string, args: readonly string[] = ['--version']): string | null => {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  const first = (result.stdout ?? '') + (result.stderr ?? '');
  return first.split('\n')[0]?.trim() ?? '';
};

/**
 * The pinned Tauri CLI.
 *
 * Resolved through the declaring package rather than `bunx`, for the reason in
 * `shared/tools.ts`: `bunx tauri` does not find a binary declared by one
 * workspace package, falls through to the network, and runs whatever the registry
 * serves. A desktop build against an unpinned CLI is not the build CI proved.
 */
const tauriCheck = (): Check => {
  const bin = resolveWorkspaceBin('tauri', [NATIVE_DIR]);
  if (bin === null) {
    return {
      name: 'tauri cli',
      severity: 'required',
      ok: false,
      detail: 'not installed',
      remedy:
        'It is a pinned devDependency of apps/frontend/native. Run `bun install` from ' +
        'the repository root.',
    };
  }

  const reported = probe(bin);
  if (reported === null) {
    return {
      name: 'tauri cli',
      severity: 'required',
      ok: false,
      detail: `${bin} did not run`,
      remedy:
        'The binary exists but does not load. On Linux that is usually a missing shared ' +
        'library; run it directly to see the linker error.',
    };
  }

  return { name: 'tauri cli', severity: 'required', ok: true, detail: reported };
};

/**
 * Cargo, and the plugin chain that comes with the shell.
 *
 * `cargo` is the compiler driver; the crates behind it are fetched by cargo
 * itself, so a missing registry is reported here rather than as a resolve failure
 * halfway through a release build.
 */
const cargoCheck = (): Check => {
  const reported = probe('cargo');
  if (reported === null) {
    return {
      name: 'cargo',
      severity: 'required',
      ok: false,
      detail: 'not on PATH',
      remedy:
        'Install the pinned toolchain from `apps/frontend/native/src-tauri/rust-toolchain.toml` ' +
        '(https://rustup.rs), or use a `nix develop` shell that provides it.',
    };
  }

  return { name: 'cargo', severity: 'required', ok: true, detail: reported };
};

const rustfmtCheck = (): Check => {
  const reported = probe('cargo', ['fmt', '--version']);
  return {
    name: 'rustfmt',
    severity: 'required',
    ok: reported !== null,
    detail: reported ?? 'cargo fmt is unavailable',
    ...(reported === null
      ? {
          remedy:
            'It is a component of the pinned toolchain: `rustup component add rustfmt`. ' +
            'Without it `bun run native:fmt` cannot be a check.',
        }
      : {}),
  };
};

const clippyCheck = (): Check => {
  const reported = probe('cargo', ['clippy', '--version']);
  return {
    name: 'clippy',
    severity: 'required',
    ok: reported !== null,
    detail: reported ?? 'cargo clippy is unavailable',
    ...(reported === null
      ? { remedy: 'It is a component of the pinned toolchain: `rustup component add clippy`.' }
      : {}),
  };
};

/**
 * The Linux webview libraries, reported as optional everywhere else.
 *
 * `pkg-config` asking is the honest test: Tauri links against `webkit2gtk`, and a
 * build that fails in `webkit2gtk-sys`'s build script names a crate rather than the
 * package to install.
 */
const webkitCheck = (): Check => {
  const severity: Severity = process.platform === 'linux' ? 'required' : 'optional';
  const found = probe('pkg-config', ['--exists', 'webkit2gtk-4.1']);

  return {
    name: 'webkit2gtk-4.1',
    severity,
    ok: found !== null,
    detail: found === null ? 'not found by pkg-config' : 'present',
    ...(found === null
      ? {
          remedy:
            'Install the WebKitGTK development package for your distribution ' +
            '(Debian/Ubuntu: libwebkit2gtk-4.1-dev; Fedora: webkit2gtk4.1-devel).',
        }
      : {}),
  };
};

/** The crate itself: a missing manifest means the doctor is checking nothing. */
const crateCheck = (): Check => {
  const manifest = join(REPO_ROOT, NATIVE_DIR, TAURI_SUBDIR, 'Cargo.toml');
  const ok = existsSync(manifest);
  return {
    name: 'src-tauri crate',
    severity: 'required',
    ok,
    detail: ok ? `${NATIVE_DIR}/${TAURI_SUBDIR}/Cargo.toml` : 'not found',
    ...(ok ? {} : { remedy: 'The Tauri shell is missing. Restore the directory from git.' }),
  };
};

const supabaseAuthProfileCheck = (): Check => {
  const profile = process.env.VITE_NATIVE_AUTH_PROFILE;
  if (profile === undefined || profile === '' || profile === 'legacy') {
    return {
      name: 'native auth profile',
      severity: 'required',
      ok: true,
      detail: 'legacy default',
    };
  }
  if (profile !== 'supabase') {
    return {
      name: 'native auth profile',
      severity: 'required',
      ok: false,
      detail: 'Unsupported native auth profile',
      remedy: 'Set VITE_NATIVE_AUTH_PROFILE to legacy or supabase, or leave it unset for legacy.',
    };
  }
  const required = [
    'VITE_NATIVE_API_ORIGIN',
    'VITE_NATIVE_ENVIRONMENT',
    'VITE_NATIVE_SUPABASE_URL',
    'VITE_NATIVE_SUPABASE_PROJECT_REF',
    'VITE_NATIVE_SUPABASE_ANON_KEY',
  ];
  const missing = required.filter((key) => !process.env[key]);
  return missing.length === 0
    ? {
        name: 'native auth profile',
        severity: 'required',
        ok: true,
        detail: 'Supabase target configured',
      }
    : {
        name: 'native auth profile',
        severity: 'required',
        ok: false,
        detail: `Supabase profile missing ${missing.join(', ')}`,
        remedy:
          'Set these public target values before building the Supabase native profile; callbacks are fixed by the native target configuration.',
      };
};

const CHECKS = [
  supabaseAuthProfileCheck,
  crateCheck,
  tauriCheck,
  cargoCheck,
  rustfmtCheck,
  clippyCheck,
  webkitCheck,
] as const;

export interface NativeReport {
  checks: Check[];
  ok: boolean;
  missingRequired: string[];
  unavailable: string[];
}

export const inspectNative = (): NativeReport => {
  const checks = CHECKS.map((check) => check());

  const missingRequired = checks
    .filter((check) => check.severity === 'required' && !check.ok)
    .map((check) => check.name);
  const unavailable = checks
    .filter((check) => check.severity === 'optional' && !check.ok)
    .map((check) => check.name);

  return { checks, ok: missingRequired.length === 0, missingRequired, unavailable };
};

export const renderNativeReport = (report: NativeReport): string => {
  const markFor = (check: Check): string => {
    if (check.ok) {
      return 'ok  ';
    }
    return check.severity === 'optional' ? 'N/A ' : 'MISS';
  };

  const lines = report.checks.map((check) => {
    const detail = check.ok
      ? check.detail
      : `${check.detail} — ${check.remedy ?? 'no remedy recorded'}`;
    return `  ${markFor(check)} ${check.name.padEnd(18)} ${detail}`;
  });

  const optional =
    report.unavailable.length === 0
      ? ''
      : ` Optional and unavailable here: ${report.unavailable.join(', ')}.`;
  const verdict = report.ok
    ? `Ready.${optional}`
    : `Not ready. Missing: ${report.missingRequired.join(', ')}.`;

  return ['Native desktop capability:', ...lines, '', verdict].join('\n');
};
