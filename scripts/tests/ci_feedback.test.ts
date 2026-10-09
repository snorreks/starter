import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('CI feedback reports failed steps and updates a single bot-owned comment', async () => {
  const { reportCI } = require('../src/ci/ci_feedback.cjs');
  const calls: { path: string; method?: string; body?: { body: string } }[] = [];
  const run = {
    id: 10,
    run_attempt: 1,
    event: 'pull_request',
    conclusion: 'failure',
    head_sha: 'a'.repeat(40),
    pull_requests: [{ number: 7 }],
  };
  const request = async (path: string, options?: { method?: string; body?: { body: string } }) => {
    calls.push({ path, ...options });
    if (path.endsWith('/pulls/7')) {
      return {
        state: 'open',
        head: { sha: run.head_sha },
        base: { repo: { full_name: 'owner/repo' } },
      };
    }
    if (path.includes('/ci.yml/runs?')) {
      return { workflow_runs: [{ id: 10, head_sha: run.head_sha, run_attempt: 1 }] };
    }
    if (path.includes('/jobs?')) {
      return {
        jobs: [
          {
            id: 15,
            name: 'Typecheck, lint, guards',
            conclusion: 'failure',
            steps: [{ name: 'Typecheck', conclusion: 'failure' }],
          },
        ],
        total_count: 1,
      };
    }
    if (path.includes('/comments?')) {
      return [
        {
          id: 41,
          user: { login: 'github-actions[bot]' },
          body: '<!-- starter-ci-feedback -->\nold',
        },
        { id: 42, user: { login: 'human' }, body: '<!-- starter-ci-feedback -->' },
      ];
    }
    if (path.endsWith('/issues/comments/41')) {
      return {};
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const summary = await reportCI({
    request,
    run,
    repo: 'owner/repo',
    serverUrl: 'https://github.com',
  });
  expect(summary).toContain('Typecheck');
  expect(summary).toContain('bun run typecheck');
  expect(summary).toContain('Prompt to fix CI');
  expect(summary).toContain('/actions/runs/10/job/15');
  expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  expect(calls.find((call) => call.method === 'PATCH')?.path).toEndWith('/41');
});

test('an older CI attempt cannot overwrite feedback for a newer run or changed PR head', async () => {
  const { reportCI } = require('../src/ci/ci_feedback.cjs');
  for (const changedHead of [false, true]) {
    const calls: string[] = [];
    const run = {
      id: 10,
      run_attempt: 1,
      event: 'pull_request',
      conclusion: 'failure',
      head_sha: 'a'.repeat(40),
      pull_requests: [{ number: 7 }],
    };
    const request = async (path: string) => {
      calls.push(path);
      if (path.endsWith('/pulls/7')) {
        return {
          state: 'open',
          head: { sha: changedHead ? 'b'.repeat(40) : run.head_sha },
          base: { repo: { full_name: 'owner/repo' } },
        };
      }
      if (path.includes('/ci.yml/runs?')) {
        return { workflow_runs: [{ id: 11, head_sha: run.head_sha, run_attempt: 1 }] };
      }
      throw new Error(`Stale run reached ${path}`);
    };
    expect(
      await reportCI({ request, run, repo: 'owner/repo', serverUrl: 'https://github.com' }),
    ).toBe(null);
    expect(calls.some((path) => path.includes('/comments'))).toBe(false);
  }
});

test('fork feedback finds the PR through its commit and clears a previous failure on success', async () => {
  const { reportCI } = require('../src/ci/ci_feedback.cjs');
  let body = '';
  const run = {
    id: 20,
    run_attempt: 2,
    event: 'pull_request',
    conclusion: 'success',
    head_sha: 'a'.repeat(40),
    pull_requests: [],
  };
  const request = async (path: string, options?: { method?: string; body?: { body: string } }) => {
    if (path.includes('/commits/')) {
      return [{ number: 7 }];
    }
    if (path.endsWith('/pulls/7')) {
      return {
        state: 'open',
        head: { sha: run.head_sha },
        base: { repo: { full_name: 'owner/repo' } },
      };
    }
    if (path.includes('/ci.yml/runs?')) {
      return { workflow_runs: [{ id: 20, head_sha: run.head_sha, run_attempt: 2 }] };
    }
    if (path.includes('/jobs?')) {
      return { jobs: [{ id: 25, name: 'CI', conclusion: 'success', steps: [] }], total_count: 1 };
    }
    if (path.includes('/comments?')) {
      return [
        {
          id: 41,
          user: { login: 'github-actions[bot]' },
          body: '<!-- starter-ci-feedback -->\nfailed',
        },
      ];
    }
    if (path.endsWith('/issues/comments/41')) {
      body = options?.body?.body ?? '';
      return {};
    }
    throw new Error(`Unexpected request ${path}`);
  };
  await reportCI({ request, run, repo: 'owner/repo', serverUrl: 'https://github.com' });
  expect(body).toContain('CI passed');
  expect(body).not.toContain('Prompt to fix CI');
});

test('cancelled runs publish nothing and missing job evidence is never called passing', async () => {
  const { reportCI } = require('../src/ci/ci_feedback.cjs');
  const run = {
    id: 30,
    run_attempt: 1,
    event: 'pull_request',
    conclusion: 'cancelled',
    head_sha: 'a'.repeat(40),
    pull_requests: [{ number: 7 }],
  };
  expect(
    await reportCI({
      request: () => {
        throw new Error('must not request');
      },
      run,
      repo: 'owner/repo',
      serverUrl: 'https://github.com',
    }),
  ).toBe(null);
  run.conclusion = 'success';
  const request = async (path: string) => {
    if (path.endsWith('/pulls/7')) {
      return {
        state: 'open',
        head: { sha: run.head_sha },
        base: { repo: { full_name: 'owner/repo' } },
      };
    }
    if (path.includes('/ci.yml/runs?')) {
      return { workflow_runs: [{ id: 30, head_sha: run.head_sha, run_attempt: 1 }] };
    }
    if (path.includes('/jobs?')) {
      return { jobs: [], total_count: 0 };
    }
    throw new Error(`Unexpected request ${path}`);
  };
  await expect(
    reportCI({ request, run, repo: 'owner/repo', serverUrl: 'https://github.com' }),
  ).rejects.toThrow('no jobs');
});
