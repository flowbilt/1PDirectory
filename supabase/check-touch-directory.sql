-- Confirms 28-touch-directory.sql works. Run after 28: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 6 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Changes users make are made here as a signed-in user, as the console and editor do.
do $$
declare
  v_org    uuid;
  v_other  uuid;
  v_prop   uuid;
  v_dir    uuid;
  v_scr    uuid;
  v_co     uuid;
  v_n      integer;
  u_owner  uuid := gen_random_uuid();
  u_stray  uuid := gen_random_uuid();
  r        jsonb;
  v_etag   text;
  fails    text[] := '{}';
begin
  insert into public.organizations (name) values ('Touch directory test owner') returning id into v_org;
  insert into public.organizations (name) values ('Touch directory test stranger') returning id into v_other;
  insert into public.properties (org_id, name) values (v_org, 'Touch directory test building') returning id into v_prop;
  insert into public.directories (property_id, slug, title) values (v_prop, 'touchdir-test', 'Touch directory test') returning id into v_dir;
  insert into public.screens (directory_id, key, name, touch) values (v_dir, 'touchdir-test-screen', 'Touch directory test screen', true) returning id into v_scr;
  insert into public.tenants (directory_id, sort, name, suite) values (v_dir, 0, 'Touch Test Co', '300');
  insert into auth.users (id, email) values (u_owner, 'touchdir-owner@example.com'), (u_stray, 'touchdir-stray@example.com');
  insert into public.profiles (user_id, email, role, org_id) values (u_owner, 'touchdir-owner@example.com', 'org_editor', v_org),
                                                                    (u_stray, 'touchdir-stray@example.com', 'org_admin', v_other);

  -- 1. Defaults: 45 seconds, no keyboard
  if (select touch_idle_s from public.screens where id = v_scr) <> 45 or (select touch_keyboard from public.directories where id = v_dir) then
    fails := fails || '1 defaults'::text;
  end if;

  -- 2. 15 to 300 seconds only
  update public.screens set touch_idle_s = 15 where id = v_scr;
  update public.screens set touch_idle_s = 300 where id = v_scr;
  begin
    update public.screens set touch_idle_s = 14 where id = v_scr;
    fails := fails || '2 14 seconds accepted'::text;
  exception when check_violation then null;
  end;
  begin
    update public.screens set touch_idle_s = 301 where id = v_scr;
    fails := fails || '2 301 seconds accepted'::text;
  exception when check_violation then null;
  end;

  -- 3. The screen gets its idle time, and a change changes its version
  update public.screens set touch_idle_s = 45 where id = v_scr;
  r := public.screen_state('touchdir-test-screen', null, null, null);
  v_etag := r ->> 'etag';
  if (r -> 'screen' ->> 'touch_idle_s')::integer is distinct from 45 then fails := fails || format('3 screen gets %s', r -> 'screen'); end if;
  update public.screens set touch_idle_s = 90 where id = v_scr;
  if coalesce((public.screen_state('touchdir-test-screen', null, v_etag, null) ->> 'not_modified')::boolean, false) then
    fails := fails || '3 the version didn''t change'::text;
  end if;

  -- 4. The owner's own user turns the keyboard on in the editor, signed in; it reaches the screen; a stranger can't
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  update public.directories set touch_keyboard = true where id = v_dir;
  perform set_config('request.jwt.claims', json_build_object('sub', u_stray, 'role', 'authenticated')::text, true);
  update public.directories set touch_keyboard = false where id = v_dir;
  -- 5. ...and the owner can read the idle time but not change it (Screen settings are 1Point's)
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.screens where id = v_scr and touch_idle_s = 90;
  update public.screens set touch_idle_s = 20 where id = v_scr;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  if not (select touch_keyboard from public.directories where id = v_dir)
     or not coalesce((public.screen_state('touchdir-test-screen', null, null, null) -> 'dir' ->> 'touch_keyboard')::boolean, false) then
    fails := fails || '4 keyboard switch'::text;
  end if;
  if v_n <> 1 or (select touch_idle_s from public.screens where id = v_scr) <> 90 then fails := fails || format('5 owner read %s / idle now %s', v_n, (select touch_idle_s from public.screens where id = v_scr)); end if;

  -- 6. Round 14's people still reach a touch screen with the owner's switch on (screen_state kept them)
  select company_id into v_co from public.tenants where directory_id = v_dir;
  update public.companies set show_people = true where id = v_co;
  insert into public.people (company_id, first_name, last_name) values (v_co, 'Touch', 'Person');
  r := public.screen_state('touchdir-test-screen', null, null, null);
  if r -> 'tenants' -> 0 -> 'people' -> 0 ->> 'last' is distinct from 'Person'
     or has_function_privilege('authenticated', 'public.screen_state(text,text,text,jsonb)', 'execute') then
    fails := fails || format('6 people or permissions: %s', r -> 'tenants');
  end if;

  if cardinality(fails) = 0 then
    raise exception 'ALL 6 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else
    raise exception 'FAILED: %', array_to_string(fails, ' || ');
  end if;
end $$;
