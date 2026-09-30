// apps/frontend/client/src/routes/+layout.ts
//
// SPA, not SSR. The API is reached over HTTP with a session cookie, and
// rendering on a server would add a second identity path to maintain for no
// benefit: there is no public page that needs to be indexable.

export const ssr = false;
export const prerender = false;
