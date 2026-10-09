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

    // Named, not merely counted. "At least one workflow" is satisfied by a file
    // that has nothing to do with CI, so a renamed `ci.yml` — or one deleted while
    // some other workflow remained — would leave this passing over a repository with
    // no CI at all.
    expect(report.checked).toContain('ci.yml');
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

  test('a bracket-notation secret reference is caught too', () => {
    // Only the dot form was matched, so `${{ secrets['TOKEN'] }}` — equally valid —
    // walked straight past the rule and the workflow using it went unchecked.
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
      - run: echo "\${{ secrets['CLOUDFLARE_API_TOKEN'] }}"
`;

    expect(rulesFor(source)).toContain('no-credential-on-untrusted-code');
  });

  test('an expression that is not a secret reference is not flagged', () => {
    // The negative half. Without it, a rule broad enough to catch `secrets[` would
    // also catch any `${{ …[ … }}` subscript, and the finding would become noise
    // people learn to ignore.
    const source = compliant(`
  lane:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo "\${{ github.event.inputs.name }}"
      - run: echo "\${{ needs.other.outputs.result }}"
      - run: echo "\${{ matrix.version }}"
`);

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

  test('a self-repository reference with no ref is allowed', () => {
    // Same argument as `./`: the code it resolves to is the code on this branch.
    const local = compliant(`
  lane:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: $/.github/actions/setup
`);

    expect(rulesFor(local)).not.toContain('actions-pinned');
  });

  test('a docker reference is allowed', () => {
    // A published image carries its own digest and is not a commit in this
    // repository's dependency graph.
    const local = compliant(`
  lane:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: docker://alpine:3.20
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

  test('a reusable-workflow caller job is not required to declare a timeout', () => {
    // A job with `uses:` calls a reusable workflow instead of running steps, and
    // GitHub does not honour `timeout-minutes` there. Requiring it would make the
    // rule unsatisfiable for the only job it cannot apply to — which is how a rule
    // gets disabled. The bound still has to exist, on the called workflow's own jobs.
    const source = `
name: test
on:
  workflow_call:
permissions:
  contents: read
jobs:
  call:
    uses: ./.github/workflows/lanes.yml
    secrets: inherit
`;

    expect(rulesFor(source)).not.toContain('job-bounded:call');
  });

  test('an ordinary job with no timeout is still a finding', () => {
    // The other half: skipping caller jobs must not have weakened the rule for
    // everything else.
    const source = `
name: test
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: bun test
`;

    expect(rulesFor(source)).toContain('job-bounded:run');
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

test('privileged workflow_run checkout cannot use the triggering PR revision', () => {
  const source = `
name: feedback
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  contents: read
jobs:
  report:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          ref: \${{ github.event.workflow_run.head_sha }}
`;
  expect(rulesFor(source)).toContain('trusted-workflow-run-checkout:report');
  expect(
    rulesFor(source.replace('github.event.workflow_run.head_sha', 'github.workflow_sha')),
  ).not.toContain('trusted-workflow-run-checkout:report');
});
