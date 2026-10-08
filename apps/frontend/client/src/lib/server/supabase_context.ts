import type { SupabaseAccountService } from '@starter/auth/supabase';
import {
  createSupabaseAccountService,
  createSupabaseIdentityResolver,
  type VerifiedIdentity,
} from '@starter/auth/supabase';
import type { ChatRepository, JobRepository, NotesRepository } from '@starter/database/supabase';
import {
  createAdminDatabaseClient,
  createSupabaseChatRepository,
  createSupabaseJobRepository,
  createSupabaseNotesRepository,
  createUserDatabaseClient,
  type SupabaseAdminConfig,
  type SupabaseJobStatus,
} from '@starter/database/supabase';
import {
  createWorkflowDispatchPort,
  type WorkflowInstanceBinding,
  workflowIdFor,
} from '@starter/jobs';
import type { JobFixture, JobPreset } from '@starter/schemas/jobs';
import type { CookieMethodsServer } from '@supabase/ssr';
import { createServerClient } from '@supabase/ssr';
import type { Cookies } from '@sveltejs/kit';

export interface SupabaseWebConfig extends SupabaseAdminConfig {
  origin: string;
  allowedCallbacks: readonly string[];
  mailUrl?: string;
  jobsProfile?: string;
  encodeWorkflow?: WorkflowInstanceBinding;
}

export interface SupabaseApplicationJobs extends JobRepository {
  computeRequested: boolean;
  dispatch: 'disabled' | 'cloud_run';
  startEncode(input: {
    jobId: string;
    attemptId: string;
    fixture: JobFixture;
    preset: JobPreset;
  }): Promise<boolean>;
}

/** Dispatch state is a service concern; keep the public job response unchanged. */
export const publicSupabaseJob = ({ dispatchState: _dispatchState, ...job }: SupabaseJobStatus) =>
  job;

/** Admission retries recover a Workflow start that did not reach its durable dispatch record. */
export const dispatchAdmittedJob = async (
  jobs: SupabaseApplicationJobs,
  admission: Awaited<ReturnType<JobRepository['admit']>>,
  input: Omit<Parameters<SupabaseApplicationJobs['startEncode']>[0], 'jobId'>,
): Promise<boolean> => {
  if (admission.jobId === null) {
    return false;
  }
  if (admission.outcome !== 'created') {
    const job = await jobs.getForOwner(admission.jobId);
    if (!job) {
      return false;
    }
    if (!['pending', 'dispatch_failed'].includes(job.dispatchState)) {
      return true;
    }
  }
  return jobs.dispatch === 'cloud_run'
    ? jobs.startEncode({ ...input, jobId: admission.jobId })
    : jobs.disableDispatch(admission.jobId);
};

export interface ApplicationServices {
  identity: VerifiedIdentity;
  notes: NotesRepository;
  chat: ChatRepository;
  jobs: SupabaseApplicationJobs;
  account: SupabaseAccountService;
}

/** One service graph for one verified caller. The admin client is never exposed to browser code. */
export const createApplicationServices = (
  identity: VerifiedIdentity,
  config: SupabaseWebConfig,
): ApplicationServices => {
  if (identity.backend !== 'supabase' || !identity.accessToken) {
    throw new Error('Refusing to compose Supabase services from a different backend identity.');
  }
  const userClient = createUserDatabaseClient(config, identity.accessToken);
  const adminClient = createAdminDatabaseClient(config);
  const repository = createSupabaseJobRepository(userClient, adminClient);
  const dispatch = createWorkflowDispatchPort(config.encodeWorkflow);
  const computeEnabled = config.jobsProfile === 'encode' && config.encodeWorkflow !== undefined;
  return {
    identity,
    notes: createSupabaseNotesRepository(userClient),
    chat: createSupabaseChatRepository(userClient, adminClient),
    jobs: Object.assign(repository, {
      computeRequested: config.jobsProfile === 'encode',
      dispatch: computeEnabled ? ('cloud_run' as const) : ('disabled' as const),
      async startEncode(input: {
        jobId: string;
        attemptId: string;
        fixture: JobFixture;
        preset: JobPreset;
      }) {
        if (!computeEnabled) {
          return false;
        }
        const outcome = await dispatch.dispatch({
          ...input,
          workflowId: workflowIdFor(input.jobId),
        });
        if (!outcome.ok) {
          await repository.markDispatchFailed(input.jobId, outcome.code);
          return false;
        }
        await repository.markDispatched(input.jobId);
        return true;
      },
    }),
    account: createSupabaseAccountService(userClient, adminClient, config),
  };
};

export const createSupabaseAuthClient = (config: SupabaseWebConfig, cookies: CookieMethodsServer) =>
  createServerClient(config.url, config.anonKey, {
    cookies,
    // The configured application origin owns cookie security, not the Auth host.
    cookieOptions: { secure: new URL(config.origin).protocol === 'https:' },
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

export interface SupabaseRequestContext {
  identity: VerifiedIdentity | null;
  services: ApplicationServices | null;
  responseHeaders: Headers;
}

/** Build a request-local SSR resolver and capture cookie/cache writes for this response. */
export const createSupabaseRequestContext = async (
  request: Request,
  cookies: Cookies,
  config: SupabaseWebConfig,
): Promise<SupabaseRequestContext> => {
  const responseHeaders = new Headers();
  const resolver = createSupabaseIdentityResolver(config);
  const cookieAdapter: CookieMethodsServer = {
    getAll: () => cookies.getAll().map(({ name, value }) => ({ name, value })),
    setAll: (writes, headers) => {
      for (const { name, value, options } of writes) {
        cookies.set(name, value, {
          ...options,
          path: options.path ?? '/',
          secure: new URL(config.origin).protocol === 'https:',
        });
      }
      for (const [name, value] of Object.entries(headers)) {
        responseHeaders.set(name, value);
      }
    },
  };
  const identity = await resolver.getVerifiedIdentity(request, cookieAdapter);
  return {
    identity,
    services: identity === null ? null : createApplicationServices(identity, config),
    responseHeaders,
  };
};

export const applySupabaseResponseHeaders = (response: Response, headers: Headers): Response => {
  if ([...headers].length === 0) {
    return response;
  }
  const combined = new Headers(response.headers);
  headers.forEach((value, name) => {
    combined.set(name, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: combined,
  });
};
