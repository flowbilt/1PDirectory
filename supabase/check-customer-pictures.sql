-- Confirms 34-customer-pictures.sql works. Run after 34: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 8 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- The room for pictures and Restore are tried as signed-in users, as the console and the menu editor do it.
do $$
declare
  u_admin  uuid := gen_random_uuid();
  u_owner  uuid := gen_random_uuid();
  v_org    uuid;
  v_menu   uuid;
  v_lay    uuid;
  p_old    uuid;
  p_board  uuid;
  p_layout uuid;
  v_path   text;
  v_n      integer;
  r        jsonb;
  v_spec   jsonb := '{"lists": [{"key": "donuts", "name": "Donuts", "kind": "items", "room": 4, "fields": ["name", "price", "image"]}]}';
  fails    text[] := '{}';
begin
  insert into public.organizations (name) values ('Pictures test shop') returning id into v_org;
  insert into auth.users (id, email) values (u_admin, 'pictures-admin@example.com'), (u_owner, 'pictures-owner@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values
    (u_admin, 'pictures-admin@example.com', 'Pictures Admin', 'platform_admin', null),
    (u_owner, 'pictures-owner@example.com', 'Pictures Owner', 'org_admin', v_org);

  -- 1. A new account has room for 100 pictures
  if (select picture_room from public.organizations where id = v_org) <> 100 then fails := fails || '1 room is not 100'::text; end if;

  -- 2. 1Point changes the room (signed in); the account's own admin can't
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  update public.organizations set picture_room = 500 where id = v_org;
  perform set_config('role', 'none', true);
  if (select picture_room from public.organizations where id = v_org) <> 100 then fails := fails || '2 the customer raised their own room'::text; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  update public.organizations set picture_room = 3 where id = v_org;
  perform set_config('role', 'none', true);
  if (select picture_room from public.organizations where id = v_org) <> 3 then fails := fails || '2 1Point couldn''t change the room'::text; end if;

  -- 3. The one past the room is refused, in plain words
  insert into public.layout_images (org_id, key, name, path, mime, width, height, bytes) values
    (v_org, 'old-special', 'Old special', v_org || '/old-special-1a2b3c4d.webp', 'image/webp', 800, 600, 90000) returning id into p_old;
  insert into public.layout_images (org_id, key, name, path, mime, width, height, bytes) values
    (v_org, 'on-board', 'On the board', v_org || '/on-board-1a2b3c4d.webp', 'image/webp', 800, 600, 90000) returning id into p_board;
  insert into public.layout_images (org_id, key, name, path, mime, width, height, bytes) values
    (v_org, 'in-layout', 'In the layout', v_org || '/in-layout-1a2b3c4d.webp', 'image/webp', 800, 600, 90000) returning id into p_layout;
  begin
    insert into public.layout_images (org_id, key, name, path, mime, width, height, bytes) values
      (v_org, 'one-too-many', 'One too many', v_org || '/one-too-many-1a2b3c4d.webp', 'image/webp', 800, 600, 90000);
    fails := fails || '3 a picture past the room'::text;
  exception when check_violation then
    if sqlerrm not like 'This account has 3 pictures, the most it holds.%ask WayTuGo for more room.' then fails := fails || format('3 message: %s', sqlerrm); end if;
  end;

  -- The owner saves a menu that uses "old-special" (revision 1), then changes it to "on-board" (revision 2)
  insert into public.menus (org_id, name, spec, customer_edit) values (v_org, 'Pictures test menu', v_spec, true) returning id into v_menu;
  insert into public.layouts (org_id, name, orientation) values (v_org, 'Pictures test board', 'landscape') returning id into v_lay;
  insert into public.layout_versions (layout_id, version, doc) values (v_lay, 1, '{"blocks": [{"type": "photo", "image": "img:in-layout"}]}');
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.menu_save(v_menu, 0, '{"lists": {"donuts": {"entries": [{"id": "pc0001", "name": "Pumpkin", "image": "img:old-special"}, {"id": "pc0002", "name": "Glazed"}]}}}');
  perform public.menu_save(v_menu, 1, '{"lists": {"donuts": {"entries": [{"id": "pc0001", "name": "Pumpkin", "image": "img:on-board"}, {"id": "pc0002", "name": "Glazed"}]}}}');
  perform set_config('role', 'none', true);

  -- 4. A picture on the boards now can't be removed: it names the menu
  begin
    perform public.layout_image_check(p_board);
    fails := fails || '4 a picture on the boards'::text;
  exception when check_violation then
    if sqlerrm not like 'The picture "On the board" is on the boards now (Pictures test menu).%' then fails := fails || format('4 message: %s', sqlerrm); end if;
  end;

  -- 5. A picture in a layout's kept version can't be removed (Roll back needs it): it says to ask WayTuGo
  begin
    perform public.layout_image_delete(p_layout);
    fails := fails || '5 a picture in a layout version'::text;
  exception when check_violation then
    if sqlerrm not like '%part of the layout Pictures test board, so only WayTuGo can take it off.%' then fails := fails || format('5 message: %s', sqlerrm); end if;
  end;

  -- 6. A picture only an old save used can be removed: the check gives its file, the delete removes the row
  v_path := public.layout_image_check(p_old);
  if v_path is distinct from v_org || '/old-special-1a2b3c4d.webp' then fails := fails || format('6 path %s', v_path); end if;
  perform public.layout_image_delete(p_old);
  if exists (select 1 from public.layout_images where id = p_old) then fails := fails || '6 row still there'::text; end if;
  begin
    perform public.layout_image_check(p_old);
    fails := fails || '6 checked a removed picture'::text;
  exception when no_data_found then null;
  end;

  -- 7. Restoring that old save (as the owner) brings Pumpkin back without its picture, and says so
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_restore(v_menu, 1, 2);
  perform set_config('role', 'none', true);
  if (r ->> 'pictures_cleared')::int is distinct from 1 or (r ->> 'rev')::int is distinct from 3 then fails := fails || format('7 restore %s', r); end if;
  select count(*) into v_n from public.menus m, jsonb_array_elements(m.content -> 'lists' -> 'donuts' -> 'entries') e
   where m.id = v_menu and e ? 'image';
  if v_n <> 0 then fails := fails || '7 a picture left on the restored menu'::text; end if;
  if not exists (select 1 from public.menus m, jsonb_array_elements(m.content -> 'lists' -> 'donuts' -> 'entries') e
                  where m.id = v_menu and e ->> 'name' = 'Pumpkin') then fails := fails || '7 Pumpkin not back'::text; end if;

  -- 8. Permissions: checking and removing pictures, and adding them, are the site's only
  if has_function_privilege('authenticated', 'public.layout_image_check(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.layout_image_delete(uuid)', 'execute')
     or has_function_privilege('anon', 'public.layout_image_check(uuid)', 'execute')
     or has_table_privilege('authenticated', 'public.layout_images', 'insert')
     or has_table_privilege('authenticated', 'public.layout_images', 'delete')
     or not has_function_privilege('authenticated', 'public.menu_restore(uuid, integer, integer)', 'execute') then
    fails := fails || '8 permissions'::text;
  end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 8 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
