// apps/frontend/client/src/browser_tests/setup.ts
//
// Setup for the real-browser test lane.
//
// One rule, enforced rather than documented: **no network**. A browser test that
// reaches the network is testing connectivity, not the code, and it makes the
// suite depend on something the developer may not have running. `fetch` is
// replaced with something that fails loudly and names the URL.

const originalFetch = globalThis.fetch;

const OFFLINE_MESSAGE =
  'A browser test attempted a network request. Browser tests are hermetic: ' +
  'inject a fake service instead of calling a real one.';

export const installOfflineGuard = (): void => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`${OFFLINE_MESSAGE} (${url})`));
  }) as typeof fetch;
};

export const restoreFetch = (): void => {
  globalThis.fetch = originalFetch;
};

// Applied automatically so a test that forgets cannot silently reach out.
installOfflineGuard();
