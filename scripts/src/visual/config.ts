import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';

export interface VisionConfig {
  provider: 'openrouter';
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxCalls: number;
  maxOutputTokens: number;
  concurrency: number;
}

const readEnvFile = (): Record<string, string> => {
  const path = join(REPO_ROOT, '.env.e2e');
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (match === null) throw new Error(`Invalid .env.e2e entry on line ${index + 1}.`);
    values[match[1] as string] = (match[2] as string).replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
};

export const loadVisionConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): VisionConfig => {
  const file = readEnvFile();
  const read = (name: string): string | undefined => environment[name] ?? file[name];
  const provider = read('E2E_VISION_PROVIDER') ?? 'openrouter';
  if (provider !== 'openrouter') {
    throw new Error(`Unsupported E2E_VISION_PROVIDER ${JSON.stringify(provider)}. Supported: openrouter.`);
  }
  const baseUrl = read('E2E_VISION_BASE_URL') ?? 'https://openrouter.ai/api/v1';
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('E2E_VISION_BASE_URL must use HTTPS (HTTP is allowed only for loopback fixtures).');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('E2E_VISION_BASE_URL cannot contain userinfo, query parameters or a fragment; credentials belong in E2E_VISION_API_KEY.');
  }
  const model = read('E2E_VISION_MODEL') ?? '';
  const apiKey = read('E2E_VISION_API_KEY') ?? '';
  if (model.trim() === '') throw new Error('Set E2E_VISION_MODEL in .env.e2e or the environment.');
  if (apiKey.trim() === '') throw new Error('Set E2E_VISION_API_KEY in .env.e2e or the environment.');
  const boundedInteger = (name: string, fallback: number, max: number): number => {
    const raw = read(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`${name} must be an integer from 1 to ${max}.`);
    }
    return value;
  };
  return {
    provider: 'openrouter',
    baseUrl: parsed.toString().replace(/\/$/, ''),
    model,
    apiKey,
    timeoutMs: boundedInteger('E2E_VISION_TIMEOUT_MS', 60_000, 180_000),
    maxCalls: boundedInteger('E2E_VISION_MAX_CALLS', 50, 500),
    maxOutputTokens: boundedInteger('E2E_VISION_MAX_OUTPUT_TOKENS', 2500, 8000),
    concurrency: boundedInteger('E2E_VISION_CONCURRENCY', 2, 8),
  };
};
