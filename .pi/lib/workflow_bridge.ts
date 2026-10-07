import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { runBounded } from './process.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const OPERATION = /^[a-z][a-z0-9-]{0,63}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface AgentResponse {
  schemaVersion: 1;
  operation: string;
  status: 'passed' | 'failed' | 'error' | 'not-run' | 'not-applicable' | 'needs-human-review';
  runId: string | null;
  checkout: string;
  summary: string;
  artifacts: Array<{ kind: string; path: string; sha256?: string; bytes?: number }>;
  limitations: string[];
  rerun: string[];
  [key: string]: unknown;
}

const validate = (value: unknown, operation: string): AgentResponse => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Starter agent CLI returned a JSON value that is not an object.');
  }
  const result = value as Record<string, unknown>;
  const statuses = new Set([
    'passed',
    'failed',
    'error',
    'not-run',
    'not-applicable',
    'needs-human-review',
  ]);
  if (
    result.schemaVersion !== 1 ||
    result.operation !== operation ||
    !statuses.has(String(result.status)) ||
    !(result.runId === null || typeof result.runId === 'string') ||
    result.checkout !== REPO_ROOT ||
    typeof result.summary !== 'string' ||
    !Array.isArray(result.artifacts) ||
    !Array.isArray(result.limitations) ||
    !Array.isArray(result.rerun) ||
    !(result.artifacts as unknown[]).every((artifact) => {
      if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
        return false;
      }
      const row = artifact as Record<string, unknown>;
      return typeof row.kind === 'string' && typeof row.path === 'string';
    }) ||
    !(result.limitations as unknown[]).every((item) => typeof item === 'string') ||
    !(result.rerun as unknown[]).every((item) => typeof item === 'string')
  ) {
    throw new Error('Starter agent CLI returned an invalid schema-version-1 response.');
  }
  if (
    result.runId !== null &&
    operation.startsWith('visual-') &&
    !RUN_ID.test(String(result.runId))
  ) {
    throw new Error('Starter agent CLI returned an invalid visual run id.');
  }
  return result as unknown as AgentResponse;
};

/** Invoke a project authority through argv and preserve its real exit/status contract. */
export async function invokeStarterAgent(
  args: readonly string[],
  options: { operation: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ response: AgentResponse; exitCode: number }> {
  if (!OPERATION.test(options.operation) || args.length === 0 || args.length > 16) {
    throw new Error('Invalid Starter agent operation request.');
  }
  const child = await runBounded('bun', ['run', 'agent', '--', ...args], {
    cwd: REPO_ROOT,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxBytes: 512 * 1024,
    signal: options.signal,
  });
  if (child.timedOut || child.cancelled) {
    throw new Error(
      child.cancelled
        ? 'Starter agent operation was cancelled.'
        : 'Starter agent operation timed out.',
    );
  }
  let response: AgentResponse;
  try {
    response = validate(JSON.parse(child.stdout.trim()), options.operation);
  } catch (error) {
    throw new Error(
      `Starter agent CLI did not return a valid JSON response: ${child.stderr.trim() || (error as Error).message}`,
      { cause: error },
    );
  }
  let expectedExit: number | null;
  if (response.status === 'passed' || response.status === 'not-applicable') {
    expectedExit = 0;
  } else if (response.status === 'needs-human-review') {
    expectedExit = response.gate === true ? 1 : 0;
  } else if (response.status === 'not-run') {
    expectedExit = 3;
  } else {
    expectedExit = null;
  }
  if (
    (expectedExit !== null && child.code !== expectedExit) ||
    (expectedExit === null && child.code === 0)
  ) {
    throw new Error(
      `Starter agent status ${response.status} disagrees with exit code ${child.code}.`,
    );
  }
  return { response, exitCode: child.code };
}

export const responseToolResult = (
  response: AgentResponse,
  exitCode = 0,
): AgentToolResult<unknown> => ({
  content: [{ type: 'text', text: JSON.stringify(response) }],
  isError: exitCode !== 0,
  details: response,
});
