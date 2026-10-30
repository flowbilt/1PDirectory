-- Confirms 38-brand.sql works. Run after 38: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 6 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Saves and Restore are tried as signed-in users (1Point, and the shop's owner), as the menu editor does them.
do $$
declare
  u_admin uuid := gen_random_uuid();
  u_owner uuid := gen_random_uuid();
  v_org uuid; v_menu uuid; r jsonb;
  v_spec jsonb := '{"lists": [{"key": "coffee", "name": "Coffee", "kind": "items", "room": 6, "fields": ["name", "price"]}]}';
  v_brand jsonb := '{"name": "O''Henry''s Coffees", "logo": "img:oh-logo", "colours": {"bg": "#f3eee3", "ink": "#3b2620", "accent": "#b98454", "panel": "#3b2620", "highlight": "#5a3d2e"}, "fonts": {"display": "Playfair Display", "body": "Instrument Sans"}}';
  fails text[] := '{}';
begin
  insert into public.organizations (name, kind) values ('Brand test samples', 'samples') returning id into v_org;
  insert into auth.users (id, email) values (u_admin, 'brand-admin@example.com'), (u_owner, 'brand-owner@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values
    (u_admin, 'brand-admin@example.com', 'Brand Admin', 'platform_admin', null),
    (u_owner, 'brand-owner@example.com', 'Brand Owner', 'org_admin', v_org);
  insert into public.layout_images (org_id, key, name, path, mime, width, height, bytes)
    values (v_org, 'oh-logo', 'O.H logo', v_org::text || '/oh-logo-aaaa1111.png', 'image/png', 600, 200, 1000);
  insert into public.menus (org_id, name, spec, customer_edit) values (v_org, 'Brand test menu', v_spec, true) returning id into v_menu;

  -- 1. 1Point (signed in) sets the brand: kept as sent
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 0, jsonb_build_object('lists', '{"coffee": {"entries": [{"id": "c0001", "name": "Latte", "price": "$4.95"}]}}'::jsonb, 'brand', v_brand));
  perform set_config('role', 'none', true);
  if (select content -> 'brand' from public.menus where id = v_menu) is distinct from v_brand then fails := fails || '1 not kept as sent'::text; end if;

  -- 2. Only the rules: a colour that isn't one, a font that isn't WayTuGo's, a logo the account doesn't have, an unknown part, a long name
  perform set_config('role', 'authenticated', true);
  begin perform public.menu_save(v_menu, 1, '{"lists": {}, "brand": {"colours": {"bg": "cream"}}}'); fails := fails || '2 a colour'::text;
  exception when check_violation then if sqlerrm not like '%Brand: Each brand colour is a colour like #3b2620.%' then fails := fails || format('2 message: %s', sqlerrm); end if; end;
  begin perform public.menu_save(v_menu, 1, '{"lists": {}, "brand": {"fonts": {"display": "Comic Sans MS"}}}'); fails := fails || '2 a font'::text;
  exception when check_violation then null; end;
  begin perform public.menu_save(v_menu, 1, '{"lists": {}, "brand": {"logo": "img:no-such-picture"}}'); fails := fails || '2 a logo'::text;
  exception when check_violation then if sqlerrm not like '%no picture "no-such-picture"%' then fails := fails || format('2 message: %s', sqlerrm); end if; end;
  begin perform public.menu_save(v_menu, 1, '{"lists": {}, "brand": {"slogan": "Hi"}}'); fails := fails || '2 an unknown part'::text;
  exception when check_violation then null; end;
  begin perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'brand', jsonb_build_object('name', repeat('x', 61)))); fails := fails || '2 a long name'::text;
  exception when check_violation then null; end;
  perform set_config('role', 'none', true);

  -- 3. The owner's save can't change the brand (it keeps 1Point's), but their lists save as always
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 1, '{"lists": {"coffee": {"entries": [{"id": "c0001", "name": "Latte", "price": "$5.25"}]}}, "brand": {"name": "Owner''s own name"}}');
  perform set_config('role', 'none', true);
  if (select content -> 'brand' ->> 'name' from public.menus where id = v_menu) is distinct from 'O''Henry''s Coffees'
     or (select content -> 'lists' -> 'coffee' -> 'entries' -> 0 ->> 'price' from public.menus where id = v_menu) is distinct from '$5.25'
     or (select content -> 'brand' ->> 'name' from public.menu_revisions where menu_id = v_menu and rev = 2) is distinct from 'O''Henry''s Coffees' then
    fails := fails || '3 the owner changed the brand'::text;
  end if;
  -- leaving it out doesn't remove it either
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 2, '{"lists": {"coffee": {"entries": [{"id": "c0001", "name": "Latte", "price": "$5.25"}]}}}');
  perform set_config('role', 'none', true);
  if (select content -> 'brand' from public.menus where id = v_menu) is distinct from v_brand then fails := fails || '3 the owner removed the brand'::text; end if;

  -- 4. 1Point changes the name; the owner restores save 1 (the old name): the lists come back, the brand stays 1Point's latest
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 3, jsonb_build_object('lists', '{"coffee": {"entries": [{"id": "c0001", "name": "Latte", "price": "$5.25"}]}}'::jsonb, 'brand', v_brand || '{"name": "O.Henry''s Brookwood"}'));
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  r := public.menu_restore(v_menu, 1, 4);
  perform set_config('role', 'none', true);
  if (select content -> 'brand' ->> 'name' from public.menus where id = v_menu) is distinct from 'O.Henry''s Brookwood'
     or (select content -> 'lists' -> 'coffee' -> 'entries' -> 0 ->> 'price' from public.menus where id = v_menu) is distinct from '$4.95' then
    fails := fails || format('4 restore %s', (select content from public.menus where id = v_menu));
  end if;
  -- 1Point's own Restore does bring the old brand back
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_restore(v_menu, 1, 5);
  perform set_config('role', 'none', true);
  if (select content -> 'brand' ->> 'name' from public.menus where id = v_menu) is distinct from 'O''Henry''s Coffees' then fails := fails || '4 1Point''s restore'::text; end if;

  -- 5. Add lists from this layout keeps it
  perform public.menu_add_lists(v_menu, '[{"key": "note", "name": "Note", "kind": "text", "room": 1, "fields": ["title"]}]', '{"note": {"entries": [{"id": "n0001", "title": "Hi"}]}}', u_admin, null, null);
  if (select content -> 'brand' ->> 'name' from public.menus where id = v_menu) is distinct from 'O''Henry''s Coffees' then fails := fails || '5 adding lists lost it'::text; end if;

  -- 6. The logo picture can't be removed while the brand uses it; the rules are the database's own
  if not public.layout_image_in_use(v_org, 'oh-logo') then fails := fails || '6 the logo picture isn''t in use'::text; end if;
  if has_function_privilege('authenticated', 'public.menu_brand_problem(jsonb, uuid)', 'execute') then fails := fails || '6 permissions'::text; end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 6 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
