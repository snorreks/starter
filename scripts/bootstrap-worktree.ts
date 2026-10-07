import { spawnSync } from 'node:child_process';
import { publicToolEnvironment } from './src/shared/private_environment.ts';

// This entrypoint intentionally imports no workspace package: a new worktree has
// no node_modules yet, so dependency installation must be the first executable step.
const env = publicToolEnvironment(process.env);
const args = process.argv.slice(2);
const install = spawnSync('bun', ['install', '--frozen-lockfile'], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
});

if (install.error !== undefined) {
  process.stderr.write(`Could not start the pinned Bun install: ${install.error.message}\n`);
  process.exit(127);
}
if (install.status !== 0) {
  process.stderr.write(`Frozen workspace install failed with exit ${install.status ?? 1}.\n`);
  process.exit(install.status ?? 1);
}

const setup = spawnSync('bun', ['run', 'scripts/src/cli.ts', 'worktree', 'bootstrap', ...args], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
});
if (setup.error !== undefined) {
  process.stderr.write(`Could not start worktree setup: ${setup.error.message}\n`);
  process.exit(127);
}
process.exit(setup.status ?? 1);
