// apps/frontend/native/src/app.d.ts
//
// The application's own types, as SvelteKit sees them.
//
// There is deliberately no `App.Platform` and no `App.Locals` here, and their
// absence is the point: this app is prerendered to static files and has no server
// runtime inside it. A declaration for a binding set this package cannot receive
// would describe a runtime that does not exist.
//
// What the shell does provide is the Tauri API object, and it is typed at the one
// place that uses it — `src/lib/platform/**`, which the guard classifies as role
// `native-bridge` and which is the only directory in this project permitted to
// import `@tauri-apps/*`.

export {};
