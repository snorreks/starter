// scripts/tests/commands.test.ts
//
// The command adapters: argv, exit code, and what they print.
//
// A command adapter is thin on purpose — it parses argv, renders help and picks a
// code — so that is exactly where the failures are cheap to have. Every case here
// is one where the adapter accepted something it should have refused, returned a
// code that meant the wrong thing, or dropped a flag the usage line documents.
//
// Each is called through `Command.run` rather than a spawned process: the adapter
// *is* the whole contract, and a subprocess would add a shell and a log to every
// assertion without testing more.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ciCommand } from '../src/commands/ci.ts';
import { configureCommand } from '../src/commands/configure.ts';
import { contractCommand } from '../src/commands/contracts.ts';
import { guardCommand } from '../src/commands/guard.ts';
import { secretsCommand } from '../src/commands/secrets.ts';
import { setupCommand } from '../src/commands/setup.ts';
import { EXIT } from '../src/shared/command.ts';

const quiet = async (body: () => number | Promise<number>): Promise<number> => {
  const original = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return await body();
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
};

/** What a command printed on stdout, without letting it reach the test log. */
const captureStdout = async (body: () => number | Promise<number>): Promise<string> => {
  const original = process.stdout.write;
  let printed = '';
  process.stdout.write = (chunk: string) => {
    printed += chunk;
    return true;
  };
  try {
    await body();
  } finally {
    process.stdout.write = original;
  }
  return printed;
};

const tempDirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'command-adapter-'));
  tempDirs.push(dir);
  return dir;
};

