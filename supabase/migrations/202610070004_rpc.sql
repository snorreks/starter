create function public.admit_chat_generation(
  p_conversation_id uuid, p_client_id text, p_request_fingerprint text,
  p_user_message_id uuid, p_content text
) returns table(outcome text, assistant_message_id uuid, attempt integer)
language plpgsql security definer
set search_path = pg_catalog, public, private, auth
as $$
declare v_owner uuid := auth.uid(); v_row private.chat_generations%rowtype; v_bucket timestamptz := date_trunc('hour', now()); v_created boolean;
begin
  if v_owner is null then raise exception using errcode = '42501', message = 'authenticated identity required'; end if;
  if length(p_client_id) not between 1 and 128 or p_request_fingerprint !~ '^[a-f0-9]{64}$' or length(p_content) not between 1 and 8000 then
    raise exception using errcode = '22023', message = 'invalid chat generation input';
  end if;
  if not exists(select 1 from public.conversations c where c.id = p_conversation_id and c.owner_id = v_owner) then
    raise exception using errcode = '42501', message = 'conversation ownership required';
  end if;
  insert into private.chat_generations(owner_id, conversation_id, client_id, request_fingerprint, user_message_id)
  values(v_owner, p_conversation_id, p_client_id, p_request_fingerprint, p_user_message_id)
  on conflict(owner_id, conversation_id, client_id) do nothing returning * into v_row;
  v_created := found;
  if v_created then
    insert into private.admission_counters(owner_id, bucket_start, admitted) values(v_owner, v_bucket, 0)
    on conflict do nothing;
    update private.admission_counters set admitted = admitted + 1
      where owner_id = v_owner and bucket_start = v_bucket and admitted < 5;
    if not found then raise exception using errcode = 'P0001', message = 'chat admission limit reached'; end if;
  else
    select * into v_row from private.chat_generations g where g.owner_id=v_owner and g.conversation_id=p_conversation_id and g.client_id=p_client_id for update;
    if v_row.request_fingerprint = p_request_fingerprint and v_row.state in ('failed','cancelled') then
      update private.chat_generations as generation set state='admitted',attempt=generation.attempt+1,updated_at=now()
        where generation.owner_id=v_owner and generation.conversation_id=p_conversation_id and generation.client_id=p_client_id
        returning * into v_row;
      v_created := found;
    end if;
  end if;
  if v_row.request_fingerprint <> p_request_fingerprint then
    raise exception using errcode = '23505', message = 'chat idempotency conflict';
  end if;
  if v_row.user_message_id = p_user_message_id and v_row.state = 'admitted' then
    insert into public.messages(id, conversation_id, author_id, role, content, client_id)
    values(p_user_message_id, p_conversation_id, v_owner, 'user', p_content, p_client_id)
    on conflict(conversation_id, client_id) do nothing;
  end if;
  update public.conversations set updated_at=now() where id=p_conversation_id and owner_id=v_owner;
  return query select case when v_row.state='completed' then 'completed' when v_created then 'admitted' else 'in_flight' end, v_row.assistant_message_id, v_row.attempt;
end;
$$;

create function public.complete_chat_generation(p_conversation_id uuid, p_client_id text, p_attempt integer, p_content text)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, private, auth
as $$
declare v_owner uuid; v_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  select owner_id,assistant_message_id into v_owner,v_id from private.chat_generations
    where conversation_id=p_conversation_id and client_id=p_client_id for update;
  if v_owner is null then raise exception using errcode='P0002', message='chat generation not found'; end if;
  update private.chat_generations set state='completed', updated_at=now()
  where owner_id=v_owner and conversation_id=p_conversation_id and client_id=p_client_id and attempt=p_attempt and state='admitted'
  returning assistant_message_id into v_id;
  if v_id is null then raise exception using errcode='40001', message='stale chat generation attempt'; end if;
  insert into public.messages(id, conversation_id, author_id, role, content, client_id)
  values(v_id,p_conversation_id,v_owner,'assistant',p_content,'assistant:'||p_client_id);
  update public.conversations set updated_at=now() where id=p_conversation_id and owner_id=v_owner;
  return v_id;
