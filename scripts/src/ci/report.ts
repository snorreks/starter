// scripts/src/ci/report.ts
//
// Renders a check result as a GitHub step summary.
//
// Deliberately small. The source project's CI reporter was ~25 KB of log
// parsing across three log formats. This one takes a result and prints it, and
// the caller decides what the exit code means.

export interface CheckResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'blocked';
  detail?: string;
  evidence?: string;
}

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
