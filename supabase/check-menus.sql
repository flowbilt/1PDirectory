-- Confirms 32-menus.sql works. Run after 32: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 10 CHECKS PASSED"  means everything works.
--   "FAILED: ..."           lists what didn't. Copy the whole message to Claude.
-- Making a menu, saving, restoring and every refusal are tried as signed-in users, as the console and the menu
-- editor do it (DP-09's lesson), not only from the SQL Editor.
do $$
declare
  u_admin  uuid := gen_random_uuid();
  u_owner  uuid := gen_random_uuid();
  u_editor uuid := gen_random_uuid();
  u_other  uuid := gen_random_uuid();
  v_org    uuid;
  v_org2   uuid;
  v_prop   uuid;
  v_menu   uuid;
  v_menu2  uuid;
  v_lay    uuid;
  v_pic    uuid;
  v_n      integer;
  v_msg    text;
  v_etag   text;
  r        jsonb;
  v_spec   jsonb := '{"lists": [
    {"key": "donuts", "name": "Donuts", "kind": "items", "room": 3, "fields": ["name", "price", "image", "tags"], "caps": {"name": 20}, "groupPrice": true},
    {"key": "hours", "name": "Hours", "kind": "hours", "room": 2, "note": true},
    {"key": "party", "name": "Party box", "kind": "text", "fields": ["title", "body"]}]}';
  c1       jsonb := '{"lists": {"donuts": {"price": "$1.89 each", "entries": [{"id": "aaaa01", "name": "Maple Bacon", "tags": ["favorite"]}, {"id": "aaaa02", "name": "Glazed"}]},
                                "hours": {"note": "Exit 242", "entries": [{"id": "hhhh01", "days": [2,3,4,5,6], "open": "06:00", "close": "18:00"}]}}}';
  c2       jsonb := '{"lists": {"donuts": {"price": "$1.99 each", "entries": [{"id": "aaaa01", "name": "Maple Bacon", "soldOut": "2026-10-29"}, {"id": "aaaa02", "name": "Glazed", "hidden": true}, {"id": "aaaa03", "name": "Red Velvet", "image": "img:menus-check"}]}}}';
  doc      jsonb := '{"format":1,"orientation":"landscape","grid":{"cols":12,"rows":12},"blocks":[{"id":"donuts","type":"items","at":{"col":1,"row":1,"w":6,"h":6},"content":{"heading":"Donuts","list":"donuts"}}]}';
  fails    text[] := '{}';
