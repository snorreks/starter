import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Read private bindings only in the runtime host, outside the browser/build environment. */
export const readRuntimeBindings = (environment: NodeJS.ProcessEnv) => {
  const path = environment.STARTER_DEV_VARS_PATH;
  const bindings = path ? parseEnv(readFileSync(path, 'utf8')) : environment;
  const required = (key: string): string => {
    const value = bindings[key]?.trim();
    if (!value) {
      throw new Error(`The E2E runtime requires ${key} from its owned local Supabase stack.`);
    }
    return value;
  };
  return {
    SUPABASE_URL: required('SUPABASE_URL'),
    SUPABASE_ANON_KEY: required('SUPABASE_ANON_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
  };
};
