-- Confirms 27-new-directory.sql works. Run after 27: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 5 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Unlike most checks, this one adds its rows as signed-in users (as the console does), because that's what broke.
do $$
declare
  u_admin  uuid := gen_random_uuid();
  u_owner  uuid := gen_random_uuid();
  v_org    uuid;
  v_prop   uuid;
  v_code   text;
  v_n      integer := (select count(*) from public.directories);
  v_codes  text := (select md5(string_agg(id::text || togo_code, ',' order by id)) from public.directories);
  fails    text[] := '{}';
begin
  insert into public.organizations (name) values ('New directory test owner') returning id into v_org;
  insert into public.properties (org_id, name) values (v_org, 'New directory test building') returning id into v_prop;
  insert into auth.users (id, email) values (u_admin, 'newdir-admin@example.com'), (u_owner, 'newdir-owner@example.com');
  insert into public.profiles (user_id, email, role, org_id) values (u_admin, 'newdir-admin@example.com', 'platform_admin', null),
                                                                    (u_owner, 'newdir-owner@example.com', 'org_admin', v_org);

  -- 1. A 1Point admin, signed in, adds a directory (what the console does), and it gets a well-formed code
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    insert into public.directories (property_id, title, slug) values (v_prop, 'New directory test', 'newdir-test-1') returning togo_code into v_code;
    if v_code !~ '^[A-HJKMNP-Z2-9]{6}$' then fails := fails || format('1 code %s', v_code); end if;
  exception when others then
    fails := fails || format('1 a 1Point admin could not add a directory: %s', sqlerrm);
  end;

  -- 2. A second one gets a different code
  begin
    insert into public.directories (property_id, title, slug) values (v_prop, 'New directory test 2', 'newdir-test-2');
    if (select count(distinct togo_code) from public.directories where slug like 'newdir-test-%') <> 2 then fails := fails || '2 same code twice'::text; end if;
  exception when others then
    fails := fails || format('2 %s', sqlerrm);
  end;

  -- 3. An owner still can't add a directory (only 1Point can, as before)
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  begin
    insert into public.directories (property_id, title, slug) values (v_prop, 'Owner try', 'newdir-test-owner');
    fails := fails || '3 an owner added a directory'::text;
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);

  -- 4. Existing directories and their codes are untouched
  if (select md5(string_agg(id::text || togo_code, ',' order by id)) from public.directories where slug not like 'newdir-test-%') is distinct from v_codes
     or (select count(*) from public.directories where slug not like 'newdir-test-%') <> v_n then
    fails := fails || '4 existing codes changed'::text;
  end if;

  -- 5. The code maker stays private, and there's no default left to call it as the user
  if has_function_privilege('authenticated', 'public.togo_new_code_value()', 'execute')
     or to_regprocedure('public.directories_togo_new()') is null
     or coalesce(has_function_privilege('authenticated', to_regprocedure('public.directories_togo_new()'), 'execute'), false)
     or (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'directories' and column_name = 'togo_code') is not null then
    fails := fails || '5 permissions or default'::text;
  end if;

  if cardinality(fails) = 0 then
    raise exception 'ALL 5 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else
    raise exception 'FAILED: %', array_to_string(fails, ' || ');
  end if;
end $$;