begin
  insert into public.organizations (name) values ('Menus test shop') returning id into v_org;
  insert into public.organizations (name) values ('Menus test stranger') returning id into v_org2;
  insert into public.properties (org_id, name, timezone) values (v_org, 'Menus test shop', 'America/Chicago') returning id into v_prop;
  insert into auth.users (id, email) values (u_admin, 'menus-admin@example.com'), (u_owner, 'menus-owner@example.com'),
                                            (u_editor, 'menus-editor@example.com'), (u_other, 'menus-other@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values
    (u_admin, 'menus-admin@example.com', 'Menus Admin', 'platform_admin', null),
    (u_owner, 'menus-owner@example.com', 'Menus Owner', 'org_admin', v_org),
    (u_editor, 'menus-editor@example.com', 'Menus Editor', 'org_editor', v_org),
    (u_other, 'menus-other@example.com', 'Menus Stranger', 'org_admin', v_org2);
  insert into public.layout_images (org_id, key, name, path, mime, width, height, bytes)
    values (v_org, 'menus-check', 'Menus check', v_org || '/menus-check-1a2b3c4d.webp', 'image/webp', 800, 600, 90000) returning id into v_pic;
  insert into public.layout_images (org_id, key, name, path, mime, width, height, bytes)
    values (v_org2, 'stranger-pic', 'Not theirs', v_org2 || '/stranger-pic-1a2b3c4d.webp', 'image/webp', 800, 600, 90000);

  -- 1. 1Point makes a menu (signed in): customer editing on, no saves yet. An owner can't make one.
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  insert into public.menus (org_id, name, spec) values (v_org, 'Menus test menu', v_spec) returning id into v_menu;
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  begin
    insert into public.menus (org_id, name, spec) values (v_org, 'Owner''s own', v_spec);
    fails := fails || '1 an owner made a menu'::text;
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'none', true);
  if (select customer_edit from public.menus where id = v_menu) is not true or (select rev from public.menus where id = v_menu) <> 0 then
    fails := fails || '1 the defaults'::text;
  end if;

  -- 2. Lists set up wrongly are refused in plain words
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    update public.menus set spec = '{"lists": [{"key": "x", "name": "X", "kind": "items", "room": 61, "fields": ["name"]}]}' where id = v_menu;
    fails := fails || '2 room 61 accepted'::text;
  exception when check_violation then if sqlerrm not like '%room%1 to 60%' then fails := fails || format('2 room message: %s', sqlerrm); end if;
  end;
  begin
    update public.menus set spec = '{"lists": [{"key": "x", "name": "X", "kind": "items", "room": 4, "fields": ["price"]}]}' where id = v_menu;
    fails := fails || '2 an items list without names'::text;
  exception when check_violation then null;
  end;
  begin
    update public.menus set spec = '{"lists": [{"key": "x", "name": "X", "kind": "menu", "room": 4}]}' where id = v_menu;
    fails := fails || '2 an unknown kind'::text;
  exception when check_violation then null;
  end;
  perform set_config('role', 'none', true);

  -- 3. The owner and the editor save (as themselves): each a kept revision with who it was; goes live at once
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 0, c1);
  if (r ->> 'rev')::int <> 1 then fails := fails || format('3 owner''s save %s', r); end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u_editor, 'role', 'authenticated')::text, true);
  r := public.menu_save(v_menu, 1, c2);
  if (r ->> 'rev')::int <> 2 then fails := fails || format('3 editor''s save %s', r); end if;
  perform set_config('role', 'none', true);
  if (select content from public.menus where id = v_menu) is distinct from c2
     or (select count(*) from public.menu_revisions where menu_id = v_menu) <> 2
     or (select by_name from public.menu_revisions where menu_id = v_menu and rev = 1) <> 'Menus Owner'
     or (select by_1point from public.menu_revisions where menu_id = v_menu and rev = 2) then
    fails := fails || '3 the revisions'::text;
  end if;

  -- 4. The room and the boxes are enforced: past the room is a menu expansion; caps; unknown boxes; pictures
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.menu_save(v_menu, 2, '{"lists": {"donuts": {"entries": [{"id":"b1b1","name":"A"},{"id":"b2b2","name":"B"},{"id":"b3b3","name":"C"},{"id":"b4b4","name":"D"}]}}}');
    fails := fails || '4 past the room'::text;
  exception when check_violation then if sqlerrm not like '%room for 3%menu expansion%' then fails := fails || format('4 room message: %s', sqlerrm); end if;
  end;
  begin
    perform public.menu_save(v_menu, 2, '{"lists": {"donuts": {"entries": [{"id":"b1b1","name":"A name far too long for it"}]}}}');
    fails := fails || '4 over the cap'::text;
  exception when check_violation then if sqlerrm not like '%room for 20%' then fails := fails || format('4 cap message: %s', sqlerrm); end if;
  end;
  begin
    perform public.menu_save(v_menu, 2, '{"lists": {"donuts": {"entries": [{"id":"b1b1","name":"A","line":"not a box here"}]}}}');
    fails := fails || '4 an unknown box'::text;
  exception when check_violation then null;
  end;
  begin
    perform public.menu_save(v_menu, 2, '{"lists": {"donuts": {"entries": [{"id":"b1b1","name":"A","image":"img:stranger-pic"}]}}}');
    fails := fails || '4 another account''s picture'::text;
  exception when check_violation then null;
  end;
  begin
    perform public.menu_save(v_menu, 2, '{"lists": {"party": {"entries": [{"id":"p1p1","title":"One"},{"id":"p2p2","title":"Two"}]}}}');
    fails := fails || '4 two entries in a text list'::text;
  exception when check_violation then null;
  end;

  -- 5. A save over someone else's newer one is refused, saying who
  begin
    perform public.menu_save(v_menu, 1, c1);
    fails := fails || '5 a stale save'::text;
  exception when serialization_failure then if sqlerrm not like 'Someone else saved%Menus Editor%' then fails := fails || format('5 message: %s', sqlerrm); end if;
  end;
  perform set_config('role', 'none', true);

  -- 6. Customer editing off (a full maintenance plan): the owner is refused, 1Point saves (marked as 1Point)
  update public.menus set customer_edit = false where id = v_menu;
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.menu_save(v_menu, 2, c1);
    fails := fails || '6 the owner saved with customer editing off'::text;
  exception when insufficient_privilege then if sqlerrm not like '%keeps this menu up to date%' then fails := fails || format('6 message: %s', sqlerrm); end if;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  r := public.menu_save(v_menu, 2, c2);
  perform set_config('role', 'none', true);
  if (r ->> 'rev')::int <> 3 or not (select by_1point from public.menu_revisions where menu_id = v_menu and rev = 3) then fails := fails || '6 1Point''s save'::text; end if;
  update public.menus set customer_edit = true where id = v_menu;

  -- 7. A stranger sees and saves nothing; signed-in users can't write the content or the revisions directly
  perform set_config('request.jwt.claims', json_build_object('sub', u_other, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_n from public.menus where id = v_menu;
  if v_n <> 0 then fails := fails || '7 a stranger saw the menu'::text; end if;
  select count(*) into v_n from public.menu_revisions where menu_id = v_menu;
  if v_n <> 0 then fails := fails || '7 a stranger saw its history'::text; end if;
  begin
    perform public.menu_save(v_menu, 3, c1);
    fails := fails || '7 a stranger saved'::text;
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  begin
    update public.menus set content = c1 where id = v_menu;
    fails := fails || '7 an owner wrote the content directly'::text;
  exception when insufficient_privilege then null;
  end;
  update public.menus set spec = '{"lists": []}' where id = v_menu;   -- the owner's update matches no row (1Point only)
  begin
    insert into public.menu_revisions (menu_id, rev, content) values (v_menu, 99, c1);
    fails := fails || '7 an owner wrote a revision'::text;
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'none', true);
  if (select jsonb_array_length(m.spec -> 'lists') from public.menus m where id = v_menu) <> 3 then fails := fails || '7 an owner changed the lists'::text; end if;

  -- 8. Restore: an earlier revision saved again, as a new one; kept revisions never change
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_restore(v_menu, 1, 3);
  perform set_config('role', 'none', true);
  if (r ->> 'rev')::int <> 4 or (select content from public.menus where id = v_menu) is distinct from c1
     or (select restored_from from public.menu_revisions where menu_id = v_menu and rev = 4) <> 1 then
    fails := fails || format('8 restore %s', r);
  end if;
  begin
    update public.menu_revisions set by_name = 'someone' where menu_id = v_menu and rev = 1;
    fails := fails || '8 a revision changed'::text;
  exception when check_violation then null;
  end;

  -- 9. A layout on the menu: its screen gets the lists and the pictures they use, a save changes the screen's version;
  --    the menu stays in its account; a list a published layout shows can't be taken off; a picture it uses stays
  insert into public.layouts (org_id, name, orientation, menu_id) values (v_org, 'Menus test board', 'landscape', v_menu) returning id into v_lay;
  perform public.layout_publish(v_lay, doc, '{}', false, '', u_admin);
  insert into public.screens (key, name, layout_id, property_id, orientation) values ('menus-test-screen', 'Menus test screen', v_lay, v_prop, 'landscape');
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.menu_save(v_menu, 4, c2);
  perform set_config('role', 'none', true);
  r := public.screen_state('menus-test-screen', null, null, null);
  v_etag := r ->> 'etag';
  if r -> 'lists' ->> 'id' is distinct from v_menu::text or r -> 'lists' -> 'content' is distinct from c2
     or r -> 'images' -> 'menus-check' ->> 'path' is distinct from v_org || '/menus-check-1a2b3c4d.webp' then
    fails := fails || format('9 the screen''s answer %s', r - 'screen');
  end if;
  begin
    perform public.layout_image_delete(v_pic);
    fails := fails || '9 a picture on the boards now was removed'::text;
  exception when check_violation then null;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.menu_save(v_menu, 5, c1);
  perform set_config('role', 'none', true);
  r := public.screen_state('menus-test-screen', null, v_etag, null);
  if coalesce((r ->> 'not_modified')::boolean, false) then fails := fails || '9 a save didn''t change the screen''s version'::text; end if;
  if (public.menu_page((select menu_code from public.layouts where id = v_lay), false) -> 'lists' -> 'content') is distinct from c1 then fails := fails || '9 the phone page''s lists'::text; end if;
  insert into public.menus (org_id, name) values (v_org2, 'Stranger''s menu') returning id into v_menu2;
  begin
    update public.layouts set menu_id = v_menu2 where id = v_lay;
    fails := fails || '9 a layout took another account''s menu'::text;
  exception when check_violation then null;
  end;
  begin
    update public.menus m set spec = jsonb_build_object('lists', (m.spec -> 'lists') - 0) where id = v_menu;
    fails := fails || '9 a list the board shows was taken off'::text;
  exception when check_violation then if sqlerrm not like '%"donuts" is shown by the layout%' then fails := fails || format('9 message: %s', sqlerrm); end if;
  end;
  begin
    delete from public.menus where id = v_menu;
    fails := fails || '9 a menu a layout uses was removed'::text;
  exception when check_violation then null;
  end;

  -- 10. Permissions: the rules, the writer and "make lists" are the site's or the database's; saving is for signed-in users
  if has_function_privilege('authenticated', 'public.menu_write(uuid, integer, jsonb, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.menu_create(uuid, text, jsonb, jsonb, uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.menu_content_problem(jsonb, jsonb, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.menu_save(uuid, integer, jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.menu_restore(uuid, integer, integer)', 'execute')
     or has_function_privilege('anon', 'public.menu_save(uuid, integer, jsonb)', 'execute')
     or has_table_privilege('anon', 'public.menus', 'select')
     or has_table_privilege('authenticated', 'public.menu_revisions', 'insert')
     or has_column_privilege('authenticated', 'public.menus', 'content', 'update')
     or has_column_privilege('authenticated', 'public.menus', 'rev', 'update') then
    fails := fails || '10 permissions'::text;
  end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 10 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
