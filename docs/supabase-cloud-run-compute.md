# Optional Cloud Run compute

Cloud Run is an optional processor for the encode example. `JOBS_PROFILE=disabled` is the explicit fresh-template default. Enabling compute requires the named Cloud Run, Artifact Registry, Google identity, jobs Worker, R2 bucket and Workflow prerequisites; target resolution names missing settings and refuses before deployment. No profile selection changes application identity or data: Supabase is always used.

Cloudflare Workflows own durable orchestration. Supabase Postgres owns job and attempt state. The finite non-root Cloud Run runner executes the Rust/FFmpeg processor. R2 stores input and output. The runner receives only opaque job and attempt ids, obtains a platform identity token, and requests short-lived object grants from the Worker; it has no Supabase secret or persistent R2 key.

The dispatcher identity is separate from the runner identity. The dispatcher credential is a jobs Worker secret. The runner verifies the signed grant scope, active attempt, object key and lease before uploading; completion checks object identity and integrity. Hosted Google IAM and Cloud Run configuration require explicit operator credentials and are outside local verification.

## Local verification

```sh
bun run test:compute
```

This requires Docker or Podman, builds and runs the real finite processor image, exercises local metadata and grant fixtures, and verifies the FFmpeg output. It does not exercise hosted Google, Cloudflare, Supabase or cross-cloud billing behavior. Missing Docker is a named nonzero prerequisite failure.

See [compute.md](compute.md), [deployment.md](deployment.md), and [apps/backend/jobs/README.md](../apps/backend/jobs/README.md).
