-- Confirms 29-layout-engine.sql works. Run after 29: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 10 CHECKS PASSED"  means everything works.
--   "FAILED: ..."           lists what didn't. Copy the whole message to Claude.
-- What people do in the console (making a layout, choosing it for a screen) is tried as signed-in users, as the
-- console does it (DP-09's lesson); publishing is done as the site does it.
do $$
declare
  u_admin  uuid := gen_random_uuid();
  u_owner  uuid := gen_random_uuid();
  u_other  uuid := gen_random_uuid();
  v_org    uuid;
  v_org2   uuid;
  v_prop   uuid;
  v_prop2  uuid;
  v_dir    uuid;
  v_lay    uuid;
  v_land   uuid;
  v_scr    uuid;
  v_dscr   uuid;
  v_ver    integer;
  r        jsonb;
  r2       jsonb;
  e1       text;
  n        integer;
  doc1     jsonb := '{"format":1,"orientation":"portrait","grid":{"cols":12,"rows":24},"blocks":[{"id":"a","type":"text","at":{"col":1,"row":1,"w":12,"h":2},"content":{"title":"One"}}]}';
  doc2     jsonb := '{"format":1,"orientation":"portrait","grid":{"cols":12,"rows":24},"blocks":[{"id":"a","type":"text","at":{"col":1,"row":1,"w":12,"h":2},"content":{"title":"Two"}}]}';
  fails    text[] := '{}';
begin
  insert into public.organizations (name) values ('Layout test owner') returning id into v_org;
  insert into public.organizations (name) values ('Layout test stranger') returning id into v_org2;
  insert into public.properties (org_id, name, timezone, lat, lon) values (v_org, 'Layout test shop', 'America/Chicago', 33.3, -86.8) returning id into v_prop;
  insert into public.properties (org_id, name) values (v_org2, 'Layout test other shop') returning id into v_prop2;
  insert into public.directories (property_id, title, slug) values (v_prop, 'Layout test directory', 'layout-test-dir') returning id into v_dir;
  insert into public.screens (key, name, directory_id, orientation) values ('layout-test-dir-screen', 'Layout test directory screen', v_dir, 'portrait') returning id into v_dscr;
  insert into auth.users (id, email) values (u_admin, 'layout-admin@example.com'), (u_owner, 'layout-owner@example.com'), (u_other, 'layout-other@example.com');
  insert into public.profiles (user_id, email, role, org_id) values (u_admin, 'layout-admin@example.com', 'platform_admin', null),
                                                                    (u_owner, 'layout-owner@example.com', 'org_admin', v_org),
                                                                    (u_other, 'layout-other@example.com', 'org_admin', v_org2);

  -- 1. A directory screen's answer is as before (no "kind", the same version as 28 gave it)
  r := public.screen_state('layout-test-dir-screen', null, null, null);
  if r ? 'kind' or r -> 'dir' ->> 'id' <> v_dir::text
     or r ->> 'etag' <> (select md5(concat_ws('|', s.key, s.name, s.orientation, s.directory_id::text, '-', d.updated_at::text, p.updated_at::text,
                                               coalesce(s.sizes::text, '{}'), s.hide_powered_by::text, s.touch::text, '-', s.touch_idle_s::text))
                           from public.screens s join public.directories d on d.id = s.directory_id join public.properties p on p.id = d.property_id
                          where s.id = v_dscr) then
    fails := fails || '1 a directory screen''s answer changed'::text;
  end if;

  -- 2. Signed in: 1Point makes a layout; an owner can't; the owner reads their own account's layout, a stranger can't
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    insert into public.layouts (org_id, name, family, orientation) values (v_org, 'Layout test menu', 'menu', 'portrait') returning id into v_lay;
    insert into public.layouts (org_id, name, family, orientation) values (v_org, 'Layout test wide', 'menu', 'landscape') returning id into v_land;
  exception when others then fails := fails || format('2 1Point could not make a layout: %s', sqlerrm);
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  begin
    insert into public.layouts (org_id, name, orientation) values (v_org, 'Owner try', 'portrait');
    fails := fails || '2 an owner made a layout'::text;
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from public.layouts where id = v_lay) <> 1 then fails := fails || '2 the owner can''t see their layout'::text; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u_other, 'role', 'authenticated')::text, true);
  if (select count(*) from public.layouts where id = v_lay) <> 0 then fails := fails || '2 a stranger sees the layout'::text; end if;

  -- 3. Signed in, even 1Point can't write a draft or a version, or publish, without the site's checks
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  begin
    update public.layouts set draft = doc1 where id = v_lay;
    fails := fails || '3 a signed-in user wrote the draft'::text;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.layouts set published_version = 9 where id = v_lay;
    fails := fails || '3 a signed-in user set the published version'::text;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.layout_versions (layout_id, version, doc) values (v_lay, 1, doc1);
    fails := fails || '3 a signed-in user added a version'::text;
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.layout_publish(v_lay, doc1, '{}', false, '', u_admin);
    fails := fails || '3 a signed-in user published directly'::text;
  exception when insufficient_privilege then null;
  end;

  -- 4. Choosing an unpublished layout for a screen is refused, in plain words
  begin
    insert into public.screens (key, name, layout_id, property_id, orientation) values ('layout-test-screen', 'Layout test screen', v_lay, v_prop, 'portrait');
    fails := fails || '4 an unpublished layout was put on a screen'::text;
  exception when check_violation then
    if sqlerrm not like '%hasn''t been published yet%' then fails := fails || format('4 message: %s', sqlerrm); end if;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);

  -- 5. Publishing (as the site does): version 1; a wrong orientation refused; versions can't be changed or removed
  v_ver := public.layout_publish(v_lay, doc1, '{"warnings":[]}', false, 'first', u_admin);
  if v_ver <> 1 or (select published_version from public.layouts where id = v_lay) <> 1 or (select draft from public.layouts where id = v_lay) <> doc1 then
    fails := fails || format('5 publish gave version %s', v_ver);
  end if;
  begin
    perform public.layout_publish(v_land, doc1, '{}', false, '', u_admin);
    fails := fails || '5 a portrait doc was published to a landscape layout'::text;
  exception when check_violation then null;
  end;
  begin
    update public.layout_versions set doc = doc2 where layout_id = v_lay and version = 1;
    fails := fails || '5 a version was changed'::text;
  exception when check_violation then null;
  end;
  begin
    delete from public.layout_versions where layout_id = v_lay;
    fails := fails || '5 a version was removed'::text;
  exception when check_violation then null;
  end;
  perform public.layout_publish(v_land, '{"format":1,"orientation":"landscape","grid":{"cols":16,"rows":9},"blocks":[]}', '{}', false, '', u_admin);

  -- 6. Signed in as 1Point, choosing the layout for a screen: wrong Orientation, no building, another account's
  -- building and a directory at the same time are refused in plain words; the right choice works
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    insert into public.screens (key, name, layout_id, property_id, orientation) values ('layout-test-screen', 'Layout test screen', v_lay, v_prop, 'landscape');
    fails := fails || '6 a portrait layout went on a landscape screen'::text;
  exception when check_violation then
    e1 := sqlerrm;
    if e1 not like '%is portrait, and this screen''s Orientation is Landscape. Change the screen''s Orientation to Portrait first%' then fails := fails || format('6 message: %s', e1); end if;
  end;
  begin
    insert into public.screens (key, name, layout_id, orientation) values ('layout-test-screen', 'Layout test screen', v_lay, 'portrait');
    fails := fails || '6 a layout screen with no building'::text;
  exception when check_violation then null;
  end;
  begin
    insert into public.screens (key, name, layout_id, property_id, orientation) values ('layout-test-screen', 'Layout test screen', v_lay, v_prop2, 'portrait');
    fails := fails || '6 another account''s building'::text;
  exception when check_violation then null;
  end;
  begin
    insert into public.screens (key, name, layout_id, property_id, directory_id, orientation) values ('layout-test-screen', 'Layout test screen', v_lay, v_prop, v_dir, 'portrait');
    fails := fails || '6 a directory and a layout at once'::text;
  exception when check_violation then null;
  end;
  begin
    insert into public.screens (key, name, layout_id, property_id, orientation) values ('layout-test-screen', 'Layout test screen', v_lay, v_prop, 'portrait-flipped') returning id into v_scr;
  exception when others then fails := fails || format('6 the right choice was refused: %s', sqlerrm);
  end;
  -- and switching a directory screen to the layout (as Screen settings does, one PATCH) works too
  begin
    update public.screens set directory_id = null, layout_id = v_lay, property_id = v_prop where id = v_dscr;
    update public.screens set layout_id = null, property_id = null, directory_id = v_dir where id = v_dscr;
  exception when others then fails := fails || format('6 switching a screen to the layout and back: %s', sqlerrm);
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);

  -- 7. The layout screen's answer: the published version with the building's time zone; a new version changes it
  r := public.screen_state('layout-test-screen', null, null, null);
  if r ->> 'kind' <> 'layout' or (r -> 'layout' ->> 'version')::int <> 1 or r -> 'layout' -> 'doc' <> doc1
     or r -> 'prop' ->> 'timezone' <> 'America/Chicago' or r ? 'tenants' or (r -> 'screen' ->> 'orientation') <> 'portrait-flipped' then
    fails := fails || format('7 answer %s', left(r::text, 200));
  end if;
  if (public.screen_state('layout-test-screen', null, r ->> 'etag', null) ->> 'not_modified') is distinct from 'true' then
    fails := fails || '7 an unchanged layout screen re-sent everything'::text;
  end if;
  perform public.layout_publish(v_lay, doc2, '{"warnings":[{"msg":"x"}]}', true, 'second', u_admin);
  r2 := public.screen_state('layout-test-screen', null, r ->> 'etag', null);
  if r2 ->> 'not_modified' = 'true' or r2 -> 'layout' -> 'doc' <> doc2 or (r2 -> 'layout' ->> 'version')::int <> 2 then
    fails := fails || '7 a new version didn''t reach the screen'::text;
  end if;
  if not (select overridden from public.layout_versions where layout_id = v_lay and version = 2) then fails := fails || '7 "published anyway" not kept'::text; end if;

  -- 8. Roll back: version 3 is version 1 again, and the screen shows it
  v_ver := public.layout_rollback(v_lay, 1, u_admin);
  r := public.screen_state('layout-test-screen', null, null, null);
  if v_ver <> 3 or r -> 'layout' -> 'doc' <> doc1 or (select rolled_back_from from public.layout_versions where layout_id = v_lay and version = 3) <> 1
     or (select count(*) from public.layout_versions where layout_id = v_lay) <> 3 then
    fails := fails || format('8 roll back gave %s', v_ver);
  end if;

  -- 9. While a screen shows it: the screen's Orientation can't be turned against it, nor the layout's turned, nor the
  -- layout removed (signed in as 1Point); the owner sees the layout screen and a stranger doesn't
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    update public.screens set orientation = 'landscape' where id = v_scr;
    fails := fails || '9 the screen was turned against its layout'::text;
  exception when check_violation then null;
  end;
  begin
    update public.layouts set orientation = 'landscape' where id = v_lay;
    fails := fails || '9 a layout in use was turned'::text;
  exception when check_violation then null;
  end;
  begin
    delete from public.layouts where id = v_lay;
    fails := fails || '9 a layout in use was removed'::text;
  exception when check_violation then null;
  end;
  update public.layouts set name = 'Layout test menu (renamed)' where id = v_lay;
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  if (select count(*) from public.screens where id = v_scr) <> 1 then fails := fails || '9 the owner can''t see the layout screen'::text; end if;
  select count(*) into n from public.layout_versions where layout_id = v_lay;
  if n <> 3 then fails := fails || format('9 the owner sees %s versions', n); end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u_other, 'role', 'authenticated')::text, true);
  if (select count(*) from public.screens where id = v_scr) <> 0 or (select count(*) from public.layout_versions where layout_id = v_lay) <> 0 then
    fails := fails || '9 a stranger sees the layout screen or its versions'::text;
  end if;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);

  -- 10. Permissions: nothing for signed-out visitors; the publish functions and screen_state are the site's only
  if has_table_privilege('anon', 'public.layouts', 'select') or has_table_privilege('anon', 'public.layout_versions', 'select')
     or has_function_privilege('authenticated', 'public.layout_publish(uuid, jsonb, jsonb, boolean, text, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.layout_rollback(uuid, integer, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.screen_state(text, text, text, jsonb)', 'execute')
     or not has_column_privilege('authenticated', 'public.screens', 'layout_id', 'select')
     or not has_column_privilege('authenticated', 'public.screens', 'property_id', 'select')
     or has_column_privilege('authenticated', 'public.layouts', 'draft', 'update') then
    fails := fails || '10 permissions'::text;
  end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 10 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
