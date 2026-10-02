// scripts/tests/workflows.test.ts
//
// Four invariants over the real CI workflows, and the four ways this repository's
// CI has previously been green without having checked anything.
//
// Fixtures are written to disk and audited through the real entrypoint, so the
// parser and the rules are exercised together. The positive case is the
// repository's own `ci.yml`: a rule that nothing here satisfies is a rule that
// would have fired on the file it is supposed to bless.

import { describe, expect, test } from 'bun:test';
import { auditWorkflow, auditWorkflows } from '../src/ci/workflow_policy.ts';

/**
 * A workflow that satisfies every rule, wrapping a jobs block.
 *
 * Each fixture supplies only the part it is testing, so a rule cannot pass because
 * the fixture happened to include something unrelated that also satisfied it.
 */
const compliant = (jobs: string): string => `
name: test
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
${jobs}
`;

const ONE_JOB = `  lane:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - run: bun run test`;

const rulesFor = (source: string): string[] =>
  auditWorkflow('fixture.yml', source).map((f) => f.rule);

describe('this repository’s own workflows satisfy the policy', () => {
  test('the real ci.yml reports no findings', () => {
    const report = auditWorkflows();

    // Zero workflows checked would pass vacuously, which is the failure this whole
    // check exists to prevent — so the count is asserted before the findings.
    expect(report.checked.length).toBeGreaterThanOrEqual(1);
    expect(report.findings).toEqual([]);
  });
});

describe('a credential in a workflow that runs pull-request code is refused', () => {
  test('a `secrets.*` reference alongside `pull_request` is a finding', () => {
    const source = `
name: test
on:
  pull_request:
permissions:
  contents: read
jobs:
  lane:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo "\${{ secrets.CLOUDFLARE_API_TOKEN }}"
`;

    expect(rulesFor(source)).toContain('no-credential-on-untrusted-code');
  });

  test('the same reference on a push-only workflow is allowed', () => {
    // The distinction matters: a deployment workflow legitimately needs a token,
    // and flagging it would train people to disable the rule.
    const source = `
name: release
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  lane:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: deploy --yes "\${{ secrets.CLOUDFLARE_API_TOKEN }}"
`;

    expect(rulesFor(source)).not.toContain('no-credential-on-untrusted-code');
  });

  test('`pull_request_target` is refused even with no secret', () => {
    // It runs with the base repository's privileges against code the pull request
    // controls, which is worse than a missing secret.
    const source = `
name: test
on:
  pull_request_target:
permissions:
  contents: read
jobs:
  lane:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`;

    expect(rulesFor(source)).toContain('no-privileged-untrusted-context');
  });
});

describe('an unpinned action is refused', () => {
  test('a tag reference is a finding', () => {
    expect(rulesFor(compliant(ONE_JOB))).not.toContain('actions-pinned');

    const tagged = compliant(ONE_JOB).replace(
      'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
      'actions/checkout@v4',
    );

    expect(rulesFor(tagged)).toContain('actions-pinned');
  });

  test('a local action reference is allowed', () => {
    const local = compliant(`
  lane:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: ./.github/actions/setup
`);

    expect(rulesFor(local)).not.toContain('actions-pinned');
  });

  test('a short hex pin is refused', () => {
    // Eleven characters is not a commit. A truncated pin that looks pinned is the
    // case a naive "does it contain a hash" check would pass.
    const short = compliant(ONE_JOB).replace(
      'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
      'actions/checkout@11bd7190',
    );

    expect(rulesFor(short)).toContain('actions-pinned');
  });
});

describe('an unbounded job is refused', () => {
  test('a job with no timeout is a finding', () => {
    const unbounded = compliant(`
  lane:
    runs-on: ubuntu-latest
    steps:
      - run: bun run test
`);

    expect(rulesFor(unbounded)).toContain('job-bounded:lane');
  });
});

describe('missing declarations are findings rather than defaults', () => {
  test('no top-level permissions is a finding', () => {
    const source = `
name: test
on:
  pull_request:
jobs:
  lane:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`;

    expect(rulesFor(source)).toContain('permissions-declared');
  });

  test('a self-hosted runner on pull-request code is a finding', () => {
    const source = `
name: test
on:
  pull_request:
permissions:
  contents: read
jobs:
  lane:
    runs-on: [self-hosted, linux]
    timeout-minutes: 5
    steps:
      - run: echo hi
`;

    expect(rulesFor(source)).toContain('no-self-hosted-on-untrusted:lane');
  });

  test('a workflow that parses to nothing is a finding, not a pass', () => {
    const broken = `
name: test
on:
  pull_request:
jobs:
 lane:
  runs-on: ubuntu-latest
   timeout-minutes: 5
  steps: [ unclosed
`;

    expect(rulesFor(broken)).toContain('parses');
  });

  test('a workflow with no jobs is a finding', () => {
    expect(rulesFor('name: test\non:\n  push:\npermissions:\n  contents: read\n')).toContain(
      'has-jobs',
    );
  });
});
