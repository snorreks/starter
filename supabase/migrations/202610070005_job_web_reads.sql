create function public.get_encode_job(p_job_id text)
returns jsonb language sql stable security definer
set search_path = pg_catalog, private, auth
as $$
  select jsonb_build_object(
    'id', j.id,
    'kind', j.kind,
    'status', j.status,
    'createdAt', extract(epoch from j.created_at) * 1000,
    'updatedAt', extract(epoch from j.updated_at) * 1000,
    'outputAvailable', j.status = 'succeeded' and j.output_key is not null and j.output_expires_at > now(),
    'errorCode', j.error_code
  )
  from private.jobs j
  where j.id = p_job_id and j.owner_id = auth.uid()
$$;

create function public.list_encode_jobs()
returns jsonb language sql stable security definer
set search_path = pg_catalog, private, auth
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id,
    'kind', page.kind,
    'status', page.status,
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

revoke all on function public.get_encode_job(text), public.list_encode_jobs() from public, anon;
grant execute on function public.get_encode_job(text), public.list_encode_jobs() to authenticated;
