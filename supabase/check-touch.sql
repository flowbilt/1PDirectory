-- Confirms 25-touch.sql works. Run after 25: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 5 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
do $$
declare
  v_org  uuid;
  v_prop uuid;
  v_dir  uuid;
  v_scr  uuid;
  v_etag text;
  r      jsonb;
  fails  text[] := '{}';
begin
  insert into public.organizations (name) values ('Touch test owner') returning id into v_org;
  insert into public.properties (org_id, name) values (v_org, 'Touch test building') returning id into v_prop;
  insert into public.directories (property_id, slug, title) values (v_prop, 'touch-test-dir', 'Touch test') returning id into v_dir;
  insert into public.screens (directory_id, key, name) values (v_dir, 'touch-test-screen', 'Touch test screen') returning id into v_scr;

  -- 1. A new screen is display-only, with no size given
  if (select touch from public.screens where id = v_scr) or (select screen_inches from public.screens where id = v_scr) is not null then
    fails := fails || '1 defaults'::text;
  end if;

  -- 2. Sizes from 7 to 100 inches, or blank
  update public.screens set screen_inches = 13.3 where id = v_scr;
  update public.screens set screen_inches = null where id = v_scr;
  begin
    update public.screens set screen_inches = 6 where id = v_scr;
    fails := fails || '2 six inches accepted'::text;
  exception when check_violation then null;
  end;
  begin
    update public.screens set screen_inches = 101 where id = v_scr;
    fails := fails || '2 101 inches accepted'::text;
  exception when check_violation then null;
  end;

  -- 3. The screen gets both
  update public.screens set touch = true, screen_inches = 13.3 where id = v_scr;
  r := public.screen_state('touch-test-screen', null, null, null) -> 'screen';
  if not coalesce((r ->> 'touch')::boolean, false) or (r ->> 'screen_inches')::numeric <> 13.3 then
    fails := fails || format('3 screen: %s', r);
  end if;

  -- 4. Changing either one changes the screen's version, so it picks the change up
  v_etag := public.screen_state('touch-test-screen', null, null, null) ->> 'etag';
  update public.screens set touch = false where id = v_scr;
  if coalesce((public.screen_state('touch-test-screen', null, v_etag, null) ->> 'not_modified')::boolean, false) then
    fails := fails || '4 touch switch kept the old version'::text;
  end if;
  v_etag := public.screen_state('touch-test-screen', null, null, null) ->> 'etag';
  update public.screens set screen_inches = 32 where id = v_scr;
  if coalesce((public.screen_state('touch-test-screen', null, v_etag, null) ->> 'not_modified')::boolean, false) then
    fails := fails || '4 size kept the old version'::text;
  end if;

  -- 5. Signed-in users can read both (writing screens stays 1Point's); visitors can't
  if not has_column_privilege('authenticated', 'public.screens', 'touch', 'select')
     or not has_column_privilege('authenticated', 'public.screens', 'screen_inches', 'select')
     or has_column_privilege('anon', 'public.screens', 'touch', 'select') then
    fails := fails || '5 permissions'::text;
  end if;

  if cardinality(fails) = 0 then
    raise exception 'ALL 5 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else
    raise exception 'FAILED: %', array_to_string(fails, ' || ');
  end if;
end $$;
