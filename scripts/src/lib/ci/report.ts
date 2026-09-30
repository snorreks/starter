// scripts/src/lib/ci/report.ts
//
// Renders a check result as a GitHub step summary.
//
// Deliberately small. The source project's CI reporter was ~25 KB of log
// parsing across three log formats. This one takes a result and prints it, and
// the caller decides what the exit code means.

export type CheckResult = {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'blocked';
  detail?: string;
  evidence?: string;
};

const ICON = { passed: '✅', failed: '❌', skipped: '⏭️', blocked: '🚫' } as const;

export const renderSummary = (results: readonly CheckResult[]): string => {
  const lines = ['## Verification', ''];

  for (const result of results) {
    lines.push(`${ICON[result.status]} **${result.name}** — ${result.status}`);
    if (result.detail) {
      lines.push(`   ${result.detail}`);
    }
    if (result.evidence) {
      lines.push(`   evidence: ${result.evidence}`);
    }
  }

  const failed = results.filter((result) => result.status === 'failed').length;
  const blocked = results.filter((result) => result.status === 'blocked').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;

  lines.push('');
  lines.push(
    failed === 0 && blocked === 0
      ? `All ${results.length - skipped} executed checks passed (${skipped} skipped).`
      : `${failed} failed, ${blocked} blocked, ${skipped} skipped. A blocked or skipped check is not a pass.`,
  );

  return lines.join('\n');
};

if (import.meta.main) {
  // No CI annotation plumbing: the workflow reads a JSON file this produces.
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { REPO_ROOT } = await import('../guards/boundary.ts');

  const input = process.argv[2];
  if (input === undefined) {
    process.stderr.write('Usage: bun run ci <results.json>\n');
    process.exitCode = 2;
  } else {
    const results = JSON.parse(readFileSync(input, 'utf8')) as CheckResult[];
    const summary = renderSummary(results);

    mkdirSync(join(REPO_ROOT, '.evidence'), { recursive: true });
    writeFileSync(join(REPO_ROOT, '.evidence/verification.md'), `${summary}\n`);

    const { GITHUB_STEP_SUMMARY } = process.env;
    if (GITHUB_STEP_SUMMARY !== undefined && GITHUB_STEP_SUMMARY !== '') {
      writeFileSync(GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: 'a' });
    }
    process.stdout.write(`${summary}\n`);
  }
}
