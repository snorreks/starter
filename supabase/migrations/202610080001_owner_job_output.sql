create function public.get_encode_job_output(p_job_id text)
returns table(output_key text, expires_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, private, auth
as $$
  select j.output_key, j.output_expires_at
  from private.jobs j
  where j.id = p_job_id
    and j.owner_id = auth.uid()
    and j.status = 'succeeded'
    and j.output_key is not null
    and j.output_expires_at > now()
  limit 1;
$$;
revoke all on function public.get_encode_job_output(text) from public, anon;
grant execute on function public.get_encode_job_output(text) to authenticated;

create function public.get_latest_maintenance()
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, private, auth
as $$
declare v_latest jsonb; v_scheduled jsonb;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='authenticated identity required'; end if;
  select jsonb_build_object(
    'trigger', trigger, 'status', status, 'slot', slot,
    'scheduledTime', extract(epoch from scheduled_time) * 1000,
    'startedAt', extract(epoch from started_at) * 1000,
    'completedAt', extract(epoch from completed_at) * 1000,
    'counts', jsonb_build_object('expiredSessions', expired_sessions, 'idleRateLimits', idle_rate_limits,
      'artifactsQueued', artifacts_queued, 'artifactsRetired', artifacts_retired, 'pendingDispatches', pending_dispatches),
    'errorCode', error_code
  ) into v_latest from private.maintenance_runs order by started_at desc limit 1;
  select jsonb_build_object(
    'trigger', trigger, 'status', status, 'slot', slot,
    'scheduledTime', extract(epoch from scheduled_time) * 1000,
    'startedAt', extract(epoch from started_at) * 1000,
    'completedAt', extract(epoch from completed_at) * 1000,
    'counts', jsonb_build_object('expiredSessions', expired_sessions, 'idleRateLimits', idle_rate_limits,
      'artifactsQueued', artifacts_queued, 'artifactsRetired', artifacts_retired, 'pendingDispatches', pending_dispatches),
    'errorCode', error_code
  ) into v_scheduled from private.maintenance_runs where trigger='scheduled' order by started_at desc limit 1;
  return jsonb_build_object('schedule', '17 * * * *', 'latest', v_latest, 'latestScheduled', v_scheduled,
    'serverTime', extract(epoch from now()) * 1000);
end;
$$;
revoke all on function public.get_latest_maintenance() from public, anon;
grant execute on function public.get_latest_maintenance() to authenticated;

create function public.finish_maintenance_run(
  p_run_key text, p_status text, p_artifacts_queued integer default 0,
  p_artifacts_retired integer default 0, p_error_code text default null
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, private
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  if p_status not in ('succeeded', 'failed') or p_artifacts_queued < 0 or p_artifacts_retired < 0 then
    raise exception using errcode='22023', message='invalid maintenance result';
  end if;
  update private.maintenance_runs set status=p_status, completed_at=now(),
    artifacts_queued=p_artifacts_queued, artifacts_retired=p_artifacts_retired,
    error_code=case when p_status='failed' then coalesce(p_error_code, 'sweep_failed') else null end
    where run_key=p_run_key and status='running';
  return found;
end;
$$;
revoke all on function public.finish_maintenance_run(text,text,integer,integer,text) from public, anon, authenticated;
grant execute on function public.finish_maintenance_run(text,text,integer,integer,text) to service_role;
