-- Confirms 50-directory-look.sql works. Run after 50: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 4 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Saves are made here as signed-in users (the building's editor, and someone from another company), as the editor does.
do $$
declare
  v_org uuid; v_other uuid; v_prop uuid; v_dir uuid; v_n integer;
  u_owner uuid := gen_random_uuid();
  u_stray uuid := gen_random_uuid();
  fails text[] := '{}';
  v_when jsonb := '{"day": "light", "evening": "dark", "dayAt": "06:00", "eveningAt": "17:00", "sun": true}';
  v_bad jsonb[] := array[
    '{"day": "dark", "evening": "dark", "dayAt": "06:00", "eveningAt": "17:00"}',          -- the same look twice
    '{"day": "light", "evening": "dark", "dayAt": "17:00", "eveningAt": "17:00"}',         -- the same time twice
    '{"day": "light", "evening": "dark", "dayAt": "6 am", "eveningAt": "17:00"}',          -- not a time
    '{"day": "light", "evening": "chalkboard", "dayAt": "06:00", "eveningAt": "17:00"}',   -- a menu board's look
    '{"day": "light", "evening": "dark", "dayAt": "06:00", "eveningAt": "17:00", "days": [1]}',
    '{"day": "light", "evening": "dark", "dayAt": "06:00", "eveningAt": "17:00", "sun": "yes"}',
    '"light"']::jsonb[];
  b jsonb;
begin
  insert into public.organizations (name) values ('Directory look test owner') returning id into v_org;
  insert into public.organizations (name) values ('Directory look test stranger') returning id into v_other;
  insert into public.properties (org_id, name) values (v_org, 'Directory look test building') returning id into v_prop;
  insert into public.directories (property_id, slug, title) values (v_prop, 'dirlook-test', 'Directory look test') returning id into v_dir;
  insert into auth.users (id, email) values (u_owner, 'dirlook-owner@example.com'), (u_stray, 'dirlook-stray@example.com');
  insert into public.profiles (user_id, email, role, org_id) values (u_owner, 'dirlook-owner@example.com', 'org_editor', v_org),
                                                                    (u_stray, 'dirlook-stray@example.com', 'org_admin', v_other);

  -- 1. Defaults: Dark, no schedule
  if (select look from public.directories where id = v_dir) <> 'dark' or (select look_when from public.directories where id = v_dir) is not null then
    fails := fails || '1 defaults'::text;
  end if;

  -- 2. The building's editor picks Light, then sets the look by the time of day with sunrise and sunset: kept
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  update public.directories set look = 'light' where id = v_dir;
  update public.directories set look_when = v_when where id = v_dir;
  perform set_config('role', 'none', true);
  if (select look from public.directories where id = v_dir) <> 'light' then fails := fails || '2 Light not kept'::text; end if;
  if (select look_when from public.directories where id = v_dir) is distinct from v_when then fails := fails || '2 the schedule not kept'::text; end if;

  -- 3. Only real looks and schedules; a refused save changes nothing
  perform set_config('role', 'authenticated', true);
  begin update public.directories set look = 'neon' where id = v_dir; fails := fails || '3 neon look'::text;
  exception when check_violation then null; end;
  foreach b in array v_bad loop
    begin update public.directories set look_when = b where id = v_dir; fails := fails || format('3 accepted %s', b);
    exception when check_violation then null; end;
  end loop;
  perform set_config('role', 'none', true);
  if (select look_when from public.directories where id = v_dir) is distinct from v_when then fails := fails || '3 a refused save changed it'::text; end if;

  -- 4. Someone from another company can't change it; clearing the schedule goes back to the fixed look
  perform set_config('request.jwt.claims', json_build_object('sub', u_stray, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  update public.directories set look = 'dark', look_when = null where id = v_dir;
  get diagnostics v_n = row_count;
  perform set_config('role', 'none', true);
  if v_n <> 0 or (select look from public.directories where id = v_dir) <> 'light' then fails := fails || '4 a stranger changed it'::text; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  update public.directories set look_when = null where id = v_dir;
  perform set_config('role', 'none', true);
  if (select look_when from public.directories where id = v_dir) is not null then fails := fails || '4 schedule not cleared'::text; end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 4 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
