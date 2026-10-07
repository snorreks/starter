import { runBounded } from '../shared/run_bounded.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';

const USAGE = `e2e <doctor|full|audit>

doctor launches the resolved Chromium and verifies the Node, Lighthouse and Docker prerequisites.
full owns a built web/jobs Worker graph and a fingerprinted local FFmpeg container.
audit runs three serialized Lighthouse samples for each manifest-selected public scenario/viewport.`;

const runPackage = async (task: string, timeoutMs: number): Promise<number> => {
  const result = await runBounded({
    command: 'bun',
    args: ['run', '--cwd', 'apps/e2e', task],
    cwd: REPO_ROOT,
    timeoutMs,
    maxBytes: 16 * 1024 * 1024,
    stdio: 'inherit',
  });
  return result.code;
};

const doctor = async (): Promise<number> => {
  const node = await runBounded({ command: 'node', args: ['--version'], cwd: REPO_ROOT, timeoutMs: 5_000, maxBytes: 8_000 });
  const version = node.stdout.trim().replace(/^v/, '').split('.').map(Number);
  if (node.code !== 0 || version.length < 3 || version[0]! < 22 || (version[0] === 22 && version[1]! < 19)) {
    return fail(`E2E audit requires Node.js >=22.19 for the pinned Lighthouse ${node.stdout.trim() || 'runtime unavailable'}. Install the repository-pinned Node with nix develop, then rerun bun run e2e:doctor.`, EXIT.unavailable);
  }
  process.stdout.write(`Node ${node.stdout.trim()} is available for Lighthouse.\n`);

  const browserCode = await runPackage('doctor:browser', 45_000);
  if (browserCode !== 0) return fail('Chromium could not complete its launch probe. Run `bun run setup` (or `nix develop` for the linked Chromium), then rerun `bun run e2e:doctor`.', EXIT.unavailable);

  const docker = await runBounded({ command: process.env.DOCKER ?? 'docker', args: ['info'], cwd: REPO_ROOT, timeoutMs: 15_000, maxBytes: 512_000 });
  if (docker.code !== 0) return fail(`A Docker-compatible engine is required by e2e:full. ${docker.stderr.slice(-1000)}\nStart Docker or Podman and rerun bun run e2e:doctor.`, EXIT.unavailable);
  process.stdout.write('Docker-compatible engine is responding; the full real-media lane is available.\n');
  process.stdout.write('Doctor passed. Run `bun run e2e:full` for the Docker lane or `bun run e2e:audit` for Lighthouse.\n');
  return EXIT.ok;
};

export const e2eCommand: Command = {
  name: 'e2e',
  summary: 'run owned full media integration, Lighthouse audits, or prerequisite checks',
  usage: USAGE,
  async run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }
    const [operation, ...rest] = argv;
    if (rest.length > 0) return fail(`Unexpected e2e arguments: ${rest.join(' ')}\n\n${USAGE}`, EXIT.usage);
    if (operation === 'doctor') return doctor();
    if (operation === 'full') return runPackage('test:full', 35 * 60_000);
    if (operation === 'audit') return runPackage('test:audit', 60 * 60_000);
    return fail(`Unknown e2e operation ${JSON.stringify(operation)}.\n\n${USAGE}`, EXIT.usage);
  },
};
