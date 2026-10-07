import { publicToolEnvironment } from './private_environment.ts';

/** Build tools receive public inputs and PATH, never runtime/review credentials. */
export const buildEnvironment = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  publicToolEnvironment(env);
