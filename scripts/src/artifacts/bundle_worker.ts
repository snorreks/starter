import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { buildEnvironment } from '../shared/build_environment.ts';
import { CLIENT_DIR_RELATIVE, REPO_ROOT } from '../shared/paths.ts';
import { runBounded } from '../shared/run_bounded.ts';
import { missingToolMessage, wranglerBin } from '../shared/tools.ts';

const record = (input: unknown): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Invalid Wrangler bundle metadata object.');
  }
  return input as Record<string, unknown>;
};

const assertPlatformImports = (output: unknown): void => {
  const imports = record(output).imports;
  if (!Array.isArray(imports)) {
    throw new Error('Invalid Wrangler output imports.');
  }
  const entries: unknown[] = imports;
  for (const entry of entries) {
    const imported = record(entry);
    if (typeof imported.path !== 'string' || !/^(node:|cloudflare:)/.test(imported.path)) {
      throw new Error(
        `Worker bundle still imports a non-platform module: ${String(imported.path).slice(0, 200)}`,
      );
    }
  }
};

const assertClosedOutputs = (options: {
  metadata: unknown;
  client: string;
  stage: string;
}): void => {
  const outputs = record(record(options.metadata).outputs);
  if (
    !Object.keys(outputs).some(
      (path) => resolve(options.client, path) === join(options.stage, '_worker.js'),
    )
  ) {
    throw new Error('Wrangler metadata does not describe the staged Worker.');
  }
  for (const output of Object.values(outputs)) {
    assertPlatformImports(output);
  }
};

/** Close the adapter's transitive SSR graph before it is cached, hashed or deployed. */
export const bundleWorker = async (
  options: { root?: string; run?: typeof runBounded } = {},
): Promise<number> => {
  const client = join(options.root ?? REPO_ROOT, CLIENT_DIR_RELATIVE);
  const artifact = join(client, '.svelte-kit/cloudflare');
  const bin = wranglerBin();
  if (bin === null) {
    process.stderr.write(`${missingToolMessage('wrangler', 'apps/frontend/client')}\n`);
    return 3;
  }
  if (!existsSync(join(artifact, '_worker.js'))) {
    process.stderr.write('Missing adapter Worker entry; run Vite build first.\n');
    return 1;
  }
  const stage = mkdtempSync(join(client, '.svelte-kit/bundle-'));
  try {
    const result = await (options.run ?? runBounded)({
      command: bin,
      args: [
        'deploy',
        '--dry-run',
        '--config',
        join(client, 'wrangler.jsonc'),
        '--outdir',
        stage,
        '--metafile',
      ],
      cwd: client,
      timeoutMs: 180_000,
      env: buildEnvironment(),
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.code !== 0) {
      return result.code;
    }
    const metadata: unknown = JSON.parse(readFileSync(join(stage, 'bundle-meta.json'), 'utf8'));
    assertClosedOutputs({ metadata, client, stage });
    const files = readdirSync(stage);
    const worker = join(stage, '_worker.js');
    if (!files.includes('_worker.js') || readFileSync(worker).byteLength === 0) {
      throw new Error('Wrangler emitted no nonempty standalone _worker.js.');
    }
    for (const file of files) {
      if (file !== 'bundle-meta.json') {
        copyFileSync(join(stage, file), join(artifact, file));
      }
    }
    const ignorePath = join(artifact, '.assetsignore');
    const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
    // Source maps may be uploaded for private error reporting, never as assets.
    writeFileSync(ignorePath, `${ignore.trimEnd()}\n_worker.js\n**/*.map\n`);
    process.stdout.write('Worker artifact is standalone: only platform module imports remain.\n');
    return 0;
  } catch (error) {
    process.stderr.write(
      `Cannot close Worker artifact: ${error instanceof Error ? error.message : 'invalid artifact'}\n`,
    );
    return 1;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  process.exitCode = await bundleWorker();
}
