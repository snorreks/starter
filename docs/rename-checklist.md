# Fresh template setup checklist

The template starts without inherited project identifiers. Supabase owns application identity and relational data. Cloudflare hosts the web Worker and optional jobs Worker; Cloud Run compute is explicitly disabled until configured.

## Provision Supabase

Create or select a Supabase project outside this repository. Hosted project creation may incur cost. Set the project URL, project reference and publishable key in the local deployment configuration. Install the service role key only through the documented secret flow; never put it in a browser or native build.

For local work, install Docker or Podman and run:

```bash
bun run test:database
bun run db:types
```

## Configure deployment targets

Set independent staging and production values with `bun run deploy:configure`, or configure the repository variable `STARTER_DEPLOYMENT_TARGETS`. The offline plan must resolve each environment to its own Worker, Supabase project and origin before any authenticated operation.

`deploy:configure` only sets the Cloudflare-facing values (`--account`,
`--worker`, `--origin`, `--mail-from`, `--native-api-origin`) and the compute
flags. The Supabase and Cloud Run fields it has no flag for must be written
directly into the gitignored `.starter/deployment.local.json`, or supplied
through `STARTER_DEPLOYMENT_TARGETS`: `supabaseProjectRef`, `supabaseUrl`,
`supabaseAuthUrl`, `supabasePublishableKey`, `nativeRedirectAllowlist`, and —
for an enabled environment — `googleProjectId`, `googleRegion`,
`cloudRunJobName`, `artifactImage` (pinned by digest), `runnerServiceAccount`,
`dispatcherServiceAccount`, `processorProtocol`, `processorCpu`,
`processorMemory`, `processorTimeoutSeconds`, `jobsWorkerName`,
`mediaBucketName`, `encodeWorkflowName` and `maintenanceWorkflowName`. The
Supabase origins must be `https://<supabaseProjectRef>.supabase.co`, because
migrations address the project by ref and the runtime by origin, and the
resolver refuses a target where those two disagree.

```bash
bun run deploy:check --env staging
bun run deploy:preflight --env staging
```

Keep compute disabled for a web only deployment. To enable it, configure the Cloud Run project, region, job, image, runner and dispatcher identities, R2 bucket and Workflows names. Enabled compute refuses incomplete configuration.

## Validate before a release

```bash
bun run typecheck
bun run lint
bun run format
bun run guard:whole-repo
bun run workflows
bun run test:all
bun run test:database
bun run test:compute
bun run smoke
bun run smoke -- --without-heavy
bun run evidence
```

Native builds additionally require the platform toolchain in [native setup](native.md). Hosted Supabase, Resend, Cloud Run and physical device observations require their own credentials and hardware and are not implied by local checks.

## Retire an older deployment

This repository does not migrate existing users or data, modify hosted resources, or retire a live deployment. Keep the prior deployment available until an operator has separately validated and authorized its replacement and retirement.
