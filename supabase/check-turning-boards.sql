-- Confirms 46-turning-boards.sql works. Run after 46: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 4 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Choosing the layout for a screen is tried as a signed-in 1Point user, as the console does it; publishing as the site.
do $$
declare
  u_admin uuid := gen_random_uuid();
  v_org uuid; v_prop uuid; v_lay uuid; v_flat uuid; v_scr uuid;
  turns jsonb := '{"format":1,"orientation":"landscape","grid":{"cols":24,"rows":13},"blocks":[{"id":"a","type":"text","at":{"col":1,"row":1,"w":12,"h":2},"content":{"title":"One"}}],"turned":{"grid":{"cols":12,"rows":24},"blocks":{"a":{"at":{"col":1,"row":1,"w":12,"h":2}}}}}';
  flat jsonb := '{"format":1,"orientation":"landscape","grid":{"cols":24,"rows":13},"blocks":[{"id":"a","type":"text","at":{"col":1,"row":1,"w":12,"h":2},"content":{"title":"Two"}}]}';
  fails text[] := '{}';
begin
  insert into public.organizations (name) values ('Turning test') returning id into v_org;
  insert into public.properties (org_id, name, timezone, lat, lon) values (v_org, 'Turning test shop', 'America/Chicago', 33.3, -86.8) returning id into v_prop;
  insert into auth.users (id, email) values (u_admin, 'turning-admin@example.com');
  insert into public.profiles (user_id, email, role, org_id) values (u_admin, 'turning-admin@example.com', 'platform_admin', null);
  insert into public.layouts (org_id, name, family, orientation) values (v_org, 'Turning board', 'menu', 'landscape') returning id into v_lay;
  insert into public.layouts (org_id, name, family, orientation) values (v_org, 'Flat board', 'menu', 'landscape') returning id into v_flat;
  perform public.layout_publish(v_lay, turns, '{}', false, 'turns', u_admin);
  perform public.layout_publish(v_flat, flat, '{}', false, 'flat', u_admin);

  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  -- 1. A landscape layout that turns goes on a Portrait screen
  begin
    insert into public.screens (key, name, layout_id, property_id, orientation) values ('turning-test-screen', 'Turning test screen', v_lay, v_prop, 'portrait') returning id into v_scr;
  exception when others then fails := fails || format('1 refused: %s', sqlerrm);
  end;
  -- 2. One that doesn't turn is still refused on it, saying how to fix it
  begin
    insert into public.screens (key, name, layout_id, property_id, orientation) values ('turning-test-flat', 'Turning test flat', v_flat, v_prop, 'portrait-flipped');
    fails := fails || '2 a flat landscape layout went on a portrait screen'::text;
  exception when check_violation then if sqlerrm not like '%give this one a portrait arrangement%' then fails := fails || format('2 message: %s', sqlerrm); end if;
  end;
  perform set_config('role', 'none', true);

  -- 3. A new version without the arrangement is refused while the screen shows it in portrait
  begin
    perform public.layout_publish(v_lay, flat, '{}', false, 'drops it', u_admin);
    fails := fails || '3 a version without turned was published'::text;
  exception when check_violation then if sqlerrm not like '%has no portrait arrangement%' then fails := fails || format('3 message: %s', sqlerrm); end if;
  end;
  -- 4. With the screen back to Landscape, it can be published (and the screen still works)
  if v_scr is not null then
    update public.screens set orientation = 'landscape' where id = v_scr;
    begin perform public.layout_publish(v_lay, flat, '{}', false, 'flat now', u_admin);
    exception when others then fails := fails || format('4 refused: %s', sqlerrm); end;
  end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 4 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
