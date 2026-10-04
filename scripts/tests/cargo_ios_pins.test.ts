// scripts/tests/cargo_ios_pins.test.ts
//
// The one Cargo pin that exists because an upstream crate is unmaintained.
//
// `libc 0.2.190` gated `mach_task_self()` behind `#[cfg(target_os = "macos")]`.
// `num_threads 0.1.7` — the last release, and the crate has had none since —
// routes `target_os = "ios"` to `apple.rs`, which calls exactly that function.
// So the pinned Tauri shell does not compile for `aarch64-apple-ios`, and CI
// proved it with `error[E0425]: cannot find function mach_task_self in crate
// libc` from `num_threads`.
//
// There is no upgrade path, which is why this is a pin and not a wait:
//
//   * `num_threads` has no release after 0.1.7. Verified against the registry,
//     not assumed.
//   * `time` depends on it unconditionally, and `time` is reached by `cookie`,
//     `plist`, `tauri-codegen` and `tauri-plugin-log` — dropping any of those is
//     not a change this repository makes to fix a transitive build error.
//   * The last `libc` before the regression is `0.2.189`, and it satisfies
//     `rustix`'s `^0.2.182`, so the whole tree resolves at that pin.
//
// A lockfile pin is durable only until somebody runs `cargo update`. That is the
// failure this test exists for: without it the next routine `cargo update`
// silently restores a broken iOS build, and the symptom is a CI job that fails
// three minutes in with an error about a crate nobody in this repository depends
// on.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/shared/paths.ts';

const NATIVE_LOCK = join(REPO_ROOT, 'apps/frontend/native/src-tauri/Cargo.lock');
const MEDIA_LOCK = join(REPO_ROOT, 'apps/backend/media/Cargo.lock');

/** The last `libc` release that still exposes `mach_task_self` to iOS targets. */
export const LAST_IOS_COMPATIBLE_LIBC = '0.2.189';

const versionTriple = (value: string): [number, number, number] => {
  const parts = value.split('.').map((part) => Number.parseInt(part, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
};

const compareVersions = (left: string, right: string): number => {
  const a = versionTriple(left);
  const b = versionTriple(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

/**
 * Is this lockfile allowed to carry this `libc`?
 *
 * Conditional on `num_threads` being present, deliberately. The media crate is
 * on `libc 0.2.190` today and is **not** broken: nothing in its tree reaches
 * `num_threads`, so nothing calls `mach_task_self`. A rule that pinned every
 * Rust crate in the repository would push a downgrade onto a crate that has no
 * problem, and would be deleted the first time it got in the way.
 */
export const libcIsAcceptable = (lock: string): { ok: boolean; reason: string } => {
  if (!lock.includes('name = "num_threads"')) {
    return {
      ok: true,
      reason: 'no num_threads in this tree, so nothing calls libc::mach_task_self',
    };
  }
  const libc = /name = "libc"\nversion = "([^"]+)"/.exec(lock)?.[1];
  if (libc === undefined) {
    return { ok: false, reason: 'num_threads is present but no libc entry was found' };
  }
  if (compareVersions(libc, LAST_IOS_COMPATIBLE_LIBC) <= 0) {
    return { ok: true, reason: `libc ${libc} is at or below ${LAST_IOS_COMPATIBLE_LIBC}` };
  }
  return {
    ok: false,
    reason:
      `libc ${libc} gates mach_task_self() behind #[cfg(target_os = "macos")], and the ` +
      'unmaintained num_threads 0.1.7 calls it for target_os = "ios". Any iOS build ' +
      `fails with E0425. Pin: cargo update -p libc --precise ${LAST_IOS_COMPATIBLE_LIBC}.`,
  };
};

describe('the Tauri shell lockfile', () => {
  test('it is readable', () => {
    expect(readFileSync(NATIVE_LOCK, 'utf8')).toContain('name = "tauri"');
  });

  test('libc is pinned below the regression, because this tree does contain num_threads', () => {
    const lock = readFileSync(NATIVE_LOCK, 'utf8');
    const verdict = libcIsAcceptable(lock);

    // Stated rather than assumed: if a future `time` drops `num_threads`, the
    // constraint stops applying and that is a fact to re-check, not a licence to
    // bump libc without looking.
    expect(lock).toContain('name = "num_threads"');
    expect(verdict.ok).toBe(true);
  });

  test('a lockfile on libc 0.2.190 is refused with the reason and the remedy', () => {
    const verdict = libcIsAcceptable(
      'name = "num_threads"\nversion = "0.1.7"\nname = "libc"\nversion = "0.2.190"\n',
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('0.2.189');
    expect(verdict.reason).toContain('cargo update -p libc --precise');
    expect(verdict.reason).toContain('mach_task_self');
  });

  test('the boundary is the version, not the string', () => {
    expect(libcIsAcceptable('name = "num_threads"\nname = "libc"\nversion = "0.2.189"').ok).toBe(
      true,
    );
    expect(libcIsAcceptable('name = "num_threads"\nname = "libc"\nversion = "0.2.190"').ok).toBe(
      false,
    );
    // Lexicographic order would call 0.2.100 "less than" 0.2.189.
    expect(libcIsAcceptable('name = "num_threads"\nname = "libc"\nversion = "0.2.200"').ok).toBe(
      false,
    );
    expect(libcIsAcceptable('name = "num_threads"\nname = "libc"\nversion = "0.2.9"').ok).toBe(
      true,
    );
  });
});

describe('the media crate is deliberately not covered', () => {
  test('its tree has no num_threads, so its newer libc is fine', () => {
    const lock = readFileSync(MEDIA_LOCK, 'utf8');

    expect(lock).not.toContain('name = "num_threads"');
    expect(libcIsAcceptable(lock).ok).toBe(true);
  });

  test('and that is a checked fact, not an exemption written into the rule', () => {
    // If a future dependency ever puts `num_threads` under `apps/backend/media`,
    // this test fails and the constraint starts applying — which is the correct
    // outcome, and is why the rule reads the lockfile rather than a path list.
    const verdict = libcIsAcceptable('name = "num_threads"\nname = "libc"\nversion = "0.2.190"');

    expect(verdict.ok).toBe(false);
  });
});
