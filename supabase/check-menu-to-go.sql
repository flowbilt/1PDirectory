-- Confirms 31-menu-to-go.sql works. Run after 31: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 7 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Adding a layout (which makes its code) and reading the opens are tried as signed-in users, as in the console.
do $$
declare
  u_admin  uuid := gen_random_uuid();
  u_owner  uuid := gen_random_uuid();
  u_other  uuid := gen_random_uuid();
  v_org    uuid;
  v_org2   uuid;
  v_propa  uuid;
  v_propb  uuid;
  v_lay    uuid;
  v_code   text;
  r        jsonb;
  doc      jsonb := '{"format":1,"orientation":"portrait","grid":{"cols":12,"rows":24},"blocks":[{"id":"hero","type":"photo","at":{"col":1,"row":1,"w":12,"h":6},"content":{"image":"img:menu-check"}}]}';
  fails    text[] := '{}';
begin
  insert into public.organizations (name) values ('Menu test owner') returning id into v_org;
  insert into public.organizations (name) values ('Menu test stranger') returning id into v_org2;
  insert into public.properties (org_id, name, timezone) values (v_org, 'Menu test B shop', 'America/Chicago') returning id into v_propb;
  insert into public.properties (org_id, name, timezone) values (v_org, 'Menu test A shop', 'America/New_York') returning id into v_propa;
  insert into auth.users (id, email) values (u_admin, 'menu-admin@example.com'), (u_owner, 'menu-owner@example.com'), (u_other, 'menu-other@example.com');
  insert into public.profiles (user_id, email, role, org_id) values (u_admin, 'menu-admin@example.com', 'platform_admin', null),
                                                                    (u_owner, 'menu-owner@example.com', 'org_admin', v_org),
                                                                    (u_other, 'menu-other@example.com', 'org_admin', v_org2);
  insert into public.layout_images (org_id, key, name, path, mime, width, height, bytes)
    values (v_org, 'menu-check', 'Menu check', v_org || '/menu-check-1a2b3c4d.webp', 'image/webp', 1200, 900, 200000);

  -- 1. Every layout has a code, six letters and digits with no look-alikes
  if exists (select 1 from public.layouts where menu_code is null or menu_code !~ '^[A-HJKMNP-Z2-9]{6}$') then
    fails := fails || '1 a layout without a proper code'::text;
  end if;

  -- 2. 1Point adds a layout in the console (signed in): it gets its code; nobody signed in can change a code
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  insert into public.layouts (org_id, name, orientation) values (v_org, 'Menu test layout', 'portrait') returning id, menu_code into v_lay, v_code;
  if v_code is null or v_code !~ '^[A-HJKMNP-Z2-9]{6}$' then fails := fails || format('2 the new layout''s code: %s', v_code); end if;
  begin
    update public.layouts set menu_code = 'ABCDEF' where id = v_lay;
    fails := fails || '2 a signed-in user changed a code'::text;
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);

  -- 3. The phone page: nothing until published; then the published version, its pictures and a building; each open counted
  if not coalesce((public.menu_page(v_code) ->> 'missing')::boolean, false) then fails := fails || '3 an unpublished layout showed'::text; end if;
  if coalesce((public.menu_page('ZZZZZZ') ->> 'missing')::boolean, false) is not true then fails := fails || '3 an unknown code'::text; end if;
  perform public.layout_publish(v_lay, doc, '{}', false, '', u_admin);
  r := public.menu_page(lower(v_code));
  if r -> 'layout' -> 'doc' is distinct from doc or (r -> 'layout' ->> 'version')::int <> 1 or r -> 'layout' ->> 'menu_code' <> v_code
     or r -> 'images' -> 'menu-check' ->> 'path' is distinct from v_org || '/menu-check-1a2b3c4d.webp' then
    fails := fails || format('3 the page''s content %s', r);
  end if;
  perform public.menu_page(v_code, false);
  if (select scans from public.menu_scans where layout_id = v_lay) is distinct from 1 then fails := fails || '3 opens counted wrongly'::text; end if;

  -- 4. Its building: with no screen showing it, the account's first by name; then the building of the screen showing it
  if r -> 'prop' ->> 'id' is distinct from v_propa::text then fails := fails || '4 the first building by name'::text; end if;
  insert into public.screens (key, name, layout_id, property_id, orientation, last_seen) values ('menu-test-screen', 'Menu test screen', v_lay, v_propb, 'portrait', now());
  r := public.menu_page(v_code, false);
  if r -> 'prop' ->> 'id' is distinct from v_propb::text or r -> 'prop' ->> 'timezone' <> 'America/Chicago' then fails := fails || '4 the screen''s building'::text; end if;

  -- 5. The layout screen's answer carries the menu code (for the QR block)
  r := public.screen_state('menu-test-screen', null, null, null);
  if r -> 'layout' ->> 'menu_code' is distinct from v_code then fails := fails || format('5 screen answer %s', r -> 'layout'); end if;

  -- 6. The opens: the account's owner sees them, a stranger is refused
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_scan_count(v_lay);
  if (r ->> 'total')::int <> 1 or (r ->> 'last30')::int <> 1 then fails := fails || format('6 owner''s count %s', r); end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u_other, 'role', 'authenticated')::text, true);
  begin
    perform public.menu_scan_count(v_lay);
    fails := fails || '6 a stranger saw the opens'::text;
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);

  -- 7. Permissions: the page's content and the code maker are the site's only; the opens table is closed
  if has_function_privilege('authenticated', 'public.menu_page(text, boolean)', 'execute')
     or has_function_privilege('anon', 'public.menu_page(text, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.menu_new_code_value()', 'execute')
     or has_table_privilege('authenticated', 'public.menu_scans', 'select')
     or has_table_privilege('anon', 'public.menu_scans', 'select') then
    fails := fails || '7 permissions'::text;
  end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 7 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
