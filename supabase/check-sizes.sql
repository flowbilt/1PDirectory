-- Confirms 18-sizes.sql works. Run after 18: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 8 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
do $$
declare
  v_org    uuid;
  v_other  uuid;
  v_prop   uuid;
  v_dir    uuid;
  v_scr    uuid;
  u_owner  uuid := gen_random_uuid();
  u_stray  uuid := gen_random_uuid();
  r        jsonb;
  v_etag   text;
  fails    text[] := '{}';
begin
  -- A made-up owner with one building, directory and screen, and a user from another account
  insert into public.organizations (name) values ('Sizes test owner') returning id into v_org;
  insert into public.organizations (name) values ('Sizes test stranger') returning id into v_other;
  insert into public.properties (org_id, name) values (v_org, 'Sizes test building') returning id into v_prop;
  insert into public.directories (property_id, slug, title) values (v_prop, 'sizes-test-dir', 'Sizes test') returning id into v_dir;
  insert into public.screens (directory_id, key, name) values (v_dir, 'sizes-test-screen', 'Sizes test screen') returning id into v_scr;
  insert into auth.users (id, email) values (u_owner, 'sizes-owner@example.com'), (u_stray, 'sizes-stray@example.com');
  insert into public.profiles (user_id, email, role, org_id) values (u_owner, 'sizes-owner@example.com', 'org_editor', v_org),
                                                                    (u_stray, 'sizes-stray@example.com', 'org_admin', v_other);

  -- 1. A new screen has no sizes: it looks exactly as before
  if (select sizes from public.screens where id = v_scr) <> '{}'::jsonb then fails := fails || '1 new screen not standard'::text; end if;

  -- 2. The screen's own account can set them; 100 isn't stored; out of range is clamped; unknown names ignored
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  r := public.set_screen_sizes(v_scr, '{"title": 80, "logo": 100, "brand": 999, "welcome": 40, "news": 70, "bogus": "x"}');
  if r <> '{"title": 80, "brand": 250, "welcome": 80}'::jsonb
     or (select sizes from public.screens where id = v_scr) <> r then
    fails := fails || format('2 owner sets sizes: %s', r);
  end if;

  -- 3. Someone from another account can't, and nothing changes
  perform set_config('request.jwt.claims', json_build_object('sub', u_stray, 'role', 'authenticated')::text, true);
  begin
    r := public.set_screen_sizes(v_scr, '{"title": 50}');
    fails := fails || '3 a stranger changed the sizes'::text;
  exception when insufficient_privilege then null;
  end;
  if (select sizes ->> 'title' from public.screens where id = v_scr) <> '80' then fails := fails || '3 sizes changed'::text; end if;

  -- 4. Not signed in: refused too
  perform set_config('request.jwt.claims', '', true);
  begin
    r := public.set_screen_sizes(v_scr, '{"title": 50}');
    fails := fails || '4 signed-out user changed the sizes'::text;
  exception when insufficient_privilege then null;
  end;

  -- 5. The screen's answer carries its sizes
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  r := public.set_screen_sizes(v_scr, '{"title": 80}');
  v_etag := public.screen_state('sizes-test-screen', null, null, null) ->> 'etag';
  if (public.screen_state('sizes-test-screen', null, null, null) -> 'screen' -> 'sizes') <> '{"title": 80}'::jsonb then
    fails := fails || format('5 screen_state sends the sizes: %s', public.screen_state('sizes-test-screen', null, null, null) -> 'screen');
  end if;

  -- 6. A size change changes the screen's version, so the TV re-downloads
  r := public.set_screen_sizes(v_scr, '{"title": 100, "logo": 100}');
  if r <> '{}'::jsonb then fails := fails || format('6 back to standard: %s', r); end if;
  if coalesce((public.screen_state('sizes-test-screen', null, v_etag, null) ->> 'not_modified')::boolean, false) then
    fails := fails || '6 the version didn''t change'::text;
  end if;

  -- 7. ...and an unchanged screen is still "not modified"
  v_etag := public.screen_state('sizes-test-screen', null, null, null) ->> 'etag';
  if not coalesce((public.screen_state('sizes-test-screen', null, v_etag, null) ->> 'not_modified')::boolean, false) then
    fails := fails || '7 unchanged screen re-sent'::text;
  end if;

  -- 8. Permissions: signed-in users can call it (it checks access itself), signed-out can't; screen_state stays server-only;
  --    signed-in users can read sizes but still can't write screens directly
  if not has_function_privilege('authenticated', 'public.set_screen_sizes(uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.set_screen_sizes(uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.screen_state(text,text,text,jsonb)', 'execute')
     or not has_column_privilege('authenticated', 'public.screens', 'sizes', 'select') then
    fails := fails || '8 permissions'::text;
  end if;

  if cardinality(fails) = 0 then
    raise exception 'ALL 8 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else
    raise exception 'FAILED: %', array_to_string(fails, ' || ');
  end if;
end $$;
