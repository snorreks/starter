// apps/frontend/client/src/lib/platform/tauri_stub.ts
//
// Replaces every `@tauri-apps/*` import in browser builds (see vite.config.ts).
//
// Every export throws a named error rather than returning a plausible default.
// The failure mode this prevents is the expensive one: a Tauri call that
// silently no-ops in the browser looks like a broken feature ("the file picker
// does nothing") instead of an obvious build-target mistake.

const notTauri = (exportName: string): never => {
  throw new Error(
    `[starter] "${exportName}" is a Tauri API and is not available in a browser build. ` +
      `Guard the call with isTauri() from @starter/frontend-services/platform, ` +
      `or run the desktop build (bun run tauri:dev).`,
  );
};

export const invoke = (command: string): Promise<never> => {
  void command;
  return Promise.reject(notTauri('invoke'));
};

export const convertFileSrc = (path: string): string => {
  void path;
  return notTauri('convertFileSrc');
};

export const getCurrentWindow = (): never => notTauri('getCurrentWindow');

export const emit = (_event: string, _payload?: unknown): void => {
  void _event;
  void _payload;
  notTauri('emit');
};

export const listen = (_event: string, _handler: (payload: unknown) => void): Promise<never> => {
  void _event;
  void _handler;
  return Promise.reject(notTauri('listen'));
};
