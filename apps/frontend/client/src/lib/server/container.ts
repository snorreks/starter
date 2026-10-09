import {
  type ChatModel,
  type ChatModelProfile,
  createChatModel,
  resolveChatModelProfile,
  type WorkersAiBinding,
} from './chat_model.ts';
import { type CaptureMailService, createCaptureMailService } from './email/capture_transport.ts';
import { type MailService, resolveMail } from './email/mail.ts';
import { createResendMailService } from './email/resend_transport.ts';
import {
  type AppEnv,
  type DeploymentEnvName,
  type JobsProfileName,
  requireBindings,
  resolveDeploymentEnvironment,
  resolveJobsProfile,
} from './env.ts';

export interface Container {
  env: AppEnv;
  supabase: { url: string; anonKey: string; serviceRoleKey: string; mailUrl?: string };
  environment: DeploymentEnvName;
  isLocal: boolean;
  baseUrl: string;
  mail: MailService;
  mailCapture?: CaptureMailService;
  jobsProfile: JobsProfileName;
  chatModel: ChatModel;
  chatModelProfile: ChatModelProfile;
}

export const VERIFICATION_CALLBACK_PATH = '/verify-email';
const containers = new WeakMap<AppEnv, Map<string, Container>>();

export const getContainer = (rawEnv: unknown, requestOrigin?: string): Container => {
  const env = requireBindings(rawEnv);
  const resolved = resolveDeploymentEnvironment(env, requestOrigin);
  if (!resolved.ok) {
    throw new Error(`Refusing to start: ${resolved.problem}\n\n${resolved.remedy}`);
  }
  const { environment, isLocal, baseUrl } = resolved;
  const key = JSON.stringify([
    baseUrl,
    env.SUPABASE_URL,
    isLocal ? (env.TEST_RUN_ID?.trim() ?? 'local') : null,
  ]);
  const existing = containers.get(env)?.get(key);
  if (existing) {
    return existing;
  }

  const mail = resolveMail(env, isLocal);
  if (!mail.ok) {
    throw new Error(`Refusing to start: ${mail.problem}\n\n${mail.remedy}`);
  }
  const mailService: MailService =
    mail.mode === 'capture'
      ? createCaptureMailService({ isLocal, inboxId: mail.inbox, from: mail.from })
      : createResendMailService({ apiKey: mail.apiKey ?? '', from: mail.from });
  const chatModelProfile = resolveChatModelProfile(env);
  const container: Container = {
    env,
    supabase: {
      url: env.SUPABASE_URL as string,
      anonKey: env.SUPABASE_ANON_KEY as string,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY as string,
      ...(env.SUPABASE_MAIL_URL ? { mailUrl: env.SUPABASE_MAIL_URL } : {}),
    },
    environment,
    isLocal,
    baseUrl,
    mail: mailService,
    jobsProfile: resolveJobsProfile(env),
    chatModelProfile,
    chatModel: createChatModel({
      profile: chatModelProfile,
      binding: env.AI as WorkersAiBinding | undefined,
    }),
    ...(mail.mode === 'capture' ? { mailCapture: mailService as CaptureMailService } : {}),
  };
  let byOrigin = containers.get(env);
  if (!byOrigin) {
    byOrigin = new Map();
    containers.set(env, byOrigin);
  }
  byOrigin.set(key, container);
  return container;
};
