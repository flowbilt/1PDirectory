-- Confirms 24-directory-to-go.sql works. Run after 24: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 10 CHECKS PASSED"  means everything works.
--   "FAILED: ..."           lists what didn't. Copy the whole message to Claude.
do $$
declare
  v_org    uuid;
  v_other  uuid;
  v_prop   uuid;
  v_dir    uuid;
  v_scr    uuid;
  u_editor uuid := gen_random_uuid();
  u_stray  uuid := gen_random_uuid();
  v_code   text;
  v_new    text;
  v_etag   text;
  r        jsonb;
  fails    text[] := '{}';
begin
  -- 1. Every directory has a well-formed code, all different; the switch is off everywhere; the mark shows everywhere
  if exists (select 1 from public.directories where togo_code !~ '^[A-HJKMNP-Z2-9]{6}$')
     or (select count(distinct togo_code) from public.directories) <> (select count(*) from public.directories)
     or exists (select 1 from public.screens where hide_powered_by) then
    fails := fails || '1 codes, or a mark hidden'::text;
  end if;

  insert into public.organizations (name) values ('To go test owner') returning id into v_org;
  insert into public.organizations (name) values ('To go test stranger') returning id into v_other;
  insert into public.properties (org_id, name, address, amenities) values (v_org, 'To go test building', '1 Test Way', '[{"name":"Cafe"}]') returning id into v_prop;
  insert into public.directories (property_id, slug, title) values (v_prop, 'togo-test-dir', 'To go test') returning id, togo_code into v_dir, v_code;
  insert into public.tenants (directory_id, name, suite, sort) values (v_dir, 'Acme Law', '100', 0), (v_dir, 'Zed Dental', '200', 10);
  insert into public.screens (directory_id, key, name) values (v_dir, 'togo-test-screen', 'To go test screen') returning id into v_scr;
  insert into auth.users (id, email) values (u_editor, 'togo-editor@example.com'), (u_stray, 'togo-stray@example.com');
  insert into public.profiles (user_id, email, role, org_id) values (u_editor, 'togo-editor@example.com', 'org_editor', v_org),
                                                                    (u_stray, 'togo-stray@example.com', 'org_admin', v_other);

  -- 2. A new directory gets a code by itself
  if v_code !~ '^[A-HJKMNP-Z2-9]{6}$' then fails := fails || format('2 new directory code: %s', v_code); end if;

  -- 3. Switched off: no page, and nothing counted
  r := public.togo_page(v_code);
  if not coalesce((r ->> 'missing')::boolean, false) or exists (select 1 from public.togo_scans where directory_id = v_dir) then
    fails := fails || format('3 off: %s', r);
  end if;

  -- 4. Switched on: the page has the building, the tenants in order, and counts the open (lowercase code works too)
  update public.directories set togo_enabled = true where id = v_dir;
  r := public.togo_page(lower(v_code));
  if r -> 'prop' ->> 'name' <> 'To go test building' or r -> 'tenants' -> 0 ->> 'name' <> 'Acme Law'
     or jsonb_array_length(r -> 'tenants') <> 2 or r -> 'tenants' -> 0 ? 'arrow'
     or (select scans from public.togo_scans where directory_id = v_dir) <> 1 then
    fails := fails || format('4 page: %s', left(r::text, 300));
  end if;
  perform public.togo_page(v_code);
  if (select sum(scans) from public.togo_scans where directory_id = v_dir) <> 2 then fails := fails || '4 second open not counted'::text; end if;

  -- 5. The directory's own account sees the count; a stranger doesn't
  perform set_config('request.jwt.claims', json_build_object('sub', u_editor, 'role', 'authenticated')::text, true);
  r := public.togo_scan_count(v_dir);
  if (r ->> 'last30')::int <> 2 or (r ->> 'total')::int <> 2 then fails := fails || format('5 count: %s', r); end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u_stray, 'role', 'authenticated')::text, true);
  begin
    r := public.togo_scan_count(v_dir);
    fails := fails || '5 a stranger read the count'::text;
  exception when insufficient_privilege then null;
  end;

  -- 6. An editor can't set the code by hand, but can replace it; the old code then finds nothing
  perform set_config('request.jwt.claims', json_build_object('sub', u_editor, 'role', 'authenticated')::text, true);
  begin
    update public.directories set togo_code = 'AAAAAA' where id = v_dir;
    fails := fails || '6 code set by hand'::text;
  exception when insufficient_privilege then null;
  end;
  v_new := public.togo_replace_code(v_dir);
  perform set_config('request.jwt.claims', '', true);
  if v_new = v_code or (select togo_code from public.directories where id = v_dir) <> v_new
     or not coalesce((public.togo_page(v_code) ->> 'missing')::boolean, false) then
    fails := fails || format('6 replace: %s -> %s', v_code, v_new);
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u_stray, 'role', 'authenticated')::text, true);
  begin
    perform public.togo_replace_code(v_dir);
    fails := fails || '6 a stranger replaced the code'::text;
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claims', '', true);

  -- 7. Round 11's places moved into the first list; at most 5 lists
  update public.properties set place_lists = '[]' where id = v_prop;
  update public.properties set place_lists = jsonb_build_array(jsonb_build_object('heading', 'Nearby', 'items', amenities))
    where id = v_prop and place_lists = '[]'::jsonb and jsonb_array_length(amenities) > 0;
  if (select place_lists -> 0 -> 'items' -> 0 ->> 'name' from public.properties where id = v_prop) <> 'Cafe' then
    fails := fails || '7 places not moved'::text;
  end if;
  if exists (select 1 from public.properties where jsonb_array_length(amenities) > 0 and place_lists = '[]'::jsonb) then
    fails := fails || '7 a building''s places were left behind'::text;
  end if;
  begin
    update public.properties set place_lists = '[{},{},{},{},{},{}]' where id = v_prop;
    fails := fails || '7 six lists accepted'::text;
  exception when check_violation then null;
  end;

  -- 8. The QR size: 70 to 150, the other sizes as before
  perform set_config('request.jwt.claims', json_build_object('sub', u_editor, 'role', 'authenticated')::text, true);
  r := public.set_screen_sizes(v_scr, '{"qr": 400, "news": 90, "title": 1}');
  if r <> '{"qr": 150, "news": 90, "title": 50}'::jsonb then fails := fails || format('8 sizes: %s', r); end if;
  perform set_config('request.jwt.claims', '', true);

  -- 9. The mark: 1Point's switch reaches the screen and changes its version
  v_etag := public.screen_state('togo-test-screen', null, null, null) ->> 'etag';
  if (public.screen_state('togo-test-screen', null, null, null) -> 'screen' ->> 'hide_powered_by')::boolean then fails := fails || '9 hidden by default'::text; end if;
  update public.screens set hide_powered_by = true where id = v_scr;
  if not coalesce((public.screen_state('togo-test-screen', null, null, null) -> 'screen' ->> 'hide_powered_by')::boolean, false)
     or coalesce((public.screen_state('togo-test-screen', null, v_etag, null) ->> 'not_modified')::boolean, false) then
    fails := fails || '9 mark switch'::text;
  end if;

  -- 10. Permissions: the page and the scan table are server-only; signed-in users can read the switch and the mark
  if has_function_privilege('authenticated', 'public.togo_page(text)', 'execute')
     or has_function_privilege('anon', 'public.togo_page(text)', 'execute')
     or has_table_privilege('authenticated', 'public.togo_scans', 'select')
     or has_function_privilege('anon', 'public.togo_scan_count(uuid)', 'execute')
     or not has_column_privilege('authenticated', 'public.screens', 'hide_powered_by', 'select')
     or not has_column_privilege('authenticated', 'public.directories', 'togo_enabled', 'update') then
    fails := fails || '10 permissions'::text;
  end if;

  if cardinality(fails) = 0 then
    raise exception 'ALL 10 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else
    raise exception 'FAILED: %', array_to_string(fails, ' || ');
  end if;
end $$;
