begin;
select plan(5);

select set_config('test.owner_a', (select id::text from auth.users where email='supabase-a@example.test'), true);
select set_config('test.owner_b', (select id::text from auth.users where email='supabase-b@example.test'), true);
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.owner_a'), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.owner_a'), 'role', 'authenticated')::text, true);

select is((select count(*)::int from public.notes where title='Private to B'), 0, 'A cannot read B note through SQL under authenticated role');
update public.notes set title='A changed B' where title='Private to B';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.owner_b'), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.owner_b'), 'role', 'authenticated')::text, true);
select is((select title from public.notes where title='Private to B' limit 1), 'Private to B', 'A cannot update B note');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.owner_a'), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.owner_a'), 'role', 'authenticated')::text, true);
delete from public.notes where title='Private to B';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.owner_b'), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.owner_b'), 'role', 'authenticated')::text, true);
select is((select count(*)::int from public.notes where title='Private to B'), 1, 'A cannot delete B note');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.owner_a'), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.owner_a'), 'role', 'authenticated')::text, true);
select throws_ok(
  format('insert into public.notes(owner_id,title,body) values (%L::uuid, %L, %L)', current_setting('test.owner_b'), 'spoofed SQL note', ''),
  '42501', null, 'A cannot supply B as owner'
);
reset role;
set local role anon;
select throws_ok('select count(*) from public.notes', '42501', null, 'anonymous role cannot read notes');
reset role;
select * from finish();
rollback;