end;
$$;
create function public.fail_chat_generation(p_conversation_id uuid,p_client_id text,p_attempt integer,p_state text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  if p_state not in ('failed','cancelled') then raise exception using errcode='22023', message='invalid chat generation terminal state'; end if;
  update private.chat_generations set state=p_state,updated_at=now()
    where conversation_id=p_conversation_id and client_id=p_client_id and attempt=p_attempt and state='admitted';
  return found;
end;
$$;
revoke all on function public.admit_chat_generation(uuid,text,text,uuid,text) from public, anon;
revoke all on function public.complete_chat_generation(uuid,text,integer,text) from public, anon, authenticated;
revoke all on function public.fail_chat_generation(uuid,text,integer,text) from public, anon, authenticated;
grant execute on function public.admit_chat_generation(uuid,text,text,uuid,text) to authenticated;
grant execute on function public.complete_chat_generation(uuid,text,integer,text) to service_role;
grant execute on function public.fail_chat_generation(uuid,text,integer,text) to service_role;

create function public.admit_encode_job(p_job_id text,p_fixture text,p_preset text,p_idempotency_key text,p_fingerprint text,p_workflow_id text)
returns table(outcome text, job_id text) language plpgsql security definer
set search_path = pg_catalog, private, auth
as $$
declare v_owner uuid := auth.uid(); v_job private.jobs%rowtype; v_created boolean;
begin
  if v_owner is null then raise exception using errcode='42501', message='authenticated identity required'; end if;
  if p_fingerprint !~ '^[a-f0-9]{64}$' or p_fixture <> 'sample-v1' or p_preset <> 'demo-180p-v1' or length(p_idempotency_key) not between 1 and 100 then
    raise exception using errcode='22023', message='invalid encode job input';
  end if;
  insert into private.jobs(id,owner_id,fixture,preset,idempotency_key,request_fingerprint,workflow_id)
  values(p_job_id,v_owner,p_fixture,p_preset,p_idempotency_key,p_fingerprint,p_workflow_id)
  on conflict(owner_id,idempotency_key) do nothing returning * into v_job;
  v_created := found;
  if not v_created then select * into v_job from private.jobs j where j.owner_id=v_owner and j.idempotency_key=p_idempotency_key; end if;
  if v_job.request_fingerprint <> p_fingerprint then return query select 'idempotency_conflict'::text,v_job.id; return; end if;
  if not v_created then return query select 'replayed'::text,v_job.id; return; end if;
  insert into private.job_hourly_admissions(owner_id,bucket_start,admitted) values(v_owner,date_trunc('hour',now()),0) on conflict do nothing;
  update private.job_hourly_admissions set admitted=admitted+1 where owner_id=v_owner and bucket_start=date_trunc('hour',now()) and admitted<5;
  if not found then raise exception using errcode='P0002', message='hourly job admission quota reached'; end if;
  insert into private.job_daily_admissions(bucket_start,admitted) values((now() at time zone 'utc')::date,0) on conflict do nothing;
  update private.job_daily_admissions set admitted=admitted+1 where bucket_start=(now() at time zone 'utc')::date and admitted<50;
  if not found then raise exception using errcode='P0002', message='daily job admission quota reached'; end if;
  return query select case when v_job.id=p_job_id then 'created' else 'replayed' end,v_job.id;
exception when unique_violation or sqlstate 'P0002' then
  return query select 'quota_or_active_limit'::text, null::text;
end;
$$;

create function public.claim_encode_job(p_job_id text,p_attempt_id text,p_lease_seconds integer default 300)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare v_job private.jobs%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  select * into v_job from private.jobs where id=p_job_id for update;
  if not found or v_job.status in ('succeeded','failed') or v_job.attempt_count >= 3 then return false; end if;
  if v_job.status='running' and v_job.lease_expires_at > now() then return false; end if;
  if v_job.active_attempt_id is not null then update private.job_attempts set status='expired',completed_at=now() where id=v_job.active_attempt_id and status='running'; end if;
  update private.jobs set status='running',active_attempt_id=p_attempt_id,attempt_count=attempt_count+1,lease_expires_at=now()+make_interval(secs=>least(greatest(p_lease_seconds,1),300)),updated_at=now() where id=p_job_id;
  insert into private.job_attempts(id,job_id,attempt_number,status,lease_expires_at) values(p_attempt_id,p_job_id,v_job.attempt_count+1,'running',now()+make_interval(secs=>least(greatest(p_lease_seconds,1),300)));
  return true;
end;
$$;

create function public.finish_encode_job(p_job_id text,p_attempt_id text,p_output_key text,p_output_bytes bigint,p_sha256 text,p_format text,p_codec text,p_width integer,p_height integer,p_duration_ms integer)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  update private.jobs set status='succeeded',output_key=p_output_key,output_bytes=p_output_bytes,output_sha256=p_sha256,output_container_format=p_format,output_video_codec=p_codec,output_width=p_width,output_height=p_height,output_duration_ms=p_duration_ms,output_expires_at=now()+interval '24 hours',completed_at=now(),updated_at=now(),lease_expires_at=null
    where id=p_job_id and active_attempt_id=p_attempt_id and status='running';
  if not found then return false; end if;
  update private.job_attempts set status='succeeded',completed_at=now() where id=p_attempt_id and status='running';
  return true;
end;
$$;
create function public.record_job_dispatch(p_job_id text,p_dispatch_state text,p_error_code text default null)
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
  where id=p_job_id and status='pending' and dispatch_state in ('pending','dispatch_failed');
  return found;
end;
$$;
create function public.fail_encode_job(p_job_id text,p_attempt_id text,p_error_code text,p_retryable boolean)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare v_retry boolean;
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  update private.jobs set status=case when p_retryable and attempt_count<3 then 'pending' else 'failed' end,
    error_code=left(p_error_code,80),active_attempt_id=null,lease_expires_at=null,
    completed_at=case when not (p_retryable and attempt_count<3) then now() else null end,updated_at=now()
  where id=p_job_id and active_attempt_id=p_attempt_id and status='running' returning status='pending' into v_retry;
  if not found then return false; end if;
  update private.job_attempts set status='failed',error_code=left(p_error_code,80),completed_at=now()
  where id=p_attempt_id and status='running';
  return true;
end;
$$;
create function public.queue_expired_job_artifacts(p_cutoff timestamptz,p_limit integer default 100)
returns table(job_id text,output_key text) language plpgsql security definer
set search_path = pg_catalog, private
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  return query with selected as (
    select j.id,j.output_key,j.output_expires_at from private.jobs j
    where j.status='succeeded' and j.output_key is not null and j.output_expires_at<=p_cutoff
    order by j.output_expires_at,j.id for update skip locked limit least(greatest(p_limit,1),500)
  ), queued as (
    insert into private.job_artifact_retirements(job_id,output_key,cutoff_at)
    select s.id,s.output_key,s.output_expires_at from selected s
    on conflict on constraint job_artifact_retirements_pkey do update set runs=private.job_artifact_retirements.runs
    returning private.job_artifact_retirements.job_id,private.job_artifact_retirements.output_key
  ) select q.job_id,q.output_key from queued q;
end;
$$;
create function public.retire_job_artifact(p_job_id text,p_output_key text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  perform 1 from private.job_artifact_retirements where job_id=p_job_id and output_key=p_output_key for update;
  if not found then return false; end if;
  update private.jobs set output_key=null,output_bytes=null,output_sha256=null,updated_at=now() where id=p_job_id and output_key=p_output_key;
  if not found then return false; end if;
  delete from private.job_artifact_retirements where job_id=p_job_id and output_key=p_output_key;
  return true;
end;
$$;
create function public.begin_maintenance_run(p_run_key text,p_trigger text,p_slot text default null,p_scheduled_time timestamptz default null)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  if p_trigger not in ('scheduled','manual') or (p_trigger='scheduled' and (p_slot is null or p_scheduled_time is null)) then
    raise exception using errcode='22023', message='invalid maintenance identity';
  end if;
  insert into private.maintenance_runs(run_key,trigger,slot,scheduled_time) values(p_run_key,p_trigger,p_slot,p_scheduled_time) on conflict do nothing;
  return found;
end;
$$;
revoke all on function public.admit_encode_job(text,text,text,text,text,text) from public, anon;
revoke all on function public.claim_encode_job(text,text,integer) from public, anon, authenticated;
revoke all on function public.finish_encode_job(text,text,text,bigint,text,text,text,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.admit_encode_job(text,text,text,text,text,text) to authenticated;
grant execute on function public.claim_encode_job(text,text,integer) to service_role;
grant execute on function public.finish_encode_job(text,text,text,bigint,text,text,text,integer,integer,integer) to service_role;
revoke all on function public.record_job_dispatch(text,text,text), public.fail_encode_job(text,text,text,boolean), public.queue_expired_job_artifacts(timestamptz,integer), public.retire_job_artifact(text,text), public.begin_maintenance_run(text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.record_job_dispatch(text,text,text), public.fail_encode_job(text,text,text,boolean), public.queue_expired_job_artifacts(timestamptz,integer), public.retire_job_artifact(text,text), public.begin_maintenance_run(text,text,text,timestamptz) to service_role;
