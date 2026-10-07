create table private.jobs (
  id text primary key check (id ~ '^job_[A-Za-z0-9_-]{1,60}$'),
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'encode' check (kind = 'encode'),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  fixture text not null check (fixture = 'sample-v1'),
  preset text not null check (preset = 'demo-180p-v1'),
  idempotency_key text not null check (length(idempotency_key) between 1 and 100),
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  workflow_id text not null unique,
  dispatch_state text not null default 'pending' check (dispatch_state in ('pending', 'dispatched', 'dispatch_failed')),
  dispatch_attempts integer not null default 0,
  dispatch_error text,
  dispatched_at timestamptz,
  active_attempt_id text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  output_key text,
  output_bytes bigint,
  output_sha256 text,
  output_container_format text,
  output_video_codec text,
  output_width integer,
  output_height integer,
  output_duration_ms integer,
  output_expires_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(owner_id, idempotency_key)
);
create unique index jobs_one_active_owner on private.jobs(owner_id) where status in ('pending', 'running');
create index jobs_owner_created_idx on private.jobs(owner_id, created_at);
create index jobs_dispatch_state_idx on private.jobs(dispatch_state, created_at);
create index jobs_output_expiry_idx on private.jobs(output_expires_at);
create table private.job_attempts (
  id text primary key,
  job_id text not null references private.jobs(id) on delete cascade,
  attempt_number integer not null,
  status text not null check (status in ('running', 'succeeded', 'failed', 'expired')),
  lease_expires_at timestamptz not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  unique(job_id, attempt_number)
);
create table private.job_artifact_retirements (
  job_id text primary key references private.jobs(id) on delete cascade,
  output_key text not null,
  runs integer not null default 0,
  cutoff_at timestamptz not null
);
create table private.maintenance_runs (
  run_key text primary key,
  trigger text not null check (trigger in ('scheduled', 'manual')),
  slot text,
  scheduled_time timestamptz,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  cutoff_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  expired_sessions integer not null default 0,
  idle_rate_limits integer not null default 0,
  artifacts_queued integer not null default 0,
  artifacts_retired integer not null default 0,
  pending_dispatches integer not null default 0,
  error_code text
);
create index maintenance_runs_started_idx on private.maintenance_runs(started_at desc);
revoke all on all tables in schema private from public, anon, authenticated;
alter default privileges in schema private revoke all on tables from public, anon, authenticated;
