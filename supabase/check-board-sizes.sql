-- Confirms 39-board-sizes.sql works. Run after 39: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 5 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Saves and Restore are tried as signed-in users (1Point, and the shop's owner), as the menu editor does them.
do $$
declare
  u_admin uuid := gen_random_uuid();
  u_owner uuid := gen_random_uuid();
  v_org uuid; v_menu uuid; v_lay uuid; v_b text; r jsonb;
  v_spec jsonb := '{"lists": [{"key": "coffee", "name": "Coffee", "kind": "items", "room": 6, "fields": ["name", "price"]}]}';
  fails text[] := '{}';
begin
  insert into public.organizations (name, kind) values ('Sizes test', 'samples') returning id into v_org;
  insert into auth.users (id, email) values (u_admin, 'sizes-admin@example.com'), (u_owner, 'sizes-owner@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values
    (u_admin, 'sizes-admin@example.com', 'Sizes Admin', 'platform_admin', null),
    (u_owner, 'sizes-owner@example.com', 'Sizes Owner', 'org_admin', v_org);
  insert into public.menus (org_id, name, spec, customer_edit) values (v_org, 'Sizes test menu', v_spec, true) returning id into v_menu;
  insert into public.layouts (org_id, name, orientation, menu_id) values (v_org, 'Sizes test board', 'landscape', v_menu) returning id into v_lay;
  v_b := v_lay::text;

  -- 1. 1Point (signed in) sets the board's sizes with its look: kept
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 0, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"look": "house", "sizes": {"qr": "s", "logo": 80}}'::jsonb)));
  perform set_config('role', 'none', true);
  if (select content -> 'boards' -> v_b -> 'sizes' from public.menus where id = v_menu) is distinct from '{"qr": "s", "logo": 80}'::jsonb then fails := fails || '1 not kept'::text; end if;

  -- 2. Only the presets: a QR size, a logo past 100 or under 60 or not whole, an unknown size
  perform set_config('role', 'authenticated', true);
  begin perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"sizes": {"qr": "xl"}}'::jsonb))); fails := fails || '2 qr'::text;
  exception when check_violation then if sqlerrm not like '%Small, Medium or Large%' then fails := fails || format('2 message: %s', sqlerrm); end if; end;
  begin perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"sizes": {"logo": 120}}'::jsonb))); fails := fails || '2 logo 120'::text;
  exception when check_violation then null; end;
  begin perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"sizes": {"logo": 50}}'::jsonb))); fails := fails || '2 logo 50'::text;
  exception when check_violation then null; end;
  begin perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"sizes": {"logo": 75.5}}'::jsonb))); fails := fails || '2 logo 75.5'::text;
  exception when check_violation then null; end;
  begin perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"sizes": {"clock": 80}}'::jsonb))); fails := fails || '2 clock'::text;
  exception when check_violation then null; end;
  perform set_config('role', 'none', true);

  -- 3. The owner changes the look (theirs) and tries the sizes (1Point's): the look changes, the sizes stay
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"look": "chalkboard", "sizes": {"qr": "l", "logo": 100}}'::jsonb)));
  perform set_config('role', 'none', true);
  if (select content -> 'boards' -> v_b ->> 'look' from public.menus where id = v_menu) is distinct from 'chalkboard'
     or (select content -> 'boards' -> v_b -> 'sizes' from public.menus where id = v_menu) is distinct from '{"qr": "s", "logo": 80}'::jsonb then
    fails := fails || format('3 %s', (select content -> 'boards' from public.menus where id = v_menu));
  end if;
  -- Back to WayTuGo's design (the owner's board entry removed): the sizes stay
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 2, '{"lists": {}}');
  perform set_config('role', 'none', true);
  if (select content -> 'boards' -> v_b from public.menus where id = v_menu) is distinct from '{"sizes": {"qr": "s", "logo": 80}}'::jsonb then
    fails := fails || format('3 reset %s', (select content -> 'boards' from public.menus where id = v_menu));
  end if;

  -- 4. 1Point changes them; the owner's Restore of the first save keeps 1Point's latest
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 3, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"sizes": {"qr": "m"}}'::jsonb)));
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  r := public.menu_restore(v_menu, 1, 4);
  perform set_config('role', 'none', true);
  if (select content -> 'boards' -> v_b -> 'sizes' from public.menus where id = v_menu) is distinct from '{"qr": "m"}'::jsonb
     or (select content -> 'boards' -> v_b ->> 'look' from public.menus where id = v_menu) is distinct from 'house' then
    fails := fails || format('4 restore %s', (select content -> 'boards' from public.menus where id = v_menu));
  end if;

  -- 5. The rules are the database's own
  if has_function_privilege('authenticated', 'public.menu_board_problem(jsonb)', 'execute') then fails := fails || '5 permissions'::text; end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 5 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
