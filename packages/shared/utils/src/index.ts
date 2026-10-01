// packages/shared/utils/src/index.ts
//
// Pure helpers and the one base class. No framework, no I/O, no environment
// assumptions beyond Web-standard globals.

export * from './lib/common/base_class.ts';
export * from './lib/common/deferred.ts';
export * from './lib/common/error.ts';
export * from './lib/common/ids.ts';
export * from './lib/common/lifecycle_guard.ts';
export * from './lib/common/listener.ts';
export * from './lib/common/stale_guard.ts';
// `./lib/process` is deliberately NOT re-exported here. It uses `node:child_process`
// and `node:fs`, and this package is also linked into the browser bundle — a barrel
// export made `@starter/utils` un-importable from the browser the moment a
// Node-only helper was added. It is reachable as `@starter/utils/process`, which is
// an explicit statement that the caller is running outside a browser.
export * from './lib/text/index.ts';
