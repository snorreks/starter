import type { ResolvedTarget } from '../target.ts';

const API_ROOT = 'https://run.googleapis.com/v2';
const ARTIFACT_ROOT = 'https://artifactregistry.googleapis.com/v1';
const SERVICE_USAGE_ROOT = 'https://serviceusage.googleapis.com/v1';
const IAM_ROOT = 'https://iam.googleapis.com/v1';
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export type GoogleRequest = (url: string, init: RequestInit) => Promise<Response>;

export interface GoogleResourcePlan {
  project: string;
  region: string;
  requiredApis: readonly string[];
  job: string;
  image: string;
  runner: string;
  dispatcher: string;
  cpu: string;
  memory: string;
  timeoutSeconds: number;
  publicAccess: false;
  dispatcherRole: 'roles/run.invoker';
  runnerRole: 'platform-metadata-only';
}

export const googleResourcePlan = (target: ResolvedTarget): GoogleResourcePlan => {
  const config = target.supabase;
  if (config === null) {
    throw new Error('Google planning requires a resolved Supabase deployment target.');
  }
  return {
    project: config.googleProjectId,
    region: config.googleRegion,
    requiredApis: [
      'artifactregistry.googleapis.com',
      'run.googleapis.com',
      'iam.googleapis.com',
      'serviceusage.googleapis.com',
    ],
    job: config.jobName,
    image: config.image,
    runner: config.runnerServiceAccount,
    dispatcher: config.dispatcherServiceAccount,
    cpu: config.cpu,
    memory: config.memory,
    timeoutSeconds: config.timeoutSeconds,
    publicAccess: false,
    dispatcherRole: 'roles/run.invoker',
    runnerRole: 'platform-metadata-only',
  };
};

/** Google verifies OIDC `sub` against the service account's immutable numeric uniqueId. */
export const getGoogleRunnerSubject = async (options: {
  target: ResolvedTarget;
  accessToken: string;
  fetcher?: GoogleRequest;
}): Promise<string> => {
  const plan = googleResourcePlan(options.target);
  const result = await request({
    ...options,
    url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(plan.project)}/serviceAccounts/${encodeURIComponent(plan.runner)}`,
  });
  const uniqueId =
    typeof result === 'object' && result !== null
      ? (result as { uniqueId?: unknown }).uniqueId
      : null;
  if (typeof uniqueId !== 'string' || !/^\d{8,32}$/.test(uniqueId)) {
    throw new Error(
      'Google did not return the runner service-account uniqueId required for OIDC verification.',
    );
  }
  return uniqueId;
};

const readBounded = async (response: Response): Promise<unknown> => {
  const reader = response.body?.getReader();
  if (!reader) {
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Google API response exceeded its byte budget.');
    }
    chunks.push(value);
  }
  if (total === 0) {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Google API returned invalid JSON.');
  }
};

const request = async (options: {
  target: ResolvedTarget;
  accessToken: string;
  url: string;
  method?: string;
  body?: unknown;
  fetcher?: GoogleRequest;
  allowNotFound?: boolean;
}): Promise<unknown> => {
  if (!options.accessToken || options.accessToken.length > 8192) {
    throw new Error('Google access token is missing or invalid.');
  }
  const response = await (options.fetcher ?? fetch)(options.url, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${options.accessToken}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await readBounded(response);
  if (response.status === 404 && options.allowNotFound === true) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Google API request failed (${response.status}); dependent stages stopped.`);
  }
  return payload;
};

