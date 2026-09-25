-- Confirms 06-trust.sql works. Run after 06: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 9 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
do $$
declare
  t_reg   text := 'feedc0de00000002';   -- made-up Pis and a made-up screen, removed again when the test ends
  t_new   text := 'feedc0de00000003';
  shot    text := 'data:image/jpeg;base64,/9j/4AAQ';
  r jsonb;
  v_dev uuid;
  v_scr uuid;
  fails text[] := '{}';
begin
  insert into public.screens (key, name) values ('zz-trust-test', 'Trust test') returning id into v_scr;
  insert into public.devices (serial, screen_id) values (t_reg, v_scr) returning id into v_dev;

  -- 1. A pre-registered Pi with no window open is refused, and nothing is recorded
  r := public.agent_checkin(t_reg, 'hash-a', '{}', '{}', shot, null);
  if coalesce(r ->> 'refused', '') <> 'enroll' then fails := fails || format('1 no window: %s', r); end if;
  if (select key_hash is not null or last_seen is not null from public.devices where id = v_dev) then fails := fails || '1 refused Pi was recorded'::text; end if;

  -- 2. An expired window is still closed
  update public.devices set enroll_until = now() - interval '1 minute' where id = v_dev;
  r := public.agent_checkin(t_reg, 'hash-a', '{}', '{}', null, null);
  if coalesce(r ->> 'refused', '') <> 'enroll' then fails := fails || format('2 expired window: %s', r); end if;

  -- 3. With the window open it enrolls, finds its screen, and the window closes behind it
  update public.devices set enroll_until = now() + interval '24 hours' where id = v_dev;
  r := public.agent_checkin(t_reg, 'hash-a', '{}', '{}', shot, null);
  if r ->> 'refused' is not null or coalesce(r ->> 'screen', '') <> 'zz-trust-test' then fails := fails || format('3 enroll: %s', r); end if;
  if not exists (select 1 from public.devices where id = v_dev and key_hash = 'hash-a' and enroll_until is null and screenshot = shot) then
    fails := fails || '3 key, window or screenshot wrong after enrolling'::text;
  end if;

  -- 4. Once enrolled, a different key is refused
  r := public.agent_checkin(t_reg, 'hash-b', '{}', '{}', null, null);
  if coalesce(r ->> 'refused', '') <> 'key' then fails := fails || format('4 second key: %s', r); end if;

  -- 5. After a reset (key cleared, window opened) a new key is accepted
  update public.devices set key_hash = null, enroll_until = now() + interval '24 hours' where id = v_dev;
  r := public.agent_checkin(t_reg, 'hash-b', '{}', '{}', null, null);
  if r ->> 'refused' is not null then fails := fails || format('5 re-enroll: %s', r); end if;

  -- 6. A Pi that isn't registered enrolls on first contact, but no screenshot is kept while it's unassigned
  r := public.agent_checkin(t_new, 'hash-n', '{}', '{}', shot, null);
  if r ->> 'refused' is not null then fails := fails || format('6 new Pi: %s', r); end if;
  if not exists (select 1 from public.devices where serial = t_new and key_hash = 'hash-n' and screenshot = '' and screenshot_at is null) then
    fails := fails || '6 unassigned Pi stored a screenshot or no key'::text;
  end if;

  -- 7. A switched-off Pi is refused
  update public.devices set status = 'revoked' where id = v_dev;
  r := public.agent_checkin(t_reg, 'hash-b', '{}', '{}', null, null);
  if coalesce(r ->> 'refused', '') <> 'revoked' then fails := fails || format('7 revoked: %s', r); end if;

  -- 8. Signed-in users can read screen names but not hardware; nobody but the server calls agent_checkin
  if has_column_privilege('authenticated', 'public.screens', 'hardware', 'select')
     or has_column_privilege('anon', 'public.screens', 'hardware', 'select')
     or not has_column_privilege('authenticated', 'public.screens', 'name', 'select')
     or not has_column_privilege('authenticated', 'public.screens', 'identify_until', 'select')
     or has_function_privilege('anon', 'public.agent_checkin(text,text,jsonb,jsonb,text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.agent_checkin(text,text,jsonb,jsonb,text,jsonb)', 'execute') then
    fails := fails || '8 column or function permissions wrong'::text;
  end if;

  -- 9. PPI 2 South's name is fixed
  if not exists (select 1 from public.screens where key = 'ppi-2s' and name = 'TBC - PPI - 2 S - 194292') then
    fails := fails || format('9 ppi-2s name: %s', (select name from public.screens where key = 'ppi-2s'));
  end if;

  if cardinality(fails) = 0 then
    raise exception 'ALL 9 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else
    raise exception 'FAILED: %', array_to_string(fails, ' || ');
  end if;
end $$;
