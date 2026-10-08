# @starter/jobs

Portable job contracts and dispatch policy for the Cloud Run compute example.

## Purpose and runtime

This package contains provider independent job DTOs, idempotency and dispatch ports. It does not own persistence or run FFmpeg. `@starter/database/supabase` implements the job repository with transactional Postgres RPCs; the jobs Worker owns Cloudflare Workflow orchestration; Cloud Run runs the finite Rust/FFmpeg runner; R2 holds input and output bytes.

Admission, execution and completion use an attempt id as a fencing token. Replays address the same Workflow instance. A stale attempt cannot complete or fail a reclaimed job. Disabled compute is an explicit profile; an enabled profile with missing provider settings fails with the missing names.

## Setup

Run `bun install` at the repository root. Cloud Run configuration is optional while compute is disabled.

## Commands

```bash
bun run test
bun run typecheck
bun run lint
```

## Validation

Run `bun run test` in this package for unit coverage and `bun run test:compute` at the repository root for Docker and real FFmpeg execution.

## Boundaries

This package imports shared job contracts and server repository interfaces; application routes do not import it. See [compute](../../../docs/compute.md), [testing](../../../docs/testing.md), and [architecture](../../../docs/architecture.md).