/** Authenticated read-only inventory. A denied list is an error, never an empty inventory. */
export const inspectGoogleResources = async (options: {
  target: ResolvedTarget;
  accessToken: string;
  fetcher?: GoogleRequest;
}): Promise<{
  enabledApis: string[];
  job: unknown;
  runner: string;
  dispatcher: string;
  runnerExists: boolean;
  dispatcherExists: boolean;
}> => {
  const plan = googleResourcePlan(options.target);
  const project = encodeURIComponent(plan.project);
  const location = encodeURIComponent(plan.region);
  const [services, job, accounts] = await Promise.all([
    request({
      ...options,
      url: `${SERVICE_USAGE_ROOT}/projects/${project}/services?filter=state:ENABLED`,
    }),
    request({
      ...options,
      url: `${API_ROOT}/projects/${project}/locations/${location}/jobs/${encodeURIComponent(plan.job)}`,
      allowNotFound: true,
    }),
    request({ ...options, url: `${IAM_ROOT}/projects/${project}/serviceAccounts` }),
  ]);
  if (
    typeof services !== 'object' ||
    services === null ||
    !Array.isArray((services as { services?: unknown }).services)
  ) {
    throw new Error('Google API service discovery returned an invalid response.');
  }
  const enabledApis = (
    services as { services: { config?: { name?: string }; state?: string }[] }
  ).services
    .filter((entry) => entry.state === 'ENABLED' && typeof entry.config?.name === 'string')
    .map((entry) => entry.config?.name as string);
  if (
    typeof accounts !== 'object' ||
    accounts === null ||
    !Array.isArray((accounts as { accounts?: unknown }).accounts)
  ) {
    throw new Error('Google service-account discovery returned an invalid response.');
  }
  const accountEmails = (accounts as { accounts: { email?: string }[] }).accounts.map(
    (account) => account.email,
  );
  return {
    enabledApis,
    job,
    runner: plan.runner,
    dispatcher: plan.dispatcher,
    runnerExists: accountEmails.includes(plan.runner),
    dispatcherExists: accountEmails.includes(plan.dispatcher),
  };
};

/** Create/update the private Cloud Run Job only after authenticated discovery succeeds. */
export const applyGoogleJob = async (options: {
  target: ResolvedTarget;
  accessToken: string;
  fetcher?: GoogleRequest;
}): Promise<unknown> => {
  const plan = googleResourcePlan(options.target);
  await verifyGoogleArtifactImage(options);
  const parent = `projects/${plan.project}/locations/${plan.region}`;
  const name = `${parent}/jobs/${plan.job}`;
  const body = {
    template: {
      taskCount: 1,
      template: {
        serviceAccount: plan.runner,
        timeout: `${plan.timeoutSeconds}s`,
        maxRetries: 0,
        containers: [
          {
            image: plan.image,
            resources: { limits: { cpu: plan.cpu, memory: plan.memory } },
            args: ['encode'],
          },
        ],
      },
    },
  };
  const existing = await request({ ...options, url: `${API_ROOT}/${name}`, allowNotFound: true });
  if (existing === null) {
    return request({
      ...options,
      url: `${API_ROOT}/${parent}/jobs?jobId=${encodeURIComponent(plan.job)}`,
      method: 'POST',
      body,
    });
  }
  return request({
    ...options,
    url: `${API_ROOT}/${name}?updateMask=template`,
    method: 'PATCH',
    body,
  });
};

/** Only the dispatch identity receives job invocation; the runner gets platform identity only. */
export const applyDispatcherGrant = async (options: {
  target: ResolvedTarget;
  accessToken: string;
  fetcher?: GoogleRequest;
}): Promise<void> => {
  const plan = googleResourcePlan(options.target);
  const job = `projects/${plan.project}/locations/${plan.region}/jobs/${plan.job}`;
  const policy = await request({ ...options, url: `${API_ROOT}/${job}:getIamPolicy` });
  if (typeof policy !== 'object' || policy === null) {
    throw new Error('Cloud Run returned an invalid job IAM policy.');
  }
  const current = policy as { etag?: string; bindings?: { role: string; members?: string[] }[] };
  const member = `serviceAccount:${plan.dispatcher}`;
  const bindings = [...(current.bindings ?? [])];
  const invoker = bindings.find((binding) => binding.role === plan.dispatcherRole);
  if (invoker?.members?.includes(member)) {
    return;
  }
  if (invoker === undefined) {
    bindings.push({ role: plan.dispatcherRole, members: [member] });
  } else {
    invoker.members = [...new Set([...(invoker.members ?? []), member])];
  }
  await request({
    ...options,
    url: `${API_ROOT}/${job}:setIamPolicy`,
    method: 'POST',
    body: { policy: { ...(current.etag ? { etag: current.etag } : {}), bindings } },
  });
};

