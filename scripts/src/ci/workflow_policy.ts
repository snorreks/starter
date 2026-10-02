// scripts/src/ci/workflow_policy.ts
//
// The properties CI depends on, asserted against the real workflow files.
//
// This is not a linter. A YAML parse plus four invariants, chosen because each
// one corresponds to a way this repository's CI has previously reported success
// without having checked anything:
//
//   * **`pull_request` with no credential.** GitHub withholds secrets from a fork
//     pull request, so a workflow that *needs* one either fails on every fork or,
//     worse, has a job that only runs on branches and quietly stops covering
//     changes. Asserting the absence of `secrets.*` in a workflow that also
//     triggers on `pull_request` makes that a build failure rather than a surprise.
//   * **`permissions` declared.** The default is repository-wide. A workflow that
//     forgets to narrow it hands write scope to every step, including the ones
//     that check out untrusted pull-request code.
//   * **Every job bounded.** `timeout-minutes` is what stops a job that hangs on a
//     readiness probe from occupying a runner until the platform kills it six
//     hours later.
//   * **Actions pinned to a commit SHA.** `uses: actions/checkout@v4` is a mutable
//     pointer, and a mutable pointer is an unreviewed change to the thing that runs
//     your code.
//
// The scope is deliberately this narrow. A fleet of overlapping scanners is a
// second thing to keep current and a second thing that can be wrong; four
// invariants, each tied to a defect that actually happened here, are not.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { REPO_ROOT } from '../shared/paths.ts';

export const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

export interface Finding {
  workflow: string;
  rule: string;
  detail: string;
}

export interface WorkflowReport {
  checked: string[];
  findings: Finding[];
}

/** `#` followed by 40 hex digits: the only unambiguous pin. */
const SHA_PIN = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

/** `uses:` values that need no pin because they are not third-party code. */
const PIN_EXEMPT = /^\.\//;

const workflowFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort();
  } catch {
    return [];
  }
};

/** Every `uses:` string anywhere in the parsed document. */
const collectUses = (node: unknown, out: string[] = []): string[] => {
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectUses(entry, out);
    }
    return out;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'uses' && typeof value === 'string') {
        out.push(value);
      } else {
        collectUses(value, out);
      }
    }
  }
  return out;
};

const jobsOf = (doc: unknown): Record<string, Record<string, unknown>> => {
  const jobs = (doc as { jobs?: Record<string, Record<string, unknown>> } | null)?.jobs;
  return typeof jobs === 'object' && jobs !== null ? jobs : {};
};

/** The `on:` triggers a workflow declares, as a set of names. */
const triggersOf = (doc: unknown): Set<string> => {
  const raw = (doc as { on?: unknown } | null)?.on;
  const names = new Set<string>();

  if (typeof raw === 'string') {
    names.add(raw);
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string') {
        names.add(entry);
      }
    }
  } else if (raw !== null && typeof raw === 'object') {
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      names.add(key);
    }
  }

  return names;
};

/** Does this workflow run code that a fork's pull request controls? */
const runsUntrusted = (doc: unknown): boolean => triggersOf(doc).has('pull_request');

/**
 * `pull_request_target` is checked separately and deliberately not folded into
 * `runsUntrusted`. It runs in the base repository's context, so it is neither
 * untrusted nor safe — it is the combination. Nested under `runsUntrusted` the
 * rule was unreachable, because no workflow declares both triggers; the test
 * asserted a finding and got none.
 */
const usesPullRequestTarget = (doc: unknown): boolean => triggersOf(doc).has('pull_request_target');

/** `runs-on:` is either one label or a list of them. */
const runLabels = (job: Record<string, unknown>): string[] => {
  const value = job['runs-on'];
  if (typeof value === 'string') {
    return [value];
  }
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
};

const SECRET_REFERENCE = /\$\{\{\s*secrets\./;

export const readWorkflow = (path: string): unknown => parse(readFileSync(path, 'utf8'));

export const auditWorkflow = (name: string, source: string): Finding[] => {
  const findings: Finding[] = [];
  const add = (rule: string, detail: string): void => {
    findings.push({ workflow: name, rule, detail });
  };

  let doc: unknown;
  try {
    doc = parse(source);
  } catch (error) {
    // A workflow that does not parse does not run. That is a syntax failure, and
    // reporting it as such is more useful than reporting six rule violations that
    // are all consequences of it.
    return [
      {
        workflow: name,
        rule: 'parses',
        detail: `YAML did not parse: ${String(error).slice(0, 300)}`,
      },
    ];
  }

  if (doc === null || typeof doc !== 'object') {
    return [{ workflow: name, rule: 'parses', detail: 'the file parsed to nothing' }];
  }

  if ((doc as { permissions?: unknown }).permissions === undefined) {
    add(
      'permissions-declared',
      'no top-level `permissions:`, so every step inherits the repository default',
    );
  }

  if (runsUntrusted(doc)) {
    if (SECRET_REFERENCE.test(source)) {
      add(
        'no-credential-on-untrusted-code',
        'references `secrets.*` while also running on `pull_request`; a fork cannot provide one, so the step fails there and passes on branches',
      );
    }
  }

  if (usesPullRequestTarget(doc)) {
    add(
      'no-privileged-untrusted-context',
      'triggers on `pull_request_target`, which runs the workflow with write scope against code the pull request controls',
    );
  }

  const jobs = jobsOf(doc);
  if (Object.keys(jobs).length === 0) {
    add('has-jobs', 'declares no jobs, so it runs nothing and reports success');
  }

  for (const [id, job] of Object.entries(jobs)) {
    const timeout = job['timeout-minutes'];
    if (typeof timeout !== 'number') {
      add(
        `job-bounded:${id}`,
        'no `timeout-minutes`, so a hang occupies a runner until the platform gives up',
      );
    }

    const labels = runLabels(job);
    if (labels.some((label) => /self-hosted/.test(label))) {
      // A self-hosted runner executes pull-request code on a machine that is
      // usually inside a network.
      if (runsUntrusted(doc)) {
        add(
          `no-self-hosted-on-untrusted:${id}`,
          `runs on \`${labels.join(', ')}\` while the workflow also runs pull-request code`,
        );
      }
    }
  }

  for (const uses of collectUses(doc)) {
    if (PIN_EXEMPT.test(uses)) {
      continue;
    }
    if (!SHA_PIN.test(uses)) {
      add('actions-pinned', `\`${uses}\` is not pinned to a 40-character commit SHA`);
    }
  }

  return findings;
};

export const auditWorkflows = (dir: string = WORKFLOWS_DIR): WorkflowReport => {
  const files = workflowFiles(dir);
  const findings = files.flatMap((name) =>
    auditWorkflow(name, readFileSync(join(dir, name), 'utf8')),
  );
  return { checked: files, findings };
};
