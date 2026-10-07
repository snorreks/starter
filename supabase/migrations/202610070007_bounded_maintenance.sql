create function public.prune_maintenance_history()
returns integer language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare v_deleted integer;
begin
  with expired as (
    select ctid from private.maintenance_runs
    where status in ('succeeded','failed') and completed_at < now() - interval '90 days'
    order by completed_at,run_key limit 200 for update skip locked
  )
  delete from private.maintenance_runs r using expired e where r.ctid=e.ctid;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.prune_maintenance_history() from public, anon, authenticated;
grant execute on function public.prune_maintenance_history() to service_role;

-- The database owns one bounded, database-only retention schedule. Artifact bytes
-- remain queued for the R2-aware maintenance service; SQL never claims to delete them.
create extension if not exists pg_cron with schema extensions;
do $$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname='starter-maintenance-history' limit 1;
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
  perform cron.schedule('starter-maintenance-history','17 * * * *','select public.prune_maintenance_history()');
end;
$$;
