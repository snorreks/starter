// packages/shared/utils/src/lib/process/index.ts
//
// Node-only. Reachable as `@starter/utils/process`, never through the package
// barrel: `@starter/utils` is linked into the browser bundle, and a `node:*` import
// reached from there fails the build with "Module has been externalized for browser
// compatibility".
//
// Importing the subpath is therefore the assertion that the caller is not a browser.

export * from './process_tree.ts';
