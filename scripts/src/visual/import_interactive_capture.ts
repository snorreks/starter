import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';
import { runScope } from '../shared/run_scope.ts';

export interface CaptureCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InteractiveCaptureOptions {
  runId: string;
  file: string;
  sha256: string;
  url: string;
  heading: string;
  requirements: string[];
  controls: string[];
  content: string[];
  viewport: 'desktop' | 'mobile';
  theme: 'light' | 'dark';
  crop?: CaptureCrop;
}

export interface ImportedCapture {
  runId: string;
  manifestPath: string;
  capturePath: string;
  relativeCapturePath: string;
  sha256: string;
  bytes: number;
  dimensions: { width: number; height: number };
  url: string;
  crop: CaptureCrop | null;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

const cleanUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Interactive capture URL must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Interactive capture URL must be HTTP(S) and contain no credentials.');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
};

const validateStrings = (values: string[], label: string, maximum: number): string[] => {
  if (
    values.length > maximum ||
    values.some(
      (value) => typeof value !== 'string' || value.trim().length === 0 || value.length > 300,
    )
  ) {
    throw new Error(
      `${label} must contain at most ${maximum} non-empty strings of at most 300 characters.`,
    );
  }
  return values.map((value) => value.trim());
};

const validateCrop = (crop: CaptureCrop | undefined): CaptureCrop | null => {
  if (crop === undefined) return null;
  const values = [crop.x, crop.y, crop.width, crop.height];
  if (
    !values.every(Number.isFinite) ||
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.x + crop.width > 1 ||
    crop.y + crop.height > 1
  ) {
    throw new Error('Crop must be a normalized rectangle entirely inside the original screenshot.');
  }
  return { ...crop };
};

/** Import a current browser screenshot without treating it as declared scenario coverage. */
export const importInteractiveCapture = async (
  options: InteractiveCaptureOptions,
): Promise<ImportedCapture> => {
  if (!/^[a-f0-9]{64}$/.test(options.sha256)) {
    throw new Error('Interactive capture requires a lowercase SHA-256 source hash.');
  }
  if (options.heading.trim().length === 0 || options.heading.length > 200) {
    throw new Error('Interactive capture heading must contain 1–200 characters.');
  }
  if (options.requirements.length === 0) {
    throw new Error('Interactive capture needs at least one visual requirement for review.');
  }
  const requirements = validateStrings(options.requirements, 'Requirements', 10);
  const controls = validateStrings(options.controls, 'Controls', 20);
  const content = validateStrings(options.content, 'Content', 20);
  const url = cleanUrl(options.url);
  const crop = validateCrop(options.crop);
  const scope = runScope(options.runId, REPO_ROOT);
  const manifestPath = join(scope.artifactDir, 'visual', 'run.json');
  const visualDir = join(scope.artifactDir, 'visual');
  const capturePath = join(visualDir, `interactive-${randomUUID()}.png`);
  const existing = await Bun.file(manifestPath).exists();
  if (existing) {
    throw new Error(`Run ${options.runId} already has a visual manifest; use a new run id.`);
  }

  const sourcePath = resolve(options.file);
  const bytes = await readFile(sourcePath);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CAPTURE_BYTES) {
    throw new Error(`Interactive capture must be between 1 byte and ${MAX_CAPTURE_BYTES} bytes.`);
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Interactive capture must be an unmodified PNG screenshot.');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== options.sha256) {
    throw new Error(
      'Interactive capture source hash mismatch; screenshot may be stale or tampered.',
    );
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) {
    throw new Error('Interactive capture PNG dimensions are invalid or exceed the 16384px limit.');
  }

  await mkdir(visualDir, { recursive: true });
  const relativeCapturePath = relative(REPO_ROOT, capturePath);
  let captureWritten = false;
  try {
    await writeFile(capturePath, bytes, { flag: 'wx', mode: 0o600 });
    captureWritten = true;
    const project = `${options.viewport}-${options.theme}`;
    const record = {
      scenarioId: 'interactive_capture',
      captureKind: 'interactive',
      app: 'web',
      state: 'interactive',
      project,
      viewport: options.viewport,
      theme: options.theme,
      url,
      file: relativeCapturePath,
      sha256,
      originalSha256: sha256,
      dimensions: { width, height },
      crop,
      requirements,
      expected: { controls, content },
      heading: options.heading.trim(),
      status: 'passed',
    };
    const manifest = {
      schemaVersion: 1,
      runId: options.runId,
      operation: 'visual-capture',
      status: 'passed',
      expectedCaptures: 1,
      expectedCaptureKeys: [`${record.scenarioId}::${project}`],
      coverageGaps: ['Interactive capture is not declared scenario coverage or a baseline.'],
      completedCaptures: 1,
      visualReview: 'not-run',
      provenance: 'interactive',
      records: [record],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (captureWritten) {
      await Bun.file(capturePath)
        .delete()
        .catch(() => {});
    }
    throw error;
  }
  return {
    runId: options.runId,
    manifestPath,
    capturePath,
    relativeCapturePath,
    sha256,
    bytes: bytes.byteLength,
    dimensions: { width, height },
    url,
    crop,
  };
};
