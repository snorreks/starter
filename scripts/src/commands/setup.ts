// scripts/src/commands/setup.ts
//
// `setup` and `doctor` are separate commands rather than one command with a
// `--doctor` flag, because they are invoked from different places: directory
// activation runs setup, and a person runs doctor when something is wrong. The
// implementation is shared either way.

import {
  isProfile,
  PROFILES,
  type Profile,
  profileCheckNames,
  profileChecks,
  profileRefusal,
} from '../setup/profiles.ts';
import { inspect, renderReport, runSetup, statusMark } from '../setup/setup.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';

/**
 * Read `--profile <name>`.
 *
 * Returned rather than parsed in place so `setup` and `doctor` share the decision,
 * and so an unknown name is refused with the list — never silently falling back to
 * `web`, which would make `--profile native` on a host with no Rust report a green
 * core lane.
 */
const readProfile = (
  argv: readonly string[],
): { profile: Profile; rest: string[] } | { error: string } => {
  const index = argv.indexOf('--profile');
  if (index === -1) {
    return { profile: 'web', rest: [...argv] };
  }

  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) {
    return { error: `--profile needs a value: ${PROFILES.join(', ')}.` };
  }
  if (!isProfile(value)) {
    return {
      error:
        `"${value}" is not a profile. Profiles: ${PROFILES.join(', ')}.
` + '  `web` is the credential-free core and the only one `bun run setup` requires.',
    };
  }

  return {
    profile: value,
    rest: argv.filter((_, position) => position !== index && position !== index + 1),
  };
};

const SETUP_USAGE = [
  'Usage: setup [--profile <name>] [--force] [--quiet]',
  '',
  'Idempotent. Prepares dependencies, local defaults and the Playwright browsers',
  'matching the locked version. Safe to run repeatedly, and cheap on a warm',
  'checkout because readiness is cached by lockfile, config and tool versions.',
  '',
  "  --profile web|native|android|ios|compute   which lane's prerequisites to check.",
  '           Default: web, which needs no Docker, Xcode, SDK or cloud key.',
  '  --force  re-run the steps a warm checkout would skip. It does not reinstall',
  '           dependencies that are already present.',
  '  --quiet  suppress progress output.',
].join('\n');

const DOCTOR_USAGE = [
  'Usage: doctor [--profile <name>]',
  '',
  'Tests capabilities and versions rather than command existence: each check runs',
  'the tool and reads what it reports.',
  '',
  `Profiles: ${PROFILES.join(', ')}`,
  '  web       Bun, Node, Wrangler, the pinned browser. No Docker, Xcode, SDK, key.',
  '  native    web + the Rust toolchain and, on Linux, the WebKitGTK 4.1 headers.',
  '  android   Rust + an Android SDK and a JDK.',
  '  ios       Rust + macOS with the full Xcode. Cannot pass on any other host.',
  '  compute   web + a running Docker-compatible engine.',
  '',
  'Exit 3 means this host cannot run the named lane; the message names the remedy.',
].join('\n');

export const setupCommand: Command = {
  name: 'setup',
  summary: 'prepare this checkout (idempotent)',
  usage: SETUP_USAGE,

  run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${SETUP_USAGE}\n`);
      return EXIT.ok;
    }
    // Forwarded: the usage above documents `--force` and `--quiet`, and they did
    // not reach `runSetup`, so a documented flag changed nothing.
    const parsed = readProfile(argv);
    if ('error' in parsed) {
      return fail(`${parsed.error}\n\n${SETUP_USAGE}`, EXIT.usage);
    }

    const known = new Set(['--force', '--quiet']);
    const unknown = parsed.rest.filter((arg) => !known.has(arg));

    if (unknown.length > 0) {
      return fail(`Unknown flag "${unknown[0]}".\n\n${SETUP_USAGE}`, EXIT.usage);
    }

    // Checked *before* anything is written.
    //
    // This ran `runSetup` first and only then evaluated the profile, so a refusal
    // followed changes setup had already made — it wrote `.env`, installed
    // dependencies and possibly downloaded a browser, then said the lane was
    // unavailable. "Nothing was written" is the promise the message makes, and the
    // order was what broke it.
    if (parsed.profile !== 'web') {
      const extra = profileChecks(parsed.profile);
      const missing = extra
        .filter((check) => !check.ok && check.severity === 'required')
        .map((check) => check.name);

      process.stdout.write(
        `\nProfile: ${parsed.profile} (checks: ${profileCheckNames(parsed.profile).join(', ')})\n`,
      );
      for (const check of extra) {
        process.stdout.write(`${statusMark(check)} ${check.name.padEnd(16)} ${check.detail}\n`);
      }

      if (missing.length > 0) {
        process.stderr.write(`\n${profileRefusal(parsed.profile, missing)}\n`);
        return EXIT.unavailable;
      }
    }

    // A selected lane is *checked*, never partially prepared: setup installs the web
    // prerequisites and stops there. Pretending it installed an Android SDK would be
    // the "succeeds while doing nothing" this repository treats as the worst outcome.
    //
    // The core result is returned as-is, so a failing core lane is not replaced by a
    // profile answer — the two are different questions and the exit code should say
    // which one failed.
    return runSetup(parsed.rest);
  },
};

export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'check capabilities and versions',
  usage: DOCTOR_USAGE,

  run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${DOCTOR_USAGE}\n`);
      return EXIT.ok;
    }

    const parsed = readProfile(argv);
    if ('error' in parsed) {
      return fail(`${parsed.error}\n\n${DOCTOR_USAGE}`, EXIT.usage);
    }

    const report = inspect();
    process.stdout.write(`Profile: ${parsed.profile}\n`);
    process.stdout.write(`${renderReport(report)}\n`);

    const extra = profileChecks(parsed.profile);
    for (const check of extra) {
      process.stdout.write(`${statusMark(check)} ${check.name.padEnd(16)} ${check.detail}\n`);
    }

    const allChecks = [...report.checks, ...extra];
    // Only a *required* failure is a refusal. A missing optional capability — a
    // browser, sops — is reported and named, because the lanes that need it say so
    // themselves. Failing here instead made `setup:doctor` exit 3 on a headless
    // host that can run every lane it claims to run.
    const missing = allChecks
      .filter((check) => !check.ok && check.severity === 'required')
      .map((check) => check.name);

    if (missing.length > 0) {
      // `missing`, not `report.missingRequired`. The latter only covers the core
      // checks, so a profile whose prerequisites are absent printed an empty header
      // above a list of the very things that were missing.
      process.stderr.write(`\nMissing required capabilities: ${missing.join(', ')}\n`);
      for (const check of allChecks) {
        if (!check.ok && check.remedy) {
          process.stderr.write(`  ${check.name}: ${check.remedy}\n`);
        }
      }
    }

    // Exit 3, not 1: "this host cannot run this lane" is a different answer from
    // "the repository is broken", and a CI job that runs a compute lane on a host
    // with no Docker should say so rather than reporting a generic failure.
    return missing.length > 0 ? EXIT.unavailable : EXIT.ok;
  },
};
