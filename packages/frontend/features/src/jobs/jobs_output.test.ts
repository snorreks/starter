// packages/frontend/features/src/jobs/jobs_output.test.ts
//
// The leak this module exists to prevent, and the two refusals it makes instead.
//
// An object URL pins its Blob for the life of the document. One that is never
// revoked is a video the user encoded, held in memory for the rest of the session,
// and the failure is invisible — nothing throws, the page works. So the revocation
// is the tested behaviour, not an afterthought, and the fake URL factory below is
// what makes it observable.

import { describe, expect, test } from 'bun:test';
import {
  browserObjectUrls,
  JobOutputRejectedError,
  MAX_JOB_OUTPUT_BYTES,
  type ObjectUrlFactory,
  outputFilename,
  takeOutputHandle,
} from './jobs_output.ts';

interface CountingUrls extends ObjectUrlFactory {
  readonly created: Blob[];
  readonly revoked: string[];
  readonly live: number;
}

const countingUrls = (): CountingUrls => {
  const created: Blob[] = [];
  const revoked: string[] = [];
  let live = 0;

  return {
    created,
    revoked,
    get live() {
      return live;
    },
    create(blob: Blob): string {
      created.push(blob);
      live += 1;
      return `blob:fake/${created.length}`;
    },
    revoke(url: string): void {
      revoked.push(url);
      live -= 1;
    },
  };
};

describe('taking ownership of a result', () => {
  test('the bytes become one revocable object URL', () => {
    const urls = countingUrls();
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const handle = takeOutputHandle('job_1', bytes, urls);

    expect(handle?.url).toBe('blob:fake/1');
    expect(handle?.bytes).toBe(4);
    expect(urls.created[0]?.type).toBe('video/mp4');
    expect(urls.live).toBe(1);

    handle?.revoke();
    expect(urls.revoked).toEqual(['blob:fake/1']);
    expect(urls.live).toBe(0);
  });

  test('revoking twice releases once', () => {
    // Reachable from a replacement, from a disposal, and from a second disposal —
    // and an un-guarded double revoke is how a screen frees a URL a newer handle
    // is using.
    const urls = countingUrls();
    const handle = takeOutputHandle('job_1', new Uint8Array(8), urls);

    handle?.revoke();
    handle?.revoke();

    expect(urls.revoked).toHaveLength(1);
  });

  test('bytes above the ceiling are refused rather than truncated', () => {
    // A Blob cut to the ceiling is a file that plays to the wrong moment and
    // reports success.
    const urls = countingUrls();
    const tooBig = new Uint8Array(MAX_JOB_OUTPUT_BYTES + 1);

    expect(() => takeOutputHandle('job_1', tooBig, urls)).toThrow(JobOutputRejectedError);
    expect(urls.created).toEqual([]);
  });

  test('an empty answer is refused with its own reason', () => {
    // "Nothing to play" and "too big to play" are different sentences, and a
    // screen that collapsed them would tell a user their 8 MiB result was missing.
    const urls = countingUrls();

    try {
      takeOutputHandle('job_1', new Uint8Array(0), urls);
      throw new Error('the empty answer was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(JobOutputRejectedError);
      expect((error as JobOutputRejectedError).reason).toBe('empty');
    }
  });
});

describe('the file name', () => {
  test('it carries the job id so two results are distinguishable', () => {
    expect(outputFilename('job_abc123')).toBe('starter-sample-job_abc123.mp4');
  });

  test('it drops anything that is not a plain id character', () => {
    // The `download` attribute is written straight into a file name, and a job id
    // is the only untrusted input in it.
    expect(outputFilename('../../etc/passwd')).toBe('starter-sample-etcpasswd.mp4');
    expect(outputFilename('job_a b')).toBe('starter-sample-job_ab.mp4');
  });

  test('an id that sanitizes to nothing still yields a name', () => {
    expect(outputFilename('///')).toBe('starter-sample.mp4');
  });
});

describe('the browser factory', () => {
  test('it is the platform pair, and it is asked for lazily', () => {
    // Constructing the factory must not touch `URL`, so a server-side render of
    // this screen — which the web application does — never reaches a browser-only
    // global. The calls are made here instead, where a DOM exists in the browser
    // lane; this lane only proves the shape is a pair of functions.
    const urls = browserObjectUrls();
    expect(typeof urls.create).toBe('function');
    expect(typeof urls.revoke).toBe('function');
  });
});
