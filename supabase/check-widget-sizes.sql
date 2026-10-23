-- Confirms 22-widget-sizes.sql works. Run after 22: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 7 CHECKS PASSED"  means everything works.
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
  insert into public.organizations (name) values ('Widget sizes test owner') returning id into v_org;
  insert into public.organizations (name) values ('Widget sizes test stranger') returning id into v_other;
  insert into public.properties (org_id, name) values (v_org, 'Widget sizes test building') returning id into v_prop;
  insert into public.directories (property_id, slug, title) values (v_prop, 'widget-sizes-test-dir', 'Widget sizes test') returning id into v_dir;
  insert into public.screens (directory_id, key, name) values (v_dir, 'widget-sizes-test-screen', 'Widget sizes test screen') returning id into v_scr;
  insert into auth.users (id, email) values (u_owner, 'widget-owner@example.com'), (u_stray, 'widget-stray@example.com');
  insert into public.profiles (user_id, email, role, org_id) values (u_owner, 'widget-owner@example.com', 'org_editor', v_org),
                                                                    (u_stray, 'widget-stray@example.com', 'org_admin', v_other);

  -- 1. The four new names are kept, within 70-150
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  r := public.set_screen_sizes(v_scr, '{"news": 130, "clock": 85, "weather": 120, "contacts": 110}');
  if r <> '{"news": 130, "clock": 85, "weather": 120, "contacts": 110}'::jsonb
     or (select sizes from public.screens where id = v_scr) <> r then
    fails := fails || format('1 new names kept: %s', r);
  end if;

  -- 2. Out of range is clamped to 70 and 150; 100 isn't stored; unknown names still ignored
  r := public.set_screen_sizes(v_scr, '{"news": 400, "clock": 10, "weather": 100, "contacts": "big", "ticker": 90}');
  if r <> '{"news": 150, "clock": 70}'::jsonb then fails := fails || format('2 clamped: %s', r); end if;

  -- 3. The original four still work exactly as before (18-sizes.sql's ranges)
  r := public.set_screen_sizes(v_scr, '{"title": 999, "logo": 1, "brand": 250, "welcome": 160, "news": 90}');
  if r <> '{"title": 120, "logo": 60, "brand": 250, "welcome": 160, "news": 90}'::jsonb then
    fails := fails || format('3 original sizes: %s', r);
  end if;

  -- 4. Someone from another account can't, and nothing changes
  perform set_config('request.jwt.claims', json_build_object('sub', u_stray, 'role', 'authenticated')::text, true);
  begin
    r := public.set_screen_sizes(v_scr, '{"news": 70}');
    fails := fails || '4 a stranger changed the sizes'::text;
  exception when insufficient_privilege then null;
  end;
  if (select sizes ->> 'news' from public.screens where id = v_scr) <> '90' then fails := fails || '4 sizes changed'::text; end if;

  -- 5. The screen's answer carries the new sizes
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  r := public.set_screen_sizes(v_scr, '{"clock": 120}');
  if (public.screen_state('widget-sizes-test-screen', null, null, null) -> 'screen' -> 'sizes') <> '{"clock": 120}'::jsonb then
    fails := fails || format('5 screen_state sends them: %s', public.screen_state('widget-sizes-test-screen', null, null, null) -> 'screen');
  end if;

  -- 6. A widget size change changes the screen's version, so the TV re-downloads within a minute
  v_etag := public.screen_state('widget-sizes-test-screen', null, null, null) ->> 'etag';
  r := public.set_screen_sizes(v_scr, '{"clock": 120, "contacts": 80}');
  if coalesce((public.screen_state('widget-sizes-test-screen', null, v_etag, null) ->> 'not_modified')::boolean, false) then
    fails := fails || '6 the version didn''t change'::text;
  end if;

  -- 7. Permissions unchanged: signed-in may call it, signed-out may not
  if not has_function_privilege('authenticated', 'public.set_screen_sizes(uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.set_screen_sizes(uuid, jsonb)', 'execute') then
    fails := fails || '7 permissions'::text;
  end if;

  if cardinality(fails) = 0 then
    raise exception 'ALL 7 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else
    raise exception 'FAILED: %', array_to_string(fails, ' || ');
  end if;
end $$;
