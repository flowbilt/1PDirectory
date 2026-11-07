-- Confirms 47-light-dark.sql works. Run after 47: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 4 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Saves are tried as signed-in users (the shop's owner, and 1Point), as the menu editor does them.
do $$
declare
  u_admin uuid := gen_random_uuid();
  u_owner uuid := gen_random_uuid();
  v_org uuid; v_menu uuid; v_lay uuid; v_b text; r jsonb;
  fails text[] := '{}';
  v_when jsonb := '{"day": "light", "evening": "dark", "dayAt": "06:00", "eveningAt": "17:00", "sun": true}';
begin
  insert into public.organizations (name, kind) values ('Light dark test', 'samples') returning id into v_org;
  insert into auth.users (id, email) values (u_admin, 'lightdark-admin@example.com'), (u_owner, 'lightdark-owner@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values
    (u_admin, 'lightdark-admin@example.com', 'T Admin', 'platform_admin', null),
    (u_owner, 'lightdark-owner@example.com', 'T Owner', 'org_admin', v_org);
  insert into public.menus (org_id, name, spec, customer_edit) values (v_org, 'Light dark menu', '{"lists": []}', true) returning id into v_menu;
  insert into public.layouts (org_id, name, orientation, menu_id) values (v_org, 'Light dark board', 'landscape', v_menu) returning id into v_lay;
  v_b := v_lay::text;

  -- 1. The shop's owner picks Light, then Dark: kept
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 0, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"look": "light"}'::jsonb)));
  r := public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"look": "dark"}'::jsonb)));
  perform set_config('role', 'none', true);
  if (select content -> 'boards' -> v_b ->> 'look' from public.menus where id = v_menu) is distinct from 'dark' then fails := fails || '1 Dark not kept'::text; end if;

  -- 2. The owner sets the look by the time of day, with sunrise and sunset ticked: kept as sent
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 2, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, jsonb_build_object('when', v_when))));
  perform set_config('role', 'none', true);
  if (select content -> 'boards' -> v_b -> 'when' from public.menus where id = v_menu) is distinct from v_when then fails := fails || '2 the schedule not kept'::text; end if;

  -- 3. Only real schedules: the same look twice, the same time twice, a time that isn't one, an unknown look or part,
  --    a sunset that isn't ticked or not, an unknown look on its own
  perform set_config('role', 'authenticated', true);
  begin perform public.menu_save(v_menu, 3, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"when": {"day": "dark", "evening": "dark", "dayAt": "06:00", "eveningAt": "17:00"}}'::jsonb))); fails := fails || '3 the same look'::text;
  exception when check_violation then if sqlerrm not like '%different looks%' then fails := fails || format('3 message: %s', sqlerrm); end if; end;
  begin perform public.menu_save(v_menu, 3, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"when": {"day": "light", "evening": "dark", "dayAt": "17:00", "eveningAt": "17:00"}}'::jsonb))); fails := fails || '3 the same time'::text;
  exception when check_violation then null; end;
  begin perform public.menu_save(v_menu, 3, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"when": {"day": "light", "evening": "dark", "dayAt": "6 am", "eveningAt": "17:00"}}'::jsonb))); fails := fails || '3 6 am'::text;
  exception when check_violation then if sqlerrm not like '%times of day%' then fails := fails || format('3 time message: %s', sqlerrm); end if; end;
  begin perform public.menu_save(v_menu, 3, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"when": {"day": "light", "evening": "neon", "dayAt": "06:00", "eveningAt": "17:00"}}'::jsonb))); fails := fails || '3 neon'::text;
  exception when check_violation then null; end;
  begin perform public.menu_save(v_menu, 3, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"when": {"day": "light", "evening": "dark", "dayAt": "06:00", "eveningAt": "17:00", "days": [1]}}'::jsonb))); fails := fails || '3 days'::text;
  exception when check_violation then null; end;
  begin perform public.menu_save(v_menu, 3, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"when": {"day": "light", "evening": "dark", "dayAt": "06:00", "eveningAt": "17:00", "sun": "yes"}}'::jsonb))); fails := fails || '3 sun yes'::text;
  exception when check_violation then null; end;
  begin perform public.menu_save(v_menu, 3, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"look": "neon"}'::jsonb))); fails := fails || '3 a look'::text;
  exception when check_violation then if sqlerrm not like '%Light or Dark%' then fails := fails || format('3 look message: %s', sqlerrm); end if; end;
  perform set_config('role', 'none', true);
  if (select content -> 'boards' -> v_b -> 'when' from public.menus where id = v_menu) is distinct from v_when then fails := fails || '3 a refused save changed it'::text; end if;

  -- 4. 1Point's save with the board's sizes keeps the shop's schedule beside them; House and Chalkboard still work
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 3, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, jsonb_build_object('when', v_when, 'sizes', '{"qr": "m"}'::jsonb))));
  r := public.menu_save(v_menu, 4, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, jsonb_build_object('when', v_when, 'sizes', '{"qr": "m"}'::jsonb), gen_random_uuid()::text, '{"look": "chalkboard", "when": {"day": "house", "evening": "chalkboard", "dayAt": "07:00", "eveningAt": "18:30"}}'::jsonb)));
  perform set_config('role', 'none', true);
  if (select content -> 'boards' -> v_b from public.menus where id = v_menu) is distinct from jsonb_build_object('when', v_when, 'sizes', '{"qr": "m"}'::jsonb) then fails := fails || '4 the schedule beside the sizes'::text; end if;
  if (select (select count(*) from jsonb_object_keys(content -> 'boards')) from public.menus where id = v_menu) <> 2 then fails := fails || '4 House by day, Chalkboard in the evening'::text; end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 4 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
