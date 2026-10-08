// apps/backend/jobs/scripts/build.ts
//
// The Worker bundle `wrangler deploy` would ship.
//
// Why Bun's bundler rather than Wrangler's or Vite's
// ---------------------------------------------------
// Wrangler's `deploy --dry-run --outdir` bundles too, but it also resolves the whole
// configuration — including the Postgres id and the container image — and this Worker is
// deliberately not configured in a fresh checkout. A build that fails because a
// resource id is absent is a build that cannot be run before a deploy, which is
// backwards.
//
// Bun is this repository's pinned toolchain (`config/toolchain.json`), so the
// bundler is the same one that installs the dependencies, and the output is the same
// module format workerd loads. There is no second bundler to configure.
//
// `cloudflare:workers` is external, and has to be
// -----------------------------------------------
// That module is provided by the runtime and does not exist in any registry. Bun
// therefore cannot resolve it as a bare specifier, and the alternative — shimming it
// — would put a fake `WorkflowEntrypoint` into the shipped bundle, which is the
// worst of the three outcomes: it would build, and it would not work.

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(APP_DIR, 'dist');

// A stale artifact is worse than none, so the directory is emptied *before* the
// build rather than after it: a build that emits nothing must not leave the previous
// build's Worker sitting in `dist/` looking current.
await rm(OUT_DIR, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(APP_DIR, 'src/index.ts')],
  outdir: OUT_DIR,
  target: 'browser',
  format: 'esm',
  external: ['cloudflare:workers'],
  minify: false,
  // Source maps so a stack trace from a deployed instance points at a line rather
  // than at a column of generated code. They are published with the source, never
  // fetched by a browser.
  sourcemap: 'linked',
});

if (!result.success) {
  for (const log of result.logs) {
    process.stderr.write(`${log}\n`);
  }
  process.exit(1);
}

const output = result.outputs[0];
if (output === undefined) {
  process.stderr.write('The bundler reported success but produced no output.\n');
  process.exit(1);
}

process.stdout.write(`built apps/backend/jobs/dist/index.js from ${output.kind}\n`);
