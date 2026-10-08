import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';
import { readReviewCache, reviewCacheKey, writeReviewCache } from './cache.ts';
import { loadVisionConfig } from './config.ts';
import { gradeReview } from './grade.ts';
import { prepareReviewImage } from './images.ts';
import { REVIEW_PROMPT_VERSION, reviewPrompt } from './prompt.ts';
import { requestStructuredVision } from './providers/structured_vision.ts';
import type { ReviewResult } from './schemas.ts';

interface CaptureRecord {
  scenarioId: string;
  captureKind?: 'interactive' | 'declared-scenario';
  app: string;
  state: string;
  project: string;
  url: string;
  file: string;
  sha256: string;
  requirements: string[];
  expected: { controls: string[]; content: string[] };
  heading: string;
  status: string;
  originalSha256?: string;
  crop?: { x: number; y: number; width: number; height: number } | null;
}

const htmlEscape = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const digest = async (file: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ReviewOperationResult {
  runId: string;
  status: 'passed' | 'failed' | 'needs-human-review';
  reviewed: number;
  cached: number;
  report: string;
}

export const reviewCaptureManifest = async (options: {
  manifestPath: string;
  gate?: boolean;
  noCache?: boolean;
  config?: ReturnType<typeof loadVisionConfig>;
}): Promise<ReviewOperationResult> => {
  const manifestPath = resolve(REPO_ROOT, options.manifestPath);
  const runData: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isRecord(runData) || runData.schemaVersion !== 1 || !Array.isArray(runData.records)) {
    throw new Error(`Invalid visual capture manifest: ${manifestPath}`);
  }
  if (
    runData.status !== 'passed' ||
    runData.expectedCaptures !== runData.records.length ||
    !Array.isArray(runData.expectedCaptureKeys) ||
    runData.expectedCaptureKeys.length !== runData.expectedCaptures ||
    !Array.isArray(runData.coverageGaps) ||
    runData.coverageGaps.some((gap) => typeof gap !== 'string' || gap.trim() === '')
  ) {
    throw new Error(
      `Capture manifest is incomplete or failed: ${manifestPath}. Recapture the full matrix first.`,
    );
  }
  if (typeof runData.runId !== 'string' || runData.runId.length === 0) {
    throw new Error('Capture manifest omitted runId.');
  }
  const config = options.config ?? loadVisionConfig();
  const records = runData.records as CaptureRecord[];
  const expectedKeys = runData.expectedCaptureKeys as string[];
  const actualKeys = records.map((record) => `${record.scenarioId}::${record.project}`);
  if (
    new Set(expectedKeys).size !== expectedKeys.length ||
    new Set(actualKeys).size !== actualKeys.length ||
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key) => !actualKeys.includes(key))
  ) {
    throw new Error(
      `Capture manifest does not match its declared scenario/project matrix: ${manifestPath}. Recapture the full matrix first.`,
    );
  }
  if (records.length === 0) {
    throw new Error('Capture manifest contains zero screenshots.');
  }
  const results: Array<Record<string, unknown>> = [];
  let cached = 0;
  let anyFailed = false;
  let humanReview = false;
  let usedCalls = 0;
  const cacheRoot = join(REPO_ROOT, '.wrangler', 'visual-cache');
  for (const record of records) {
    if (
      typeof record.file !== 'string' ||
      typeof record.sha256 !== 'string' ||
      typeof record.scenarioId !== 'string'
    ) {
      throw new Error('Capture record is missing its image, hash or scenario identity.');
    }
    if (!Array.isArray(record.requirements) || record.requirements.length === 0) {
      throw new Error(`Capture ${record.scenarioId} has no visual requirements.`);
    }
    const imagePath = isAbsolute(record.file) ? record.file : resolve(REPO_ROOT, record.file);
    if ((await digest(imagePath)) !== record.sha256) {
      throw new Error(`Capture hash mismatch: ${imagePath}`);
    }
    const image = await prepareReviewImage(imagePath);
    const prompt = reviewPrompt({
      scenarioId: record.scenarioId,
      app: record.app,
      state: record.state,
      viewportTheme: record.project,
      heading: record.heading,
      controls: record.expected.controls,
      requirements: record.requirements,
      content: record.expected.content,
    });
    const key = reviewCacheKey({
      sha256: image.originalSha256,
      sentSha256: image.sha256,
      referenceSha256: null,
      prompt: REVIEW_PROMPT_VERSION,
      promptSha256: createHash('sha256').update(prompt).digest('hex'),
      schema: 1,
      requirements: record.requirements,
      provider: config.provider,
      endpoint: config.baseUrl,
      model: config.model,
      options: { maxOutputTokens: config.maxOutputTokens, preparation: image.preparation },
    });
    const cachePath = join(cacheRoot, `${key}.json`);
    let review: ReviewResult | null = options.noCache
      ? null
      : await readReviewCache(cachePath, record.requirements);
    let provenance: 'fresh' | 'cached' = 'fresh';
    let usage: unknown = null;
    if (review !== null) {
      cached += 1;
      provenance = 'cached';
    } else {
      if (usedCalls >= config.maxCalls) {
        throw new Error(`Visual review reached E2E_VISION_MAX_CALLS=${config.maxCalls}.`);
      }
      const response = await requestStructuredVision({
        config,
        image,
        prompt,
        requirementIds: record.requirements,
        callBudget: config.maxCalls - usedCalls,
      });
      usedCalls += response.usage.calls;
      if (usedCalls > config.maxCalls) {
        throw new Error(`Provider retries exceeded E2E_VISION_MAX_CALLS=${config.maxCalls}.`);
      }
      review = response.review;
      usage = response.usage;
      await writeReviewCache(cachePath, review);
    }
    const grade = gradeReview(review, { requirementIds: record.requirements });
    anyFailed ||= grade.status === 'failed';
    humanReview ||= grade.status === 'needs-human-review';
    results.push({
      runId: runData.runId,
      scenarioId: record.scenarioId,
      captureKind: record.captureKind ?? 'declared-scenario',
      app: record.app,
      state: record.state,
      project: record.project,
      url: record.url,
      image: imagePath,
      originalSha256: image.originalSha256,
      crop: record.crop ?? null,
      derivativePath: image.derivativePath,
      dimensions: image.dimensions,
      preparation: image.preparation,
      promptVersion: REVIEW_PROMPT_VERSION,
      provider: config.provider,
      endpoint: config.baseUrl,
      model: config.model,
      review,
      grade,
      usage,
      provenance,
    });
  }
  let status: ReviewOperationResult['status'] = 'passed';
  if (humanReview) {
    status = 'needs-human-review';
  }
  if (anyFailed) {
    status = 'failed';
  }
  const output = dirname(manifestPath);
  const report = join(output, 'review.json');
  const reviewFile = `${report}.${crypto.randomUUID()}.tmp`;
  await writeFile(
    reviewFile,
    `${JSON.stringify({ schemaVersion: 1, runId: runData.runId, status, reviewed: results.length, cached, coverageGaps: runData.coverageGaps, results }, null, 2)}\n`,
    { flag: 'wx' },
  );
  await rename(reviewFile, report);
  const rows = results
    .map((item) => {
      const grade = item.grade as { status: string; score: number | null };
      return `<li>${htmlEscape(String(item.scenarioId))} / ${htmlEscape(String(item.project))}: ${grade.score ?? 'unscored'} (${grade.status})</li>`;
    })
    .join('\n');
  const htmlReport = join(output, 'review.html');
  const htmlTemporary = `${htmlReport}.${crypto.randomUUID()}.tmp`;
  await writeFile(
    htmlTemporary,
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Visual review ${htmlEscape(String(runData.runId))}</title><main><h1>Visual review</h1><p>${status}; ${results.length} screenshots, ${cached} cached.</p><h2>Declared gaps</h2><ul>${(runData.coverageGaps as string[]).map((gap) => `<li>${htmlEscape(gap)}</li>`).join('\n')}</ul><ul>${rows}</ul></main></html>\n`,
    { flag: 'wx' },
  );
  await rename(htmlTemporary, htmlReport);
  if (options.gate && status !== 'passed') {
    throw new Error(`Visual review gate failed with status ${status}. Report: ${report}`);
  }
  return { runId: runData.runId, status, reviewed: results.length, cached, report };
};