/** Confirms the requested immutable image exists in the target Artifact Registry. */
export const verifyGoogleArtifactImage = async (options: {
  target: ResolvedTarget;
  accessToken: string;
  fetcher?: GoogleRequest;
}): Promise<{ image: string; digest: string }> => {
  const plan = googleResourcePlan(options.target);
  const match =
    /^(?:https:\/\/)?([a-z0-9-]+)-docker\.pkg\.dev\/([^/]+)\/([^/]+)\/(.+)@(sha256:[a-f0-9]{64})$/.exec(
      plan.image,
    );
  if (match === null || match[1] !== plan.region || match[2] !== plan.project) {
    throw new Error('Artifact image is not pinned in the resolved Google project and region.');
  }
  const [, , project, repository, imagePath, digest] = match;
  const resource = `projects/${project}/locations/${plan.region}/repositories/${repository}/dockerImages/${encodeURIComponent(imagePath)}@${digest}`;
  const record = await request({ ...options, url: `${ARTIFACT_ROOT}/${resource}` });
  if (
    typeof record !== 'object' ||
    record === null ||
    !String((record as { name?: unknown }).name ?? '').endsWith(`@${digest}`)
  ) {
    throw new Error('Artifact Registry did not confirm the configured image digest.');
  }
  return { image: plan.image, digest };
};

/** Provision only the small API set this target uses; discovery errors are propagated. */
export const enableGoogleApis = async (options: {
  target: ResolvedTarget;
  accessToken: string;
  fetcher?: GoogleRequest;
}): Promise<string[]> => {
  const plan = googleResourcePlan(options.target);
  const project = encodeURIComponent(plan.project);
  const services = await request({
    ...options,
    url: `${SERVICE_USAGE_ROOT}/projects/${project}/services?filter=state:ENABLED`,
  });
  if (
    typeof services !== 'object' ||
    services === null ||
    !Array.isArray((services as { services?: unknown }).services)
  ) {
    throw new Error('Google API service discovery returned an invalid response.');
  }
  const enabled = (
    services as { services: { config?: { name?: string }; state?: string }[] }
  ).services
    .filter((entry) => entry.state === 'ENABLED' && typeof entry.config?.name === 'string')
    .map((entry) => entry.config?.name as string);
  const missing = plan.requiredApis.filter((api) => !enabled.includes(api));
  for (const api of missing) {
    await request({
      ...options,
      url: `${SERVICE_USAGE_ROOT}/projects/${project}/services/${encodeURIComponent(api)}:enable`,
      method: 'POST',
      body: {},
    });
  }
  return missing;
};

/** Provision accounts by list-then-create; a denied list can never look absent. */
export const ensureGoogleServiceAccounts = async (options: {
  target: ResolvedTarget;
  accessToken: string;
  fetcher?: GoogleRequest;
}): Promise<string[]> => {
  const plan = googleResourcePlan(options.target);
  const project = encodeURIComponent(plan.project);
  const result = await request({
    ...options,
    url: `${IAM_ROOT}/projects/${project}/serviceAccounts`,
  });
  if (
    typeof result !== 'object' ||
    result === null ||
    !Array.isArray((result as { accounts?: unknown }).accounts)
  ) {
    throw new Error('Google service-account discovery returned an invalid response.');
  }
  const accounts = (result as { accounts: { email?: string }[] }).accounts;
  const identities = [plan.runner, plan.dispatcher];
  const created: string[] = [];
  for (const email of identities) {
    if (accounts.some((account) => account.email === email)) {
      continue;
    }
    const accountId = email.slice(0, email.indexOf('@'));
    await request({
      ...options,
      url: `${IAM_ROOT}/projects/${project}/serviceAccounts`,
      method: 'POST',
      body: { accountId, serviceAccount: { displayName: accountId } },
    });
    created.push(email);
  }
  return created;
};

/** All prerequisites are resolved against one target and mutations stop on first failure. */
export const provisionGoogleTarget = async (options: {
  target: ResolvedTarget;
  accessToken: string;
  fetcher?: GoogleRequest;
}): Promise<{ completed: string[]; error: string | null; runnerSubject: string | null }> => {
  const completed: string[] = [];
  let runnerSubject: string | null = null;
  try {
    const enabled = await enableGoogleApis(options);
    completed.push(...enabled.map((api) => `api:${api}`));
    const accounts = await ensureGoogleServiceAccounts(options);
    completed.push(...accounts.map((email) => `service-account:${email}`));
    runnerSubject = await getGoogleRunnerSubject(options);
    await verifyGoogleArtifactImage(options);
    completed.push(`image:${googleResourcePlan(options.target).image}`);
    await applyGoogleJob(options);
    completed.push(`job:${googleResourcePlan(options.target).job}`);
    await applyDispatcherGrant(options);
    completed.push(`iam:${googleResourcePlan(options.target).dispatcher}:roles/run.invoker`);
    return { completed, error: null, runnerSubject };
  } catch (error) {
    return {
      completed,
      error: error instanceof Error ? error.message : 'Google provisioning failed.',
      runnerSubject,
    };
  }
};
