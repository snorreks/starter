import { spawnSync } from 'bun';

const supabase = process.env.STARTER_BACKEND_PROFILE === 'supabase';
const file = supabase ? 'tests/worker_integration.test.ts' : 'tests/worker_integration.test.ts';
const args = ['test', file];
if (supabase) {
  args.push('--test-name-pattern=Supabase preview');
}
const result = spawnSync([process.execPath, ...args], { cwd: process.cwd(), stdout: 'inherit', stderr: 'inherit' });
if (result.exitCode !== 0) {
  process.exitCode = result.exitCode ?? 1;
}
