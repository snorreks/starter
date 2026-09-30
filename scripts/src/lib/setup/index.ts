// scripts/src/lib/setup/index.ts
//
//   bun run setup            # idempotent: safe to re-run
//   bun run setup:doctor     # report what is and is not available
//
// Setup does three things and refuses to do a fourth: check the toolchain,
// create local gitignore'd state, and print what is missing. It never
// overwrites an existing file, never contacts a service, and never needs a
// secret. Every step is safe to run twice.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { API_DIR, REPO_ROOT } from '../paths.ts';
import { playwrightBin, wranglerBin } from '../tools.ts';

export interface Check {
  name: string;
  required: boolean;
  ok: boolean;
  detail: string;
  remedy?: string;
}

const versionOf = (command: string, args: readonly string[] = ['--version']): string | null => {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  return (result.stdout ?? result.stderr ?? '').split('\n')[0]?.trim() ?? null;
};

/**
 * The required toolchain.
 *
 * `node` is required, and it is required *with a reason stated*: `wrangler dev` is
 * a Node program that spawns workerd, so without Node the Worker never starts and
 * both `test:integration` and `e2e` sit in a four-minute readiness timeout that
 * reads like a hang. Reporting "node missing (optional)" was wrong in the other
 * direction too — it let a lane that cannot work look fine.
 */
export const REQUIRED = [
  {
    name: 'bun',
    check: () => versionOf('bun'),
    remedy: 'Install Bun: https://bun.sh',
  },
  { name: 'git', check: () => versionOf('git'), remedy: 'Install git.' },
  {
    name: 'node',
    check: () => versionOf('node'),
    remedy:
      'Install Node 22+. `wrangler dev` is a Node program, so without it the Worker ' +
      'never starts and `bun run test:integration` / `bun run e2e` time out after ' +
      'four minutes. On Nix: nix-shell -p nodejs.',
  },
] as const;

/**
 * Optional tools, reported but never blocking.
 *
 * Where the repository pins the tool itself, the pinned copy is reported rather than
 * whatever is on PATH — see `scripts/src/lib/tools.ts` for why a global wrangler is
 * not the same thing as this project's wrangler.
 */
export const OPTIONAL = [
  {
    name: 'wrangler',
    check: () => {
      const bin = wranglerBin();
      if (bin === null) {
        return null;
      }
      return versionOf(bin);
    },
    why: 'Local Cloudflare Workers + D1',
    remedy: 'Run `bun install` — wrangler is a pinned dependency of apps/backend/api.',
  },
  { name: 'sops', check: () => versionOf('sops', ['--version']), why: 'Secret encryption' },
  { name: 'age', check: () => versionOf('age', ['--version']), why: 'Secret encryption' },
  { name: 'cargo', check: () => versionOf('cargo'), why: 'Tauri desktop builds' },
  { name: 'direnv', check: () => versionOf('direnv', ['--version']), why: '.envrc loading' },
  {
    name: 'playwright',
    check: () => (playwrightBin() === null ? null : 'installed'),
    why: 'Browser tests and E2E',
    remedy:
      'Run `bunx playwright install --with-deps chromium`. Note the browser also needs ' +
      'system shared libraries; on NixOS the stock Linux build does not run.',
  },
] as const;

/**
 * One thing this repository verifies that a version string cannot.
 *
 * The API's Wrangler config must exist and name its D1 migrations directory. A
 * missing `database_id` is expected in a template — the operator provisions it —
 * so this checks structure, not completeness.
 */
export const WORKER_CONFIG_CHECK = (): Check => {
  const config = join(API_DIR, 'wrangler.jsonc');
  if (!existsSync(config)) {
    return {
      name: 'wrangler.jsonc',
      required: true,
      ok: false,
      detail: 'missing',
      remedy: `Restore ${config}.`,
    };
  }

  const text = readFileSync(config, 'utf8');
  const hasDb = /"d1_databases"/.test(text);
  const hasMigrationsDir = /"migrations_dir"/.test(text);

  return {
    name: 'wrangler.jsonc',
    required: true,
    ok: hasDb && hasMigrationsDir,
    detail: hasDb && hasMigrationsDir ? 'D1 binding and migrations_dir present' : 'incomplete',
    ...(hasDb && hasMigrationsDir
      ? {}
      : { remedy: 'It must name a d1_databases binding and its migrations_dir.' }),
  };
};

export interface Report {
  checks: Check[];
  ok: boolean;
  missingRequired: string[];
}

