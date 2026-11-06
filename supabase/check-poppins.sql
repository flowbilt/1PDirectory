-- Confirms 43-poppins.sql works. Run after 43: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 2 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Saves are tried as a signed-in 1Point user, as the menu editor's Brand panel does them.
do $$
declare
  u_admin uuid := gen_random_uuid();
  v_org uuid; v_menu uuid; r jsonb;
  v_spec jsonb := '{"lists": [{"key": "shop", "name": "In the Gift Shop", "kind": "items", "room": 6, "fields": ["name"]}]}';
  fails text[] := '{}';
begin
  insert into public.organizations (name, kind) values ('Poppins test samples', 'samples') returning id into v_org;
  insert into auth.users (id, email) values (u_admin, 'poppins-admin@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values (u_admin, 'poppins-admin@example.com', 'Poppins Admin', 'platform_admin', null);
  insert into public.menus (org_id, name, spec, customer_edit) values (v_org, 'Poppins test menu', v_spec, true) returning id into v_menu;
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);

  -- 1. A brand in Poppins is kept
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 0, '{"lists": {"shop": {"entries": [{"id": "pp0001", "name": "Pottery"}]}}, "brand": {"name": "Gibbs Garden Center", "fonts": {"display": "Poppins", "body": "Instrument Sans"}}}'::jsonb);
  perform set_config('role', 'none', true);
  if (select content #>> '{brand,fonts,display}' from public.menus where id = v_menu) is distinct from 'Poppins' then fails := fails || '1 Poppins not kept'::text; end if;

  -- 2. A font that isn't WayTuGo's is still refused
  perform set_config('role', 'authenticated', true);
  begin
    r := public.menu_save(v_menu, 1, '{"lists": {"shop": {"entries": [{"id": "pp0001", "name": "Pottery"}]}}, "brand": {"fonts": {"display": "Comic Sans MS"}}}'::jsonb);
    fails := fails || '2 Comic Sans MS saved'::text;
  exception when check_violation then if sqlerrm not like '%isn''t one of WayTuGo''s fonts%' then fails := fails || format('2 message: %s', sqlerrm); end if;
  end;
  perform set_config('role', 'none', true);

  if array_length(fails, 1) is null then
    raise exception 'ALL 2 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
