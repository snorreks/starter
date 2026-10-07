alter table private.job_attempts add column if not exists execution_name text;

create or replace function public.claim_encode_job(p_job_id text,p_attempt_id text,p_lease_seconds integer default 300)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare v_job private.jobs%rowtype; v_attempt private.job_attempts%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  select * into v_job from private.jobs where id=p_job_id for update;
  if not found or v_job.status in ('succeeded','failed') or v_job.attempt_count >= 3 then return false; end if;
  select * into v_attempt from private.job_attempts where id=p_attempt_id;
  if found then
    return v_attempt.job_id=p_job_id and v_attempt.status='running'
      and v_job.status='running' and v_job.active_attempt_id=p_attempt_id
      and v_job.lease_expires_at>now() and v_attempt.lease_expires_at>now();
  end if;
  if v_job.status='running' and v_job.lease_expires_at>now() then return false; end if;
  if v_job.active_attempt_id is not null then
    update private.job_attempts set status='expired',completed_at=now()
      where id=v_job.active_attempt_id and status='running';
  end if;
  update private.jobs set status='running',active_attempt_id=p_attempt_id,
    attempt_count=attempt_count+1,
    lease_expires_at=now()+make_interval(secs=>least(greatest(p_lease_seconds,1),1200)),
    updated_at=now() where id=p_job_id;
  insert into private.job_attempts(id,job_id,attempt_number,status,lease_expires_at)
    values(p_attempt_id,p_job_id,v_job.attempt_count+1,'running',
      now()+make_interval(secs=>least(greatest(p_lease_seconds,1),1200)));
  return true;
end;
$$;
revoke all on function public.claim_encode_job(text,text,integer) from public, anon, authenticated;
grant execute on function public.claim_encode_job(text,text,integer) to service_role;

create or replace function public.record_job_dispatch(p_job_id text,p_dispatch_state text,p_error_code text default null)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  if p_dispatch_state not in ('dispatched','dispatch_failed') or (p_dispatch_state='dispatch_failed' and p_error_code is null) then
    raise exception using errcode='22023', message='invalid dispatch transition';
  end if;
  update private.jobs set dispatch_state=p_dispatch_state,dispatch_attempts=dispatch_attempts+1,
    dispatch_error=case when p_dispatch_state='dispatch_failed' then left(p_error_code,80) else null end,
    dispatched_at=case when p_dispatch_state='dispatched' then now() else dispatched_at end,updated_at=now()
  where id=p_job_id and dispatch_state in ('pending','dispatch_failed')
    and ((p_dispatch_state='dispatched' and status in ('pending','running')) or (p_dispatch_state='dispatch_failed' and status='pending'));
  return found;
end;
$$;
revoke all on function public.record_job_dispatch(text,text,text) from public, anon, authenticated;
grant execute on function public.record_job_dispatch(text,text,text) to service_role;

create function public.record_cloud_run_execution(p_job_id text,p_attempt_id text,p_execution_name text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  if p_execution_name !~ '^projects/[a-z0-9-]+/locations/[a-z0-9-]+/jobs/[a-z0-9-]+/executions/[A-Za-z0-9-]+$' then
    raise exception using errcode='22023', message='invalid Cloud Run execution identity';
  end if;
  update private.job_attempts a set execution_name=p_execution_name
    from private.jobs j where a.job_id=p_job_id and a.id=p_attempt_id and a.status='running'
      and j.id=a.job_id and j.status='running' and j.active_attempt_id=p_attempt_id and j.lease_expires_at>now();
  return found;
end;
$$;
revoke all on function public.record_cloud_run_execution(text,text,text) from public, anon, authenticated;
grant execute on function public.record_cloud_run_execution(text,text,text) to service_role;

create function public.authorize_job_runner(p_job_id text,p_attempt_id text,p_execution_name text)
returns table(job_id text,attempt_id text,fixture text,preset text,output_key text,expires_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, private
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  return query select j.id,p_attempt_id,j.fixture,j.preset,
    'media/v1/jobs/'||j.id||'/attempts/'||p_attempt_id||'.mp4',j.lease_expires_at
    from private.jobs j join private.job_attempts a on a.job_id=j.id and a.id=p_attempt_id
    where j.id=p_job_id and j.status='running' and j.active_attempt_id=p_attempt_id
      and j.lease_expires_at > now() and a.status='running' and a.lease_expires_at > now()
      and a.execution_name=p_execution_name;
end;
$$;
revoke all on function public.authorize_job_runner(text,text,text) from public, anon, authenticated;
grant execute on function public.authorize_job_runner(text,text,text) to service_role;

create function public.cloud_run_attempt_failure(p_job_id text,p_attempt_id text)
returns table(job_status text,error_code text) language plpgsql security definer
set search_path = pg_catalog, private
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  return query select j.status::text,a.error_code from private.jobs j
    join private.job_attempts a on a.job_id=j.id
    where j.id=p_job_id and a.id=p_attempt_id and a.status='failed';
end;
$$;
revoke all on function public.cloud_run_attempt_failure(text,text) from public, anon, authenticated;
grant execute on function public.cloud_run_attempt_failure(text,text) to service_role;
