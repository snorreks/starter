import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeCsp, resolveApiOrigin } from '@starter/schemas/native';
import { REPO_ROOT } from '../shared/paths.ts';
import { NATIVE_DIR } from './platform.ts';

/** One origin and policy for both Tauri and its frontend hook. */
export const nativeConfiguration = (
  mode: 'dev' | 'build',
  env: NodeJS.ProcessEnv = process.env,
  root = REPO_ROOT,
): { config: string; env: NodeJS.ProcessEnv } => {
  const apiOrigin = resolveApiOrigin({ raw: env.VITE_NATIVE_API_ORIGIN, dev: mode === 'dev' });
  const base = JSON.parse(
    readFileSync(join(root, NATIVE_DIR, 'src-tauri/tauri.conf.json'), 'utf8'),
  ) as { app: { security: { csp: string } } };
  const csp = nativeCsp(base.app.security.csp, apiOrigin);
  const config = JSON.stringify({ app: { security: { csp, devCsp: csp } } });
  return {
    config,
    env: { ...env, VITE_NATIVE_API_ORIGIN: apiOrigin, TAURI_CONFIG: config },
  };
};
