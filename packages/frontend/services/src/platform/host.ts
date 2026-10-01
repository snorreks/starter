// packages/frontend/services/src/platform/host.ts
//
// Which host are we running in?
//
// Detected once and exported as a value rather than re-derived at each call
// site, so a caller cannot disagree with another about the answer. The web
// starter runs in a browser, so the interesting answer is the negative one: this
// also runs during a server render, where there is no `window` at all.

export type HostPlatform = 'browser' | 'server';

export const detectHostPlatform = (): HostPlatform => {
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    return 'browser';
  }
  return 'server';
};
