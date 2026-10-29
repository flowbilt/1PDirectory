-- Confirms 35-board-looks.sql works. Run after 35: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 7 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Saving a board's look is tried as a signed-in user, as the menu editor does it.
do $$
declare
  u_admin  uuid := gen_random_uuid();
  u_owner  uuid := gen_random_uuid();
  v_org    uuid;
  v_menu   uuid;
  v_lay    uuid;
  r        jsonb;
  v_board  text;
  v_spec   jsonb := '{"lists": [{"key": "specials", "name": "Today''s specials", "kind": "items", "room": 6, "fields": ["name", "price"]}]}';
  fails    text[] := '{}';
begin
  insert into public.organizations (name) values ('Board look test shop') returning id into v_org;
  insert into auth.users (id, email) values (u_admin, 'look-admin@example.com'), (u_owner, 'look-owner@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values
    (u_admin, 'look-admin@example.com', 'Look Admin', 'platform_admin', null),
    (u_owner, 'look-owner@example.com', 'Look Owner', 'org_admin', v_org);
  insert into public.menus (org_id, name, spec) values (v_org, 'Board look test menu', v_spec) returning id into v_menu;
  insert into public.layouts (org_id, name, orientation, menu_id) values (v_org, 'Board look test chalkboard', 'portrait', v_menu) returning id into v_lay;
  v_board := v_lay::text;

  -- 1. The owner (signed in) saves a board's look with the lists; it's kept as sent
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 0, jsonb_build_object('lists', '{"specials": {"entries": [{"id": "sp0001", "name": "Maple Bacon", "price": "$1.89"}]}}'::jsonb,
         'boards', jsonb_build_object(v_board, '{"look": "chalkboard", "chalk": {"titles": "green", "prices": "orange", "accents": "white"}, "lettering": "hand", "frame": true, "options": {"coffee-bar": true}}'::jsonb)));
  if (r ->> 'rev')::int <> 1 then fails := fails || format('1 save %s', r); end if;
  perform set_config('role', 'none', true);
  if (select content -> 'boards' -> v_board ->> 'look' from public.menus where id = v_menu) is distinct from 'chalkboard'
     or (select content -> 'boards' -> v_board -> 'options' ->> 'coffee-bar' from public.menus where id = v_menu) is distinct from 'true'
     or (select content -> 'lists' -> 'specials' -> 'entries' -> 0 ->> 'name' from public.menus where id = v_menu) is distinct from 'Maple Bacon' then
    fails := fails || '1 not kept as sent'::text;
  end if;

  -- 2. Only the presets: a colour that isn't one of the six, a look, a lettering, a frame that isn't on or off, an unknown part
  perform set_config('role', 'authenticated', true);
  begin
    perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_board, '{"chalk": {"titles": "#ff0000"}}'::jsonb)));
    fails := fails || '2 a colour of its own'::text;
  exception when check_violation then if sqlerrm not like '%Board look: Each chalk colour is white, yellow, pink, blue, green or orange.%' then fails := fails || format('2 message: %s', sqlerrm); end if;
  end;
  begin
    perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_board, '{"look": "neon"}'::jsonb)));
    fails := fails || '2 a look'::text;
  exception when check_violation then null;
  end;
  begin
    perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_board, '{"lettering": "comic"}'::jsonb)));
    fails := fails || '2 a lettering'::text;
  exception when check_violation then null;
  end;
  begin
    perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_board, '{"frame": "yes"}'::jsonb)));
    fails := fails || '2 a frame'::text;
  exception when check_violation then null;
  end;
  begin
    perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_board, '{"background": "red"}'::jsonb)));
    fails := fails || '2 an unknown part'::text;
  exception when check_violation then null;
  end;

  -- 3. A board is named by its layout's id; a menu still can't say anything else
  begin
    perform public.menu_save(v_menu, 1, '{"lists": {}, "boards": {"chalkboard": {"look": "house"}}}');
    fails := fails || '3 a board not named by an id'::text;
  exception when check_violation then null;
  end;
  begin
    perform public.menu_save(v_menu, 1, '{"lists": {}, "theme": {}}');
    fails := fails || '3 something else on the menu'::text;
  exception when check_violation then null;
  end;

  -- 4. The lists' own rules still hold (33's): past the room, the WayTuGo line
  begin
    perform public.menu_save(v_menu, 1, '{"lists": {"specials": {"entries": [{"id": "a0001", "name": "1"}, {"id": "a0002", "name": "2"}, {"id": "a0003", "name": "3"},
       {"id": "a0004", "name": "4"}, {"id": "a0005", "name": "5"}, {"id": "a0006", "name": "6"}, {"id": "a0007", "name": "7"}]}}}');
    fails := fails || '4 past the room'::text;
  exception when check_violation then if sqlerrm not like '%More room is a menu expansion: ask WayTuGo.%' then fails := fails || format('4 message: %s', sqlerrm); end if;
  end;

  -- 5. Restore keeps the boards' looks (the owner saves House, then restores the chalkboard save)
  r := public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_board, '{"look": "house"}'::jsonb)));
  r := public.menu_restore(v_menu, 1, 2);
  perform set_config('role', 'none', true);
  if (select content -> 'boards' -> v_board ->> 'look' from public.menus where id = v_menu) is distinct from 'chalkboard' then
    fails := fails || format('5 restore lost the look (%s)', (select content from public.menus where id = v_menu));
  end if;

  -- 6. Add lists from this layout (the site, for 1Point) keeps them too
  perform public.menu_add_lists(v_menu, '[{"key": "note", "name": "Chalk note", "kind": "text", "room": 1, "fields": ["title"]}]',
                                '{"note": {"entries": [{"id": "nt0001", "title": "Happy Friday!"}]}}', u_admin, v_lay, null);
  if (select content -> 'boards' -> v_board ->> 'lettering' from public.menus where id = v_menu) is distinct from 'hand'
     or (select content -> 'lists' -> 'note' -> 'entries' -> 0 ->> 'title' from public.menus where id = v_menu) is distinct from 'Happy Friday!' then
    fails := fails || '6 adding lists lost the look'::text;
  end if;

  -- 7. The look is on the menu the screens read (screen_state sends the whole content), and the checks are the database's own
  if not exists (select 1 from public.menus m where m.id = v_menu and m.content -> 'boards' ? v_board) then fails := fails || '7 no boards'::text; end if;
  if has_function_privilege('authenticated', 'public.menu_board_problem(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.menu_lists_problem(jsonb, jsonb, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.menu_content_problem(jsonb, jsonb, uuid)', 'execute') then
    fails := fails || '7 permissions'::text;
  end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 7 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
