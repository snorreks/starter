-- Readiness exercises Postgres without reading application data.
create function public.readiness_probe()
returns integer
language sql stable security invoker
set search_path = pg_catalog
set statement_timeout = '1s'
as $$ select 1; $$;
revoke all on function public.readiness_probe() from public;
grant execute on function public.readiness_probe() to anon, authenticated, service_role;