export const inspect = (): Report => {
  const checks: Check[] = [];

  for (const tool of REQUIRED) {
    const version = tool.check();
    checks.push({
      name: tool.name,
      required: true,
      ok: version !== null,
      detail: version ?? 'not found',
      ...(version === null ? { remedy: tool.remedy } : {}),
    });
  }

  checks.push(WORKER_CONFIG_CHECK());

  for (const tool of OPTIONAL) {
    const version = tool.check();
    checks.push({
      name: tool.name,
      required: false,
      ok: version !== null,
      detail: version ?? 'not found (optional)',
      ...(version === null && 'remedy' in tool && tool.remedy !== undefined
        ? { remedy: tool.remedy }
        : {}),
    });
  }

  const missingRequired = checks
    .filter((check) => check.required && !check.ok)
    .map((check) => check.name);

  return { checks, ok: missingRequired.length === 0, missingRequired };
};

const LOCAL_ENV = `# Local environment. Gitignored. Never contains a real secret.
# Every value here is a development default, so a fresh clone runs with no setup.
PUBLIC_MODE=local
PUBLIC_LOG_LEVEL=DEBUG
PUBLIC_APP_VERSION=dev
PUBLIC_API_BASE_URL=
PUBLIC_API_PORT=8787
`;

const writeIfAbsent = (path: string, contents: string, mode?: number): boolean => {
  if (existsSync(path)) {
    return false;
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
  return true;
};

/**
 * Copy a committed example into place, if the destination does not exist.
 *
 * Never overwrites. A developer's `.dev.vars` holds their own
 * `BETTER_AUTH_SECRET`, and a setup script that silently replaced it would
 * invalidate every session they have.
 */
const copyIfAbsent = (from: string, to: string): boolean => {
  if (existsSync(to) || !existsSync(from)) {
    return false;
  }
  mkdirSync(join(to, '..'), { recursive: true });
  copyFileSync(from, to);
  return true;
};

/**
 * The status marker for one toolchain check.
 *
 * A named helper rather than an inline nested ternary: three outcomes folded
 * into one expression reads correctly only if you already know the precedence,
 * and the two call sites that use it disagreed on spacing before.
 */
const statusMark = (check: Check): string => {
  if (check.ok) {
    return '  ok  ';
  }
  return check.required ? ' MISS ' : '  --  ';
};

export const runSetup = (): number => {
  const report = inspect();

  process.stdout.write('Toolchain\n');
  for (const check of report.checks) {
    // A named helper rather than a nested ternary: three outcomes in one
    // expression reads correctly only if you already know the precedence.
    const mark = statusMark(check);
    process.stdout.write(`${mark} ${check.name.padEnd(10)} ${check.detail}\n`);
  }

  if (!report.ok) {
    process.stderr.write(
      `\nMissing required tools: ${report.missingRequired.join(', ')}\n` +
        'Install them, then re-run `bun run setup`.\n',
    );
    return 1;
  }

  // Idempotent local state. Everything written here is gitignored.
  const created: string[] = [];
  if (writeIfAbsent(join(REPO_ROOT, '.env'), LOCAL_ENV)) {
    created.push('.env (local defaults only)');
  }
  if (writeIfAbsent(join(REPO_ROOT, 'apps/frontend/client/.env'), LOCAL_ENV)) {
    created.push('apps/frontend/client/.env');
  }
  // The Worker reads `.dev.vars`, not `.env` — a different filename for the
  // different runtime, which is Wrangler's convention rather than an accident.
  if (
    copyIfAbsent(
      join(REPO_ROOT, 'apps/backend/api/.dev.vars.example'),
      join(REPO_ROOT, 'apps/backend/api/.dev.vars'),
    )
  ) {
    created.push('apps/backend/api/.dev.vars (from the example; local defaults)');
  }

  process.stdout.write('\nSetup\n');
  if (created.length === 0) {
    process.stdout.write('  ok    nothing to do (already set up)\n');
  } else {
    for (const path of created) {
      process.stdout.write(`  new   ${path}\n`);
    }
  }

  process.stdout.write(
    '\nNext:\n' +
      '  bun run db:generate   # create migrations from the Drizzle schema\n' +
      '  bun run db:migrate    # apply them to the local database\n' +
      '  bun run dev:api       # start the local Worker\n' +
      '  bun run dev           # start the client\n',
  );
  return 0;
};

export const main = (args: readonly string[]): number => {
  if (args.includes('--doctor')) {
    const report = inspect();
    for (const check of report.checks) {
      process.stdout.write(`${statusMark(check)}${check.name.padEnd(10)} ${check.detail}\n`);
    }
    return report.ok ? 0 : 1;
  }
  return runSetup();
};

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
