// packages/backend/jobs/src/index.ts
//
// Server-only. Job state, admission, attempt fencing, the Workflow dispatch port
// and bounded maintenance.
//
// Importing this from frontend code is a layering violation (enforced by a Biome
// override and by the workspace-boundary guard): every module here names a
// database, and `@starter/schemas/jobs` is the portable contract a browser half
// is allowed to import.

export * from './lib/dispatch_port.ts';
export * from './lib/job_identity.ts';
export * from './lib/job_repository.ts';
export * from './lib/maintenance.ts';
export * from './lib/maintenance_run.ts';
export * from './lib/runner_identity.ts';
