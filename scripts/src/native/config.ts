import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeCsp, resolveApiOrigin } from '@starter/schemas/native';
import { REPO_ROOT } from '../shared/paths.ts';
import { NATIVE_DIR } from './platform.ts';

// Values the pinned Tauri CLI refuses as its own boolean flags.
//
// tauri-cli 2.12.1 reads `CI` out of the environment and hands the value to its
// `--ci` flag, which is a boolean. `CI=true` and an absent `CI` both work; the
// other spellings developers and container images actually use — `CI=1`, `CI=yes`
// — stop the build before anything is compiled:
//
//     error: invalid value '1' for '--ci'
//       [possible values: true, false]
//
// The environment is the developer's, not this repository's, so the fix is to hand
// the CLI a value it can parse rather than to refuse a build because somebody
// exported a variable. `native dev`, `build`, `android` and `ios` all inherit this,
// because they all spawn the same binary with this environment.
const FALSY_CI = new Set(['', '0', 'false', 'no', 'off']);

/** The `CI` the pinned CLI can parse, from whatever the shell exported. */
export const normalizeCi = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const value = env.CI;
  if (value === undefined) {
    // Absent stays absent: the CLI's own default is not this function's to change.
    return env;
  }
  const { CI: _ignored, ...rest } = env;
  return { ...rest, CI: FALSY_CI.has(value.trim().toLowerCase()) ? 'false' : 'true' };
};

// One origin and policy for both Tauri and its frontend hook.
//
// `devHost` is the address a *phone* should use to reach the development API.
// It is a parameter rather than an environment read because `dev` is derived from
// the subcommand: a packaged build must be refused a LAN address, and that
// refusal has to be impossible to flip by exporting a variable.
export const nativeConfiguration = (
  mode: 'dev' | 'build',
  env: NodeJS.ProcessEnv = process.env,
  root = REPO_ROOT,
  devHost?: string,
): { config: string; env: NodeJS.ProcessEnv } => {
  const apiOrigin = resolveApiOrigin({
    raw: env.VITE_NATIVE_API_ORIGIN,
    dev: mode === 'dev',
    devHost,
  });
  const base = JSON.parse(
    readFileSync(join(root, NATIVE_DIR, 'src-tauri/tauri.conf.json'), 'utf8'),
  ) as { app: { security: { csp: string } } };
  const csp = nativeCsp(base.app.security.csp, apiOrigin);
  const config = JSON.stringify({ app: { security: { csp, devCsp: csp } } });
  return {
    config,
    env: normalizeCi({ ...env, VITE_NATIVE_API_ORIGIN: apiOrigin, TAURI_CONFIG: config }),
  };
};
