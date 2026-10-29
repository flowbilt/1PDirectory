-- Confirms 33-menu-specials.sql works. Run after 33: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 7 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Setting lists up and saving are tried as signed-in users, as the console and the menu editor do it.
do $$
declare
  u_admin  uuid := gen_random_uuid();
  u_owner  uuid := gen_random_uuid();
  v_org    uuid;
  v_org2   uuid;
  v_menu   uuid;
  v_lay    uuid;
  v_lay2   uuid;
  v_rev    integer;
  r        jsonb;
  v_spec   jsonb := '{"lists": [
    {"key": "specials", "name": "Specials", "kind": "items", "room": 2, "fields": ["name", "price"], "schedule": true},
    {"key": "drinks", "name": "Drinks", "kind": "items", "room": 4, "fields": ["name"]}]}';
  fails    text[] := '{}';
begin
  insert into public.organizations (name) values ('Specials test shop') returning id into v_org;
  insert into public.organizations (name) values ('Specials test stranger') returning id into v_org2;
  insert into auth.users (id, email) values (u_admin, 'specials-admin@example.com'), (u_owner, 'specials-owner@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values
    (u_admin, 'specials-admin@example.com', 'Specials Admin', 'platform_admin', null),
    (u_owner, 'specials-owner@example.com', 'Specials Owner', 'org_admin', v_org);

  -- 1. 1Point sets up a scheduled list (signed in); "schedule" on an hours list is refused
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  insert into public.menus (org_id, name, spec) values (v_org, 'Specials test menu', v_spec) returning id into v_menu;
  begin
    update public.menus set spec = '{"lists": [{"key": "h", "name": "Hours", "kind": "hours", "room": 2, "schedule": true}]}' where id = v_menu;
    fails := fails || '1 schedule on an hours list'::text;
  exception when check_violation then if sqlerrm not like '%"schedule" is true or false, on an items or text list%' then fails := fails || format('1 message: %s', sqlerrm); end if;
  end;
  perform set_config('role', 'none', true);

  -- 2. The owner saves specials with dates, days and times; when on a list without dates is refused, saying WayTuGo
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 0, '{"lists": {"specials": {"entries": [
        {"id": "sp0001", "name": "Lunch combo", "price": "$8.99", "when": {"days": [1,2,3,4,5], "from": "11:00", "to": "14:00"}},
        {"id": "sp0002", "name": "Pumpkin donut", "when": {"dates": {"from": "2026-09-15", "to": "2026-11-30"}}}]}}}');
  if (r ->> 'rev')::int <> 1 then fails := fails || format('2 save %s', r); end if;
  begin
    perform public.menu_save(v_menu, 1, '{"lists": {"drinks": {"entries": [{"id": "dr0001", "name": "Latte", "when": {"days": [1]}}]}}}');
    fails := fails || '2 when on a list without dates'::text;
  exception when check_violation then if sqlerrm not like '%no dates or times (WayTuGo can switch them on)%' then fails := fails || format('2 message: %s', sqlerrm); end if;
  end;

  -- 3. A when that makes no sense is refused in plain words
  begin
    perform public.menu_save(v_menu, 1, '{"lists": {"specials": {"entries": [{"id": "sp0001", "name": "A", "when": {"dates": {"from": "2026-12-01", "to": "2026-11-01"}}}]}}}');
    fails := fails || '3 dates backwards'::text;
  exception when check_violation then null;
  end;
  begin
    perform public.menu_save(v_menu, 1, '{"lists": {"specials": {"entries": [{"id": "sp0001", "name": "A", "when": {"from": "11:00", "to": "11:00"}}]}}}');
    fails := fails || '3 the same times'::text;
  exception when check_violation then null;
  end;
  begin
    perform public.menu_save(v_menu, 1, '{"lists": {"specials": {"entries": [{"id": "sp0001", "name": "A", "when": {"days": []}}]}}}');
    fails := fails || '3 no days'::text;
  exception when check_violation then null;
  end;
  begin
    perform public.menu_save(v_menu, 1, '{"lists": {"specials": {"entries": [{"id": "sp0001", "name": "A", "when": {"weeks": 2}}]}}}');
    fails := fails || '3 an unknown part'::text;
  exception when check_violation then null;
  end;

  -- 4. A special waiting for its dates uses up room; past the room, the message says WayTuGo
  begin
    perform public.menu_save(v_menu, 1, '{"lists": {"specials": {"entries": [
        {"id": "sp0001", "name": "A"}, {"id": "sp0002", "name": "B", "when": {"dates": {"from": "2099-01-01"}}}, {"id": "sp0003", "name": "C"}]}}}');
    fails := fails || '4 past the room'::text;
  exception when check_violation then if sqlerrm not like '%has room for 2; this has 3. More room is a menu expansion: ask WayTuGo.%' then fails := fails || format('4 message: %s', sqlerrm); end if;
  end;
  perform set_config('role', 'none', true);

  -- 5. Customer editing off: the message says WayTuGo
  update public.menus set customer_edit = false where id = v_menu;
  perform set_config('role', 'authenticated', true);
  begin
    perform public.menu_save(v_menu, 1, '{"lists": {}}');
    fails := fails || '5 saved with customer editing off'::text;
  exception when insufficient_privilege then if sqlerrm <> 'WayTuGo keeps this menu up to date for you. Contact WayTuGo for changes.' then fails := fails || format('5 message: %s', sqlerrm); end if;
  end;
  perform set_config('role', 'none', true);
  update public.menus set customer_edit = true where id = v_menu;

  -- 6. More lists on the menu (the site, for 1Point): added with their entries, a revision by 1Point, the layout pointed
  --    at the menu; a key already there, or a layout from another account, is refused
  insert into public.layouts (org_id, name, orientation) values (v_org, 'Specials test chalkboard', 'portrait') returning id into v_lay;
  insert into public.layouts (org_id, name, orientation) values (v_org2, 'Specials test stranger board', 'portrait') returning id into v_lay2;
  v_rev := public.menu_add_lists(v_menu, '[{"key": "board-special", "name": "Board special", "kind": "text", "room": 1, "fields": ["title", "body"]}]',
                                 '{"board-special": {"entries": [{"id": "bs0001", "title": "Today only"}]}}', u_admin, v_lay, '{"format": 1}');
  if v_rev <> 2 or (select menu_id from public.layouts where id = v_lay) is distinct from v_menu
     or (select content -> 'lists' -> 'board-special' -> 'entries' -> 0 ->> 'title' from public.menus where id = v_menu) <> 'Today only'
     or (select content -> 'lists' -> 'specials' -> 'entries' -> 0 ->> 'name' from public.menus where id = v_menu) <> 'Lunch combo'
     or not (select by_1point from public.menu_revisions where menu_id = v_menu and rev = 2) then
    fails := fails || format('6 adding lists (revision %s)', v_rev);
  end if;
  begin
    perform public.menu_add_lists(v_menu, '[{"key": "drinks", "name": "Again", "kind": "items", "room": 2, "fields": ["name"]}]', '{}', u_admin, null, null);
    fails := fails || '6 a key already on the menu'::text;
  exception when check_violation then null;
  end;
  begin
    perform public.menu_add_lists(v_menu, '[{"key": "other", "name": "Other", "kind": "items", "room": 2, "fields": ["name"]}]', '{}', u_admin, v_lay2, null);
    fails := fails || '6 another account''s layout'::text;
  exception when no_data_found then null;
  end;

  -- 7. Permissions: adding lists is the site's only
  if has_function_privilege('authenticated', 'public.menu_add_lists(uuid, jsonb, jsonb, uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.menu_add_lists(uuid, jsonb, jsonb, uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.menu_write(uuid, integer, jsonb, integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.menu_save(uuid, integer, jsonb)', 'execute') then
    fails := fails || '7 permissions'::text;
  end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 7 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
