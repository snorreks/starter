import { execFileSync } from 'node:child_process';
import { publicToolEnvironment } from '../shared/private_environment.ts';
import { runBounded } from '../shared/run_bounded.ts';
import { resolveWorkspaceBin } from '../shared/tools.ts';

const MAX_BYTES = 16 * 1024 * 1024;

export const runPreCommit = async (cwd = process.cwd()): Promise<number> => {
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: MAX_BYTES });
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const paths = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRD'])
    .split('\0')
    .filter(Boolean);
  const present = new Set(
    git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
      .split('\0')
      .filter(Boolean),
  );
  if (paths.length === 0) {
    process.stdout.write(
      'No staged paths; pre-commit checks are not applicable to an empty commit.\n',
    );
    return 0;
  }
  const env = publicToolEnvironment(process.env);
  const run = async (
    command: string,
    args: string[],
    input?: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    const result = await runBounded({
      command,
      args,
      cwd: root,
      env,
      input,
      maxBytes: MAX_BYTES,
      timeoutMs: 10 * 60_000,
      onOutput:
        input === undefined
          ? (stream, chunk) => (stream === 'stdout' ? process.stdout : process.stderr).write(chunk)
          : undefined,
    });
    if (input !== undefined) {
      return result;
    }
    if (result.code !== 0) {
      process.stderr.write(`Pre-commit failed: ${args.join(' ')} (exit ${result.code}).\n`);
    }
    return result;
  };
  // Inspect secret-shaped paths from the index before passing any blobs to tools.
  for (const path of present) {
    if (
      /(?:^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/.test(path) &&
      !path.endsWith('.example')
    ) {
      throw new Error(
        `Plaintext environment staged: ${path}. Keep real values gitignored; use bun run secrets:encrypt.`,
      );
    }
    if (/^secrets\/.*\.enc\.env$/.test(path)) {
      const lines = git(['show', `:${path}`])
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.startsWith('#'));
      if (
        !lines.some((line) => /^sops_mac=ENC\[/.test(line)) ||
        lines.some((line) => !/^sops_[^=]+=/.test(line) && !/^[^=]+=ENC\[.*\]$/.test(line))
      ) {
        throw new Error(
          `Plaintext or malformed SOPS envelope staged: ${path}. Encrypt before staging; values were not printed.`,
        );
      }
    }
  }
  const biome = resolveWorkspaceBin('biome', [], root);
  if (biome === null) {
    throw new Error(
      `Cannot check staged paths (${paths.join(', ')}): pinned Biome is missing. Run bun install --frozen-lockfile.`,
    );
  }
  // stdin checks the index blob, never the working copy. No fix or git add may
  // widen a partial commit, even when a formatter reports a failure.
  for (const path of paths) {
    if (
      !present.has(path) ||
      !/\.(?:[cm]?[jt]sx?|jsonc?|css|svelte|vue|astro|html|graphql|gql)$/.test(path)
    ) {
      continue;
    }
    const blob = git(['show', `:${path}`]);
    process.stdout.write(`Checking staged ${path}\n`);
    const checked = await run(
      biome,
      ['check', '--write', '--error-on-warnings', `--stdin-file-path=${path}`],
      blob,
    );
    if (checked.code !== 0 || checked.stdout !== blob) {
      process.stderr.write(checked.stderr);
      process.stderr.write(
        `Staged ${path} has lint or formatting changes. Run bun run fix, then stage the intended hunks. The hook did not change your files.\n`,
      );
      return checked.code || 1;
    }
  }
  const guard = await run('bun', ['run', 'scripts/src/cli.ts', 'guard']);
  if (guard.code !== 0) {
    return guard.code;
  }
  const moon = resolveWorkspaceBin('moon', [], root);
  if (moon === null) {
    throw new Error('Pinned Moon is missing. Run bun install --frozen-lockfile.');
  }
  // Shared configuration is outside the affected project graph. Validate every
  // project when it changes; otherwise include transitive consumers explicitly.
  const broad = paths.some(
    (path) => !path.includes('/') || /^(?:config|\.moon|\.github)\//.test(path),
  );
  const args = ['run', ':typecheck', '--cache', 'off', '--concurrency', '4'];
  if (!broad) {
    args.push('--affected', '--status=staged', '--downstream', 'deep', '--upstream', 'deep');
  }
  process.stdout.write(
    `Pre-commit: ${broad ? 'all' : 'affected'} project typechecks (working tree).\n`,
  );
  return (await run(moon, args)).code;
};

if (import.meta.main) {
  try {
    process.exitCode = await runPreCommit();
  } catch (error) {
    process.stderr.write(
      `Pre-commit blocked: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
