import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseDotenv } from '../shared/dotenv.ts';

const REVIEW_KEYS = new Set([
  'E2E_VISION_PROVIDER',
  'E2E_VISION_MODEL',
  'E2E_VISION_BASE_URL',
  'E2E_VISION_API_KEY',
  'E2E_VISION_TIMEOUT_MS',
  'E2E_VISION_MAX_CALLS',
  'E2E_VISION_MAX_OUTPUT_TOKENS',
  'E2E_VISION_CONCURRENCY',
  'OPENROUTER_API_KEY',
]);

export const importTrustedReviewSettings = (root: string, sourcePath: string): string[] => {
  if (!isAbsolute(sourcePath)) {
    throw new Error('--from needs an absolute trusted dotenv path.');
  }
  if (!existsSync(sourcePath)) {
    throw new Error(`Trusted settings file does not exist: ${sourcePath}`);
  }
  const values = parseDotenv(readFileSync(sourcePath, 'utf8'), 'trusted settings file');
  const selected = Object.fromEntries(
    Object.entries(values).filter(([key]) => REVIEW_KEYS.has(key)),
  );
  const unsupported = Object.keys(values).filter((key) => !REVIEW_KEYS.has(key));
  if (unsupported.length > 0) {
    throw new Error(`Trusted settings file contains unsupported names: ${unsupported.join(', ')}.`);
  }
  if (Object.keys(selected).length === 0) {
    return [];
  }
  const destination = join(root, '.env.e2e');
  if (existsSync(destination)) {
    throw new Error('.env.e2e already exists; refusing to replace worktree configuration.');
  }
  const body = `${Object.entries(selected)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n')}\n`;
  writeFileSync(destination, body, { flag: 'wx', mode: 0o600 });
  chmodSync(destination, 0o600);
  return Object.keys(selected);
};
