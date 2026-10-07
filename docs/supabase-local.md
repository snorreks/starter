# Local Supabase foundation

Prompt 02 adds an isolated local Supabase stack and Postgres repositories beside
the existing D1 backend. The application continues to use D1 and Better Auth by
default. No hosted project or live data is touched by these commands.

## Run the local lane

From the repository root:

```bash
bun run setup:doctor -- --profile database
bun run test:database
bun run db:types
bun run db:types:check
```

The database profile and integration lane need Docker Engine or a Docker
compatible Podman socket. `test:database` returns a named nonzero error when the
runtime is unavailable. Each command creates a checkout and run scoped project,
starts from a fresh local database, replays the ordered migrations, and tears
down only containers and volumes carrying that project's Supabase CLI label.
The owner manifest includes a random token; a mismatched or stale owner cannot
stop or reset another run.

`db:types` invokes the database package's pinned Supabase CLI to generate
`packages/backend/database/src/supabase/database.types.ts` from the running
local migration database. `db:types:check` generates to a temporary file and
compares it without modifying the tracked file. Both use a newly allocated
local stack and never link to a hosted project.

## Allocation values

The scripts workspace is the allocation authority. Every endpoint and the copied
local Supabase config come from the same allocation:

| Variable | Meaning |
|---|---|
| `SUPABASE_PROJECT_ID` | Unique local CLI project identity |
| `SUPABASE_RUN_ID`, `SUPABASE_OWNER_TOKEN` | Run identity and teardown ownership |
| `SUPABASE_API_PORT`, `SUPABASE_POSTGRES_PORT`, `SUPABASE_STUDIO_PORT` | API, Postgres and Studio ports |
| `SUPABASE_MAIL_PORT`, `SUPABASE_SMTP_PORT`, `SUPABASE_POP3_PORT` | Mailpit UI, SMTP and POP3 ports |
| `SUPABASE_URL`, `SUPABASE_DB_URL`, `SUPABASE_STUDIO_URL` | Allocated API, Postgres and Studio URLs |
| `SUPABASE_MAIL_URL`, `SUPABASE_SMTP_URL` | Allocated local mail UI URL and SMTP address |
| `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Ephemeral CLI-issued local keys passed only to the test child process |

Local Auth confirmation mail is captured by Mailpit at `SUPABASE_MAIL_URL`;
SMTP clients use `SUPABASE_SMTP_URL`. The integration lane creates synthetic
users through the local Auth signup API, which also exercises profile creation.

## Repository interfaces

Import the additive adapters from `@starter/database/supabase`:

- `createUserDatabaseClient({ url, anonKey }, accessToken)` creates a request
  scoped user client. It does not persist or refresh shared sessions.
- `createAdminDatabaseClient({ url, anonKey, serviceRoleKey })` is the explicit
  service role factory for trusted server work.
- `createSupabaseNotesRepository(client)` implements `list(ownerId, page)`,
  `create(ownerId, input)`, `update(ownerId, id, input)` and
  `remove(ownerId, id)` using shared note DTOs.
- `createSupabaseChatRepository(userClient, adminClient?)` implements
  `createConversation(ownerId, title)`, `listConversations(ownerId, page)`,
  `listMessages(ownerId, conversationId, page)`, `admitGeneration(input)` and
  `completeGeneration(input)`. Keep the admin client server only.
- `createSupabaseJobRepository(serviceClient)` implements `admit(input)`,
  `claim(jobId, attemptId, leaseSeconds?)` and `complete(input)`. The database
  RPC remains the authority for quotas, leases, attempt fencing and completion.

Adapters map UUID rows to the existing prefixed shared IDs and Postgres
timestamps to millisecond DTO values. Database rows do not cross the repository
boundary.

## SQL surface

The exposed `public` tables are `profiles`, `notes`, `conversations` and
`messages`. RLS binds rows to `auth.uid()`, including insert checks; chat
messages can only be written through the admission/completion transactions.
Jobs, attempts, generation state, maintenance runs and quota counters live in
the unexposed `private` schema. The API config exposes only `public` and
`graphql_public`.

Public RPCs are `admit_chat_generation`, `complete_chat_generation`,
`fail_chat_generation`, `admit_encode_job`, `claim_encode_job`,
`record_job_dispatch`, `finish_encode_job`, `fail_encode_job`,
`queue_expired_job_artifacts`, `retire_job_artifact` and
`begin_maintenance_run`. User admission derives the owner from `auth.uid()`;
there is no owner argument. Completion, failure, lease and maintenance RPCs
revoke caller execution and grant only the service role. Elevated functions set
a fixed search path and check the request role or identity.

The local integration lane combines the Data API HTTP controls and concurrent
Postgres/API calls with pgTAP RLS and schema assertions. Run it with
`bun run test:database`; Docker is a required prerequisite and this lane is
included in CI's required gate.
