// apps/frontend/native/src/routes/+layout.ts
//
// How this app is built: prerendered once, then bundled.
//
// `prerender` is what makes the output a directory of files the shell can load
// offline. `ssr` is left at its default (true) on purpose: the pages are rendered
// at build time, so there is no per-request server, but the same components that
// run on a client also produce the prerendered HTML. Turning SSR off here would
// mean shipping an empty shell that fills in later — strictly worse, and it would
// make the prerendered output disagree with the running app.
//
// `csr` stays on. Every screen's data comes from the API over the bearer
// transport, and there is no server render in the running app that could have
// fetched it at build time: an origin is a deployment fact, and a prerendered
// page cannot know which one it will be talking to.

export const prerender = true;