/** No Cloudflare credential, so `inspectConfig` reports something to report. */
const withoutCredential = async (body: () => number | Promise<number>): Promise<number> => {
  const saved = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  try {
    return await quiet(body);
  } finally {
    if (saved !== undefined) {
      process.env.CLOUDFLARE_API_TOKEN = saved;
    }
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ci ────────────────────────────────────────────────────────────────────────

describe('ci command', () => {
  test('rejects --out with no operand', async () => {
    // The positional filter's job is to drop the `--out` operand, so a missing one
    // left nothing to drop and the run wrote the default evidence file. To a
    // caller that says "the evidence file was written where I asked".
    const dir = tempDir();
    const input = join(dir, 'results.json');
    writeFileSync(input, '[]');

    const code = await quiet(() => ciCommand.run([input, '--out']));

    expect(code).toBe(EXIT.usage);
  });

  test('rejects an --out operand that is another flag', async () => {
    const dir = tempDir();
    const input = join(dir, 'results.json');
    writeFileSync(input, '[]');

    const code = await quiet(() => ciCommand.run([input, '--out', '--json']));

    expect(code).toBe(EXIT.usage);
    // A file named `--json` would otherwise have been created.
    expect(await Bun.file(join(dir, '--json')).exists()).toBe(false);
  });

  test('still writes to a valid --out path', async () => {
    const dir = tempDir();
    const input = join(dir, 'results.json');
    const output = join(dir, 'nested', 'evidence.md');
    writeFileSync(input, JSON.stringify([{ name: 'x', status: 'ok', detail: 'fine' }]));

    const code = await quiet(() => ciCommand.run([input, '--out', output]));

    expect(code).toBe(EXIT.ok);
    expect(await Bun.file(output).exists()).toBe(true);
    expect(await Bun.file(output).text()).toContain('x');
  });
});

// ── configure ─────────────────────────────────────────────────────────────────

describe('configure command', () => {
  test('an incomplete --check is unavailable, not failed', async () => {
    // "Unavailable" is the code that means "a prerequisite is missing here", which
    // is what an unprovisioned template is. Mapping it to `failed` made a fresh
    // clone look like a misconfigured one.
    const code = await withoutCredential(() => configureCommand.run(['--check']));
    expect(code).toBe(EXIT.unavailable);
  });

  test('an incomplete --dry-run is unavailable too', async () => {
    const code = await withoutCredential(() => configureCommand.run(['--dry-run']));
    expect(code).toBe(EXIT.unavailable);
  });

  test('a failed --provision is failed, not unavailable', async () => {
    // Provisioning was asked to create a resource and did not. `unavailable` is
    // the code a job reads as "not my fault, retry later", which is not what a
    // failed create is.
    const code = await withoutCredential(() => configureCommand.run(['--provision']));
    expect(code).toBe(EXIT.failed);
  });
});

// ── contract ──────────────────────────────────────────────────────────────────

describe('contract command', () => {
  test('the descriptor lists only the subcommands main handles', () => {
    // `list` and `cancel` were advertised and not implemented. `contract cancel`
    // did fall through to the usage error, so it refused — but the usage line
    // claimed otherwise.
    const usage = contractCommand.usage;
    expect(usage).toContain('new');
    expect(usage).toContain('run');
    expect(usage).toContain('status');
    expect(usage).not.toContain('list');
    expect(usage).not.toContain('cancel');
  });

  test('an unimplemented subcommand is a usage error', async () => {
    const code = await quiet(() => contractCommand.run(['cancel', 'run-anything']));
    expect(code).toBe(EXIT.usage);
  });
});

// ── guard ─────────────────────────────────────────────────────────────────────

describe('guard command', () => {
  test('an unknown flag is refused rather than running the default guards', async () => {
    // `guardsMain` reads the flags it knows and ignores the rest, so `--forse` ran
    // every guard and reported the result. A typo in a guard invocation then read
    // as "the guards ran", which is the one thing it must never imply.
    const code = await quiet(() => guardCommand.run(['--forse']));
    expect(code).toBe(EXIT.usage);
  });

  test('--only needs a guard id', async () => {
    const code = await quiet(() => guardCommand.run(['--only']));
    expect(code).toBe(EXIT.usage);
  });

  test('--only accepts a guard id as its operand, not as a flag', async () => {
    const code = await quiet(() => guardCommand.run(['--only', '--json']));
    expect(code).toBe(EXIT.usage);
  });

  test('a real --only operand runs that one guard', async () => {
    const code = await quiet(() => guardCommand.run(['--only', 'workspace-boundary']));
    expect(code).toBe(EXIT.ok);
  });

  test('--whole-repo is accepted and says the scope is already the default', async () => {
    // It used to be forwarded to `guardsMain`, which had no such mode and ignored
    // it, so the caller believed the scope had narrowed.
    const code = await quiet(() => guardCommand.run(['--whole-repo']));
    expect(code).toBe(EXIT.ok);
  });
});

// ── secrets ───────────────────────────────────────────────────────────────────

describe('secrets command', () => {
  test('every advertised operation refuses with the not-implemented code', async () => {
    // Each of these printed a report and exited 0. A script or a person read that
    // as "the recipients file was created" / "the file was encrypted".
    for (const operation of [
      'encrypt',
      'decrypt',
      'init',
      'doctor',
      'edit',
      'exec',
      'update-recipients',
    ]) {
      const code = await quiet(() => secretsCommand.run([operation]));
      expect(code).toBe(EXIT.unavailable);
    }
  });

  test('no operation at all is a usage error', async () => {
    const code = await quiet(() => secretsCommand.run([]));
    expect(code).toBe(EXIT.usage);
  });

  test('--help marks what is not implemented', async () => {
    const printed = await captureStdout(() => secretsCommand.run(['--help']));
    expect(printed).toContain('NOT IMPLEMENTED');
    expect(printed).toContain('encrypt');
  });
});

// ── setup ─────────────────────────────────────────────────────────────────────

describe('setup command', () => {
  test('rejects an unknown flag', async () => {
    const code = await quiet(() => setupCommand.run(['--forse']));
    expect(code).toBe(EXIT.usage);
  });

  test('--help documents the flags it forwards', async () => {
    const printed = await captureStdout(() => setupCommand.run(['--help']));
    expect(printed).toContain('--force');
    expect(printed).toContain('--quiet');
  });
});
