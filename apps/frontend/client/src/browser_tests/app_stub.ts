// apps/frontend/client/src/browser_tests/app_stub.ts
//
// Stand-in for `$app/*` in the browser-test lane.
//
// Route components import from `$app/navigation` and `$app/state`. This lane
// tests ViewModels and components, not routing, so those modules are mapped
// here. Every export throws with an explanation rather than silently
// returning undefined: a test that accidentally relies on the router should
// fail with a reason, not pass against a no-op.

const unsupported = (name: string): never => {
  throw new Error(
    `[browser-test] $app/${name} is not available in the browser-test lane. ` +
      'This lane covers ViewModels and components; routing belongs in the Playwright E2E suite.',
  );
};

export const goto = (): Promise<void> => Promise.reject(unsupported('navigation'));
export const invalidateAll = (): Promise<void> => Promise.reject(unsupported('navigation'));
export const invalidate = (): Promise<void> => Promise.reject(unsupported('navigation'));
export const beforeNavigate = (): void => unsupported('navigation');
export const afterNavigate = (): void => unsupported('navigation');
export const preloadData = (): Promise<void> => Promise.reject(unsupported('navigation'));
export const pushState = (): void => unsupported('navigation');
export const replaceState = (): void => unsupported('navigation');

export const page = {
  url: new URL('http://localhost/'),
  params: {} as Record<string, string>,
  route: { id: null },
  status: 200,
  error: null,
  data: {} as Record<string, unknown>,
  form: null,
  state: {} as Record<string, unknown>,
};
