import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FullResult, Reporter } from '@playwright/test/reporter';
import { evidenceDir, TEST_RUN_ID } from '../../preflight.ts';
import { expectedCaptureKeys, readScenarioManifest } from '../scenarios/manifest.ts';

const readRecords = async (directory: string): Promise<Record<string, unknown>[]> => {
  const records: Record<string, unknown>[] = [];
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return records;
  }
  for (const file of files.filter((name) => name.endsWith('.png.json'))) {
    const value: unknown = JSON.parse(await readFile(join(directory, file), 'utf8'));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      records.push(value as Record<string, unknown>);
    }
  }
  return records;
};

const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const atomicWrite = async (path: string, contents: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { flag: 'wx' });
  await rename(temporary, path);
};

export default class VisualReporter implements Reporter {
  private runId = TEST_RUN_ID;
  private output = evidenceDir();

  onBegin(config: import('@playwright/test/reporter').FullConfig): void {
    const metadata = config.metadata as Record<string, unknown>;
    if (typeof metadata.e2eRunId === 'string') this.runId = metadata.e2eRunId;
    if (typeof metadata.e2eEvidenceDir === 'string') this.output = metadata.e2eEvidenceDir;
  }

  async onEnd(result: FullResult): Promise<void> {
    const captureRoot = join(this.output, 'captures', this.runId);
    const records = await readRecords(captureRoot);
    const manifest = readScenarioManifest();
    const keys = expectedCaptureKeys(manifest);
    const recordKeys = records.map((record) => `${String(record.scenarioId)}::${String(record.project)}`);
    const complete = recordKeys.length === keys.length && new Set(recordKeys).size === keys.length &&
      keys.every((key) => recordKeys.includes(key)) && result.status === 'passed';
    const run = {
      schemaVersion: 1,
      runId: this.runId,
      operation: 'visual-capture',
      status: complete ? 'passed' : 'failed',
      expectedCaptures: keys.length,
      expectedCaptureKeys: keys,
      coverageGaps: manifest.coverageGaps,
      completedCaptures: records.length,
      visualReview: 'not-run',
      provenance: 'fresh',
      records,
      playwrightStatus: result.status,
    };
    const output = this.output;
    await atomicWrite(join(output, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    const rows = records
      .map((record) => `<li><strong>${escapeHtml(String(record.scenarioId))}</strong> (${escapeHtml(String(record.project))}) — ${escapeHtml(String(record.status))}</li>`)
      .join('\n');
    await atomicWrite(
      join(output, 'index.html'),
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Visual E2E ${escapeHtml(this.runId)}</title><main><h1>Visual E2E ${escapeHtml(this.runId)}</h1><p>Status: ${run.status}. Captures: ${records.length}/${keys.length}. AI review: NOT RUN.</p><h2>Declared gaps</h2><ul>${manifest.coverageGaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join('\n')}</ul><h2>Captures</h2><ul>${rows}</ul></main></html>\n`,
    );
    if (!complete) process.exitCode = 1;
    process.stdout.write(`Visual capture manifest: ${join(output, 'run.json')} (${records.length}/${keys.length}, AI NOT RUN)\n`);
  }
}
