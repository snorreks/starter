const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface CloudRunJobRequest {
  overrides: { containerOverrides: [{ args: [string, string] }] };
}

export const reconcileExecutionName = (jobId: string, attemptId: string): string => {
  if (!OPAQUE_ID.test(jobId) || !OPAQUE_ID.test(attemptId)) {
    throw new Error('Cloud Run job and attempt ids must be opaque identifiers.');
  }
  return `starter-encode-${jobId.slice(-20)}-${attemptId.slice(-20)}`.toLowerCase();
};

/** Cloud Run receives only identifiers; fixture, preset, URLs and credentials stay server side. */
export const buildJobRequest = (input: {
  jobId: string;
  attemptId: string;
}): CloudRunJobRequest => {
  reconcileExecutionName(input.jobId, input.attemptId);
  return {
    overrides: { containerOverrides: [{ args: [input.jobId, input.attemptId] }] },
  };
};

export interface DispatchPort {
  dispatch(jobId: string, attemptId: string): Promise<{ execution: string; accepted: boolean }>;
  find(jobId: string, attemptId: string): Promise<{ execution: string; state: string } | null>;
}

/** An ambiguous POST is reconciled by deterministic execution identity before retrying. */
export const createCloudRunDispatch = (options: {
  project: string;
  region: string;
  job: string;
  token: () => Promise<string>;
  fetcher?: typeof fetch;
  deadlineMs?: number;
}): DispatchPort => {
  const fetcher = options.fetcher ?? fetch;
  const deadlineMs = options.deadlineMs ?? 10_000;
  const base = `https://run.googleapis.com/v2/projects/${encodeURIComponent(options.project)}/locations/${encodeURIComponent(options.region)}/jobs/${encodeURIComponent(options.job)}`;
  const resourceBase = base.slice('https://run.googleapis.com/v2/'.length);

  const request = async (url: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      return await fetcher(url, { ...init, signal: controller.signal, redirect: 'error' });
    } finally {
      clearTimeout(timer);
    }
  };
  const find = async (jobId: string, attemptId: string) => {
    reconcileExecutionName(jobId, attemptId);
    const token = await options.token();
    const matching: Array<{ name?: unknown; state?: unknown }> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ pageSize: '100' });
      if (pageToken) {
        query.set('pageToken', pageToken);
      }
      const response = await request(`${base}/executions?${query}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(`Cloud Run execution lookup failed (${response.status}).`);
      }
      const body: unknown = await response.json();
      const document = body as {
        executions?: Array<{
          name?: unknown;
          state?: unknown;
          template?: { containers?: Array<{ args?: string[] }> };
        }>;
        nextPageToken?: unknown;
      };
      if (!Array.isArray(document.executions)) {
        throw new Error('Cloud Run returned an invalid execution list.');
      }
      for (const entry of document.executions) {
        const args = entry.template?.containers?.[0]?.args;
        if (args?.[0] === jobId && args?.[1] === attemptId) {
          matching.push(entry);
        }
      }
      if (typeof document.nextPageToken !== 'string' || document.nextPageToken.length === 0) {
        break;
      }
      pageToken = document.nextPageToken;
      if (page === 9) {
        throw new Error('Cloud Run reconciliation exceeded its page bound.');
      }
    }
    if (matching.length > 1) {
      throw new Error('Cloud Run returned duplicate executions for one fenced attempt.');
    }
    const row = matching[0];
    return row && typeof row.name === 'string' && typeof row.state === 'string'
      ? { execution: row.name, state: row.state }
      : null;
  };

  return {
    find,
    async dispatch(jobId, attemptId) {
      const existing = await find(jobId, attemptId);
      if (existing) {
        return { execution: existing.execution, accepted: true };
      }
      const payload = buildJobRequest({ jobId, attemptId });
      let response: Response;
      try {
        response = await request(`${base}:run`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await options.token()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
      } catch {
        const reconciled = await find(jobId, attemptId);
        if (reconciled) {
          return { execution: reconciled.execution, accepted: true };
        }
        throw new Error(
          'Cloud Run dispatch outcome is ambiguous and no matching execution was found.',
        );
      }
      if (!response.ok) {
        throw new Error(`Cloud Run dispatch failed (${response.status}).`);
      }
      const body: unknown = await response.json();
      const operationName = (body as { name?: unknown }).name;
      if (
        typeof operationName !== 'string' ||
        !/^projects\/[^/]+\/locations\/[^/]+\/operations\/[^/]+$/.test(operationName)
      ) {
        throw new Error('Cloud Run accepted a request without a valid operation identity.');
      }
      for (let poll = 0; poll < 6; poll += 1) {
        const operationResponse = await request(`https://run.googleapis.com/v2/${operationName}`, {
          headers: { authorization: `Bearer ${await options.token()}` },
        });
        if (!operationResponse.ok) {
          throw new Error(`Cloud Run operation lookup failed (${operationResponse.status}).`);
        }
        const operation: unknown = await operationResponse.json();
        const record = operation as {
          done?: unknown;
          error?: unknown;
          response?: { name?: unknown };
        };
        if (record.done === true) {
          if (record.error !== undefined) {
            throw new Error('Cloud Run rejected the execution operation.');
          }
          const execution = record.response?.name;
          if (
            typeof execution !== 'string' ||
            !execution.startsWith(`${resourceBase}/executions/`)
          ) {
            throw new Error('Cloud Run operation returned no execution resource.');
          }
          return { execution, accepted: true };
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(deadlineMs, 1000)));
      }
      throw new Error('Cloud Run execution operation exceeded its polling bound.');
    },
  };
};
