import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';
import { runBounded } from '../shared/run_bounded.ts';

export interface ReviewImage {
  bytes: Buffer;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  sha256: string;
  originalSha256: string;
  originalPath: string;
  derivativePath: string | null;
  dimensions: { width: number; height: number } | null;
  preparation: {
    backend: 'original' | 'imagemagick' | 'ffmpeg';
    fallbackReasons: string[];
  };
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const detectMime = (bytes: Buffer): ReviewImage['mimeType'] | null => {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
};

const identify = async (
  path: string,
): Promise<{ mimeType: ReviewImage['mimeType']; width: number; height: number } | null> => {
  const result = await runBounded({
    command: 'magick',
    args: ['identify', '-format', '%m %w %h', path],
    cwd: REPO_ROOT,
    timeoutMs: 10_000,
    maxBytes: 4096,
  });
  if (result.code !== 0) {
    return null;
  }
  const match = /^(PNG|JPEG|WEBP) (\d+) (\d+)$/.exec(result.stdout.trim());
  if (match === null) {
    return null;
  }
  let mimeType: ReviewImage['mimeType'];
  if (match[1] === 'PNG') {
    mimeType = 'image/png';
  } else if (match[1] === 'JPEG') {
    mimeType = 'image/jpeg';
  } else {
    mimeType = 'image/webp';
  }
  return {
    mimeType,
    width: Number(match[2]),
    height: Number(match[3]),
  };
};

const dimensionsWithFfprobe = async (
  path: string,
): Promise<{ width: number; height: number } | null> => {
  const result = await runBounded({
    command: 'ffprobe',
    args: [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=s=x:p=0',
      path,
    ],
    cwd: REPO_ROOT,
    timeoutMs: 10_000,
    maxBytes: 4096,
  });
  const match = result.code === 0 ? /^(\d+)x(\d+)$/.exec(result.stdout.trim()) : null;
  return match === null ? null : { width: Number(match[1]), height: Number(match[2]) };
};

const validDerivative = async (
  path: string,
  maxBytes: number,
  original: { width: number; height: number },
): Promise<{ bytes: Buffer; dimensions: { width: number; height: number } } | null> => {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes || detectMime(bytes) !== 'image/jpeg') {
    return null;
  }
  const identified = await identify(path);
  const dimensions = identified ?? (await dimensionsWithFfprobe(path));
  if (
    dimensions === null ||
    dimensions.width < 320 ||
    dimensions.height < 180 ||
    dimensions.width > original.width ||
    dimensions.height > original.height
  ) {
    return null;
  }
  const originalRatio = original.width / original.height;
  const derivativeRatio = dimensions.width / dimensions.height;
  if (Math.abs(originalRatio - derivativeRatio) / originalRatio > 0.02) {
    return null;
  }
  return { bytes, dimensions };
};

/** Preserve originals; optimize only an over-limit image, with a decoded, bounded derivative. */
export const prepareReviewImage = async (
  path: string,
  maxBytes = 5 * 1024 * 1024,
): Promise<ReviewImage> => {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Image byte limit must be a positive integer.');
  }
  const originalBytes = await readFile(path);
  if (originalBytes.byteLength === 0) {
    throw new Error(`Review image is empty: ${path}`);
  }
  const originalMime = detectMime(originalBytes);
  if (originalMime === null) {
    throw new Error(`Unsupported review image type: ${path}. Expected PNG, JPEG, or WebP.`);
  }
  const originalSha256 = digest(originalBytes);
  if (originalBytes.byteLength <= maxBytes) {
    return {
      bytes: originalBytes,
      mimeType: originalMime,
      sha256: originalSha256,
      originalSha256,
      originalPath: path,
      derivativePath: null,
      dimensions: null,
      preparation: { backend: 'original', fallbackReasons: [] },
    };
  }

  const originalDimensions = (await identify(path)) ?? (await dimensionsWithFfprobe(path));
  if (originalDimensions === null) {
    throw new Error(
      `Over-limit review image could not be decoded: ${path}. Install ImageMagick or FFmpeg and verify the screenshot is a valid PNG, JPEG or WebP.`,
    );
  }
  const outputDirectory = join(REPO_ROOT, '.wrangler', 'visual-prepared');
  await mkdir(outputDirectory, { recursive: true });
  const destination = join(outputDirectory, `${originalSha256}-${maxBytes}.jpg`);
  const temporary = `${destination}.${randomUUID()}.tmp.jpg`;
  const fallbackReasons: string[] = [];

  const magickReasons: string[] = [];
  for (const quality of [92, 88, 84]) {
    const result = await runBounded({
      command: 'magick',
      args: [
        path,
        '-auto-orient',
        '-resize',
        '1920x1440>',
        '-strip',
        '-quality',
        String(quality),
        temporary,
      ],
      cwd: REPO_ROOT,
      timeoutMs: 30_000,
      maxBytes: 32_000,
    });
    if (result.code === 0) {
      const candidate = await validDerivative(temporary, maxBytes, originalDimensions);
      if (candidate !== null) {
        await rename(temporary, destination);
        return {
          bytes: candidate.bytes,
          mimeType: 'image/jpeg',
          sha256: digest(candidate.bytes),
          originalSha256,
          originalPath: path,
          derivativePath: destination,
          dimensions: candidate.dimensions,
          preparation: { backend: 'imagemagick', fallbackReasons },
        };
      }
      magickReasons.push(
        `ImageMagick quality ${quality} did not produce a decoded JPEG within ${maxBytes} bytes.`,
      );
    } else {
      magickReasons.push(
        result.stderr.trim().slice(-500) || `ImageMagick quality ${quality} exited ${result.code}.`,
      );
      break;
    }
  }
  fallbackReasons.push(...magickReasons);

  const filter = "scale='iw*min(1\\,1920/iw\\,1440/ih)':'ih*min(1\\,1920/iw\\,1440/ih)'";
  const ffmpeg = await runBounded({
    command: 'ffmpeg',
    args: [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      path,
      '-frames:v',
      '1',
      '-vf',
      filter,
      '-q:v',
      '2',
      temporary,
    ],
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
    maxBytes: 32_000,
  });
  if (ffmpeg.code === 0) {
    const candidate = await validDerivative(temporary, maxBytes, originalDimensions);
    if (candidate !== null) {
      await rename(temporary, destination);
      return {
        bytes: candidate.bytes,
        mimeType: 'image/jpeg',
        sha256: digest(candidate.bytes),
        originalSha256,
        originalPath: path,
        derivativePath: destination,
        dimensions: candidate.dimensions,
        preparation: { backend: 'ffmpeg', fallbackReasons },
      };
    }
    fallbackReasons.push(
      `FFmpeg did not produce a decoded JPEG within ${maxBytes} bytes with preserved dimensions.`,
    );
  } else {
    fallbackReasons.push(ffmpeg.stderr.trim().slice(-500) || `FFmpeg exited ${ffmpeg.code}.`);
  }
  await rm(temporary, { force: true });
  throw new Error(
    `Review image exceeds ${maxBytes} bytes and no safe derivative could be produced: ${path}. Install ImageMagick or FFmpeg, raise the explicit provider byte limit, or capture a smaller viewport. ${fallbackReasons.join(' | ')}`,
  );
};
