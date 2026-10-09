-- Re-entering the active final attempt reconciles an accepted dispatch; it does
-- not allocate a fourth attempt or extend either lease.
create or replace function public.claim_encode_job(p_job_id text,p_attempt_id text,p_lease_seconds integer default 300)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare v_job private.jobs%rowtype; v_attempt private.job_attempts%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  select * into v_job from private.jobs where id=p_job_id for update;
  if not found or v_job.status in ('succeeded','failed') then return false; end if;
  select * into v_attempt from private.job_attempts where id=p_attempt_id;
  if found then
    return v_attempt.job_id=p_job_id and v_attempt.status='running'
      and v_job.status='running' and v_job.active_attempt_id=p_attempt_id
      and v_job.lease_expires_at>now() and v_attempt.lease_expires_at>now();
  end if;
  if v_job.attempt_count >= 3 then return false; end if;
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
