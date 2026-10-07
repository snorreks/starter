-- Count every issued retirement attempt, including validation and R2 refusals.
-- Fresh rows take priority so an unchanged refusal cannot monopolize the batch.
create or replace function public.queue_expired_job_artifacts(p_cutoff timestamptz,p_limit integer default 100)
returns table(job_id text,output_key text) language plpgsql security definer
set search_path = pg_catalog, private
as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode='42501', message='service role required'; end if;
  return query with selected as (
    select j.id,j.output_key,j.output_expires_at from private.jobs j
    left join private.job_artifact_retirements r on r.job_id=j.id
    where j.status='succeeded' and j.output_key is not null and j.output_expires_at<=p_cutoff
    order by coalesce(r.runs,0),j.output_expires_at,j.id for update of j skip locked limit least(greatest(p_limit,1),500)
  ), queued as (
    insert into private.job_artifact_retirements(job_id,output_key,cutoff_at,runs)
    select s.id,s.output_key,s.output_expires_at,1 from selected s
    on conflict on constraint job_artifact_retirements_pkey do update set runs=private.job_artifact_retirements.runs+1
    returning private.job_artifact_retirements.job_id,private.job_artifact_retirements.output_key
  ) select q.job_id,q.output_key from queued q;
end;
$$;

create or replace function public.get_encode_job(p_job_id text)
returns jsonb language sql stable security definer
set search_path = pg_catalog, private, auth
as $$
  select jsonb_build_object(
    'id', j.id,
    'kind', j.kind,
    'status', j.status,
    'dispatchState', j.dispatch_state,
    'createdAt', extract(epoch from j.created_at) * 1000,
    'updatedAt', extract(epoch from j.updated_at) * 1000,
    'outputAvailable', j.status = 'succeeded' and j.output_key is not null and j.output_expires_at > now(),
    'errorCode', j.error_code
  )
  from private.jobs j
  where j.id = p_job_id and j.owner_id = auth.uid()
$$;

create or replace function public.list_encode_jobs()
returns jsonb language sql stable security definer
set search_path = pg_catalog, private, auth
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id,
    'kind', page.kind,
    'status', page.status,
    'dispatchState', page.dispatch_state,
    'createdAt', extract(epoch from page.created_at) * 1000,
    'updatedAt', extract(epoch from page.updated_at) * 1000,
    'outputAvailable', page.status = 'succeeded' and page.output_key is not null and page.output_expires_at > now(),
    'errorCode', page.error_code
  ) order by page.created_at desc, page.id desc), '[]'::jsonb)
  from (
    select * from private.jobs
    where owner_id = auth.uid()
    order by created_at desc, id desc
    limit 100
  ) page
$$;

