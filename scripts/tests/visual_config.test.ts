import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVisionConfig } from '../src/visual/config.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
const file = (source: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'starter-vision-config-'));
  dirs.push(dir);
  const path = join(dir, '.env.e2e');
  writeFileSync(path, source, { mode: 0o600 });
  return path;
};

test('visual review requires an explicitly configured model and accepts the OpenRouter fallback', () => {
  expect(() => loadVisionConfig({}, { filePath: file('OPENROUTER_API_KEY=file-key') })).toThrow(
    'E2E_VISION_MODEL',
  );
  const config = loadVisionConfig(
    { E2E_VISION_MODEL: 'provider/model', OPENROUTER_API_KEY: 'inherited-key' },
    { filePath: file('E2E_VISION_API_KEY=file-dedicated') },
  );
  expect(config.model).toBe('provider/model');
  expect(config.apiKey).toBe('file-dedicated');
});

test('dedicated keys override the global OpenRouter key; file fallback is not accepted', () => {
  const path = file(
    'E2E_VISION_MODEL=file/model\nE2E_VISION_API_KEY=file-dedicated\nOPENROUTER_API_KEY=file-fallback',
  );
  expect(
    loadVisionConfig(
      { E2E_VISION_MODEL: 'env/model', E2E_VISION_API_KEY: 'env-dedicated' },
      { filePath: path },
    ).apiKey,
  ).toBe('env-dedicated');
  expect(
    loadVisionConfig(
      { E2E_VISION_MODEL: 'env/model', OPENROUTER_API_KEY: 'env-fallback' },
      { filePath: path },
    ).apiKey,
  ).toBe('file-dedicated');
  expect(() =>
    loadVisionConfig(
      { E2E_VISION_MODEL: 'env/model' },
      { filePath: file('OPENROUTER_API_KEY=file-fallback') },
    ),
  ).toThrow('global environment');
});

test('direct CLI and project agent callers share one environment resolver', () => {
  const options = { filePath: file('E2E_VISION_MODEL=file/model\nOPENROUTER_API_KEY=file-key') };
  const inherited = { E2E_VISION_MODEL: 'env/model', OPENROUTER_API_KEY: 'env-key' };
  const directCli = loadVisionConfig(inherited, options);
  const agentEntry = loadVisionConfig(inherited, options);
  expect(agentEntry).toEqual(directCli);
});
