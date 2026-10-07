import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateReviewResult, type ReviewResult } from './schemas.ts';

export const reviewCacheKey = (inputs: Record<string, unknown>): string =>
  createHash('sha256').update(JSON.stringify(inputs)).digest('hex');

export const readReviewCache = async (
  path: string,
  requirementIds: readonly string[],
): Promise<ReviewResult | null> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new Error(`Could not read visual review cache ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateReviewResult(parsed, requirementIds);
};

export const writeReviewCache = async (path: string, review: ReviewResult): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(review, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
};
