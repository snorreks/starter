import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect, test } from '@playwright/test';
import { REPO_ROOT } from '../../../../scripts/src/shared/paths.ts';
import { runBounded } from '../../../../scripts/src/shared/run_bounded.ts';
import { runScope } from '../../../../scripts/src/shared/run_scope.ts';
import { appBaseUrl } from '../../preflight.ts';
import { createVerifiedAccount } from '../../src/fixtures/accounts.ts';

test('a verified owner encodes real fixture bytes and can replay, range-read and download the output', async ({
  page,
  browser,
}) => {
  await createVerifiedAccount(page);
  await page.goto('/jobs');
  await expect(page.getByRole('heading', { name: 'Sample encode' })).toBeVisible();
  const admissionRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs',
  );
  await page.getByTestId('jobs-start').click();
  const request = await admissionRequest;
  const idempotencyKey = request.headers()['idempotency-key'];
  expect(idempotencyKey).toBeTruthy();
  const admission = await request.response();
  expect(admission?.status()).toBe(202);
  const created = (await admission?.json()) as { id: string };
  expect(created.id).toBeTruthy();

  const row = page.locator(`[data-testid="job-row"][data-job-id="${created.id}"]`);
  await expect(row).toHaveAttribute('data-status', 'succeeded', { timeout: 120_000 });
  await page.reload();
  await expect(
    page.locator(`[data-testid="job-row"][data-job-id="${created.id}"]`),
  ).toHaveAttribute('data-status', 'succeeded');

  const replayResponse = await page.request.post(`${appBaseUrl}/api/jobs`, {
    data: { fixture: 'sample-v1', preset: 'demo-180p-v1' },
    headers: { 'idempotency-key': idempotencyKey as string, origin: appBaseUrl },
  });
  expect(replayResponse.status()).toBe(202);
  const replay = (await replayResponse.json()) as { id: string };
  expect(replay.id).toBe(created.id);
  const listResponse = await page.request.get(`${appBaseUrl}/api/jobs`);
  expect(listResponse.status()).toBe(200);
  const list = (await listResponse.json()) as { jobs: Array<{ id: string }> };
  expect(list.jobs.filter((candidate) => candidate.id === created.id)).toHaveLength(1);

  const rangeResponse = await page.request.get(`${appBaseUrl}/api/jobs/${created.id}/output`, {
    headers: { range: 'bytes=0-15' },
  });
  expect(rangeResponse.status()).toBe(206);
  expect(rangeResponse.headers()['content-range']).toMatch(/^bytes 0-15\//);
  expect((await rangeResponse.body()).byteLength).toBe(16);

  const outputResponse = await page.request.get(`${appBaseUrl}/api/jobs/${created.id}/output`);
  expect(outputResponse.status()).toBe(200);
  expect(outputResponse.headers()['content-type']).toBe('video/mp4');
  const output = Buffer.from(await outputResponse.body());
  expect(output.byteLength).toBeGreaterThan(1_000);
  expect(Number(outputResponse.headers()['content-length'])).toBe(output.byteLength);
  const sha256 = createHash('sha256').update(output).digest('hex');
  expect(outputResponse.headers()['x-output-sha256']).toBe(sha256);
  expect(Number(outputResponse.headers()['x-output-duration-ms'])).toBeGreaterThanOrEqual(1_000);
  expect(Number(outputResponse.headers()['x-output-duration-ms'])).toBeLessThanOrEqual(60_000);

  const container = `starter-e2e-${process.env.E2E_RUN_ID}`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-');
  const scratch = await mkdtemp(join(tmpdir(), 'starter-e2e-output-'));
  let probeResult: {
    format?: { duration?: string };
    streams?: Array<{ codec_name?: string; width?: number; height?: number }>;
  };
  try {
    const localOutput = join(scratch, 'output.mp4');
    await writeFile(localOutput, output, { flag: 'wx', mode: 0o600 });
    const copy = await runBounded({
      command: process.env.DOCKER ?? 'docker',
      args: ['cp', localOutput, `${container}:/tmp/e2e-output.mp4`],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      maxBytes: 128_000,
    });
    expect(copy.code, copy.stderr).toBe(0);
    const probe = await runBounded({
      command: process.env.DOCKER ?? 'docker',
      args: [
        'exec',
        container,
        'ffprobe',
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_name,width,height',
        '-of',
        'json',
        '/tmp/e2e-output.mp4',
      ],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      maxBytes: 128_000,
    });
    expect(probe.code, probe.stderr).toBe(0);
    const document = JSON.parse(probe.stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_name?: string; width?: number; height?: number }>;
    };
    probeResult = document;
    const video = document.streams?.find((stream) => stream.width !== undefined);
    expect(video).toMatchObject({ codec_name: 'h264', width: 320, height: 180 });
    expect(
      Math.abs(
        Number(document.format?.duration) * 1_000 -
          Number(outputResponse.headers()['x-output-duration-ms']),
      ),
    ).toBeLessThanOrEqual(1_000);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const otherPage = await browser.newPage();
  try {
    await createVerifiedAccount(otherPage);
    const denied = await otherPage.request.get(`${appBaseUrl}/api/jobs/${created.id}/output`);
    expect(denied.status()).toBe(404);
  } finally {
    await otherPage.close();
  }
  const anonymous = await browser.newPage();
  try {
    const denied = await anonymous.request.get(`${appBaseUrl}/api/jobs/${created.id}/output`);
    expect(denied.status()).toBe(401);
  } finally {
    await anonymous.close();
  }

  const runId = process.env.E2E_RUN_ID;
  if (!runId) {
    throw new Error('Full compute evidence requires E2E_RUN_ID.');
  }
  const scope = runScope(runId, REPO_ROOT);
  const evidenceDirectory = join(scope.artifactDir, 'compute');
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const mediaPath = join(evidenceDirectory, 'sample-v1-output.mp4');
  const reportPath = join(evidenceDirectory, 'encode.json');
  const reportTemporary = `${reportPath}.${crypto.randomUUID()}.tmp`;
  await writeFile(mediaPath, output, { flag: 'wx', mode: 0o600 });
  await writeFile(
    reportTemporary,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        profile: 'full',
        status: 'passed',
        origin: appBaseUrl,
        fixture: 'sample-v1',
        jobId: created.id,
        output: {
          path: relative(REPO_ROOT, mediaPath),
          sha256,
          bytes: output.byteLength,
          contentType: outputResponse.headers()['content-type'],
          durationMs: Number(outputResponse.headers()['x-output-duration-ms']),
        },
        probe: {
          codec: probeResult?.streams?.find((stream) => stream.width !== undefined)?.codec_name,
          width: probeResult?.streams?.find((stream) => stream.width !== undefined)?.width,
          height: probeResult?.streams?.find((stream) => stream.width !== undefined)?.height,
          durationSeconds: Number(probeResult?.format?.duration),
        },
        assertions: [
          'UI admission',
          'idempotent replay',
          'range read',
          'owner download',
          'non-owner denied',
          'anonymous denied',
        ],
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  await rename(reportTemporary, reportPath);
});
