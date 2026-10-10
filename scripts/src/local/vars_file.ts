// scripts/src/local/vars_file.ts
//
// The run-owned environment file: one per run, mode 0600, removed on teardown.
//
// Every local service contributes bindings to it — Supabase its project URL and
// keys, Stripe its API base and webhook secret, the jobs Worker its profile. The
// application reads them from one place rather than from a mix of the
// environment, argv and per-service files, because a binding whose source differs
// per service is a binding nobody can find.
//
// **Why a file rather than the environment.** The service-role key of a local
// stack, and any Stripe key, are credentials. This repository's rule is that a
// secret value never reaches argv, a log line or an artifact. `wrangler dev`
// takes `--env-file`; the Vite platform proxy takes `STARTER_RUNTIME_ENV_FILE`.
// Either way the values reach the Worker through its bindings without appearing
// in a command line or in the environment of the process that serves them.
//
// **Why `wx` and the 0600 mode.** `wx` refuses to overwrite, so two runs that
// somehow agree on a path cannot silently destroy each other's credentials; the
// mode is set at creation rather than chmod-ed afterwards, so the file is never
// briefly world-readable.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Write a run-owned vars file.
 *
 * Values are JSON-encoded so a value containing a space, a quote or a `#` cannot
 * change the shape of the file. A hand-rolled `KEY=value` join is how a URL with
 * a query string turns the rest of the file into one variable's value.
 */
export const writeOwnedVars = async (
  root: string,
  name: string,
  values: Record<string, string>,
): Promise<{ path: string; contents: string }> => {
  await mkdir(root, { recursive: true });
  const path = join(root, name);
  const contents = `${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n')}\n`;
  await writeFile(path, contents, { mode: 0o600, flag: 'wx' });
  return { path, contents };
};

/**
 * Remove a run-owned vars file, preserving it if something else changed it.
 *
 * The contents check is what stops a teardown from deleting a file a *different*
 * run has since taken ownership of. Removing the wrong run's credentials is
 * worse than leaving a stale file behind, and a stale file is visible.
 */
export const removeOwnedVars = async (path: string, contents: string): Promise<void> => {
  try {
    const current = await readFile(path, 'utf8');
    if (current !== contents) {
      throw new Error('The owned run env file changed before teardown; preserving it.');
    }
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
};
