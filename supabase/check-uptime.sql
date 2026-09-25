-- Confirms 07-uptime.sql works. Run after 07: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 10 CHECKS PASSED"  means everything works.
--   "FAILED: ..."           lists what didn't. Copy the whole message to Claude.
do $$
declare
  t_new  text := 'feedc0de00000004';   -- made-up Pis, removed again when the test ends
  t_reg  text := 'feedc0de00000005';
  t      timestamptz := '2026-10-02 15:00:00-05';
  r jsonb;
  v_dev uuid;
  v_day date := (now() at time zone 'America/Chicago')::date;
  v_before int;
  fails text[] := '{}';
begin
  -- 1-6. The credit itself, at chosen times
  if public.device_credit(null, t) <> array[0, 0] then fails := fails || '1 first check-in should credit nothing'::text; end if;
  if public.device_credit(t - interval '50 seconds', t) <> array[50, 0] then fails := fails || format('2 a 50 s gap: %s', public.device_credit(t - interval '50 seconds', t)); end if;
  if public.device_credit(t - interval '180 seconds', t) <> array[180, 0]
     or public.device_credit(t - interval '181 seconds', t) <> array[0, 0] then fails := fails || '3 the 3-minute limit'::text; end if;
  if public.device_credit('2026-10-02 23:59:20-05', '2026-10-03 00:00:30-05') <> array[30, 40] then
    fails := fails || format('4 split at midnight: %s', public.device_credit('2026-10-02 23:59:20-05', '2026-10-03 00:00:30-05'));
  end if;
  if public.device_credit('2026-10-31 23:59:00-05', '2026-11-01 00:01:00-05') <> array[60, 60] then
    fails := fails || format('5 midnight before the clocks change: %s', public.device_credit('2026-10-31 23:59:00-05', '2026-11-01 00:01:00-05'));
  end if;
  if public.device_credit(t, t - interval '10 seconds') <> array[0, 0] then fails := fails || '6 a clock that went backwards credits nothing'::text; end if;

  -- 7. A new Pi's first check-in: counted, but no time credited yet
  r := public.agent_checkin(t_new, 'hash-n', '{}', '{}', null, null);
  select id into v_dev from public.devices where serial = t_new;
  if not exists (select 1 from public.device_daily where device_id = v_dev and day = v_day and checkins = 1 and online_s = 0) then
    fails := fails || format('7 first check-in: %s', (select to_jsonb(x) from public.device_daily x where device_id = v_dev));
  end if;

  -- 8. The previous check-in 50 seconds ago: 50 seconds credited (split, if this runs just after midnight)
  update public.devices set last_seen = now() - interval '50 seconds' where id = v_dev;
  select coalesce(sum(online_s), 0) into v_before from public.device_daily where device_id = v_dev;
  r := public.agent_checkin(t_new, 'hash-n', '{}', '{}', null, null);
  if (select sum(online_s) from public.device_daily where device_id = v_dev) - v_before
     <> (public.device_credit(now() - interval '50 seconds', now()))[1] then
    fails := fails || format('8 50 s credit: %s', (select jsonb_agg(to_jsonb(x)) from public.device_daily x where device_id = v_dev));
  end if;

  -- 9. The previous check-in 5 minutes ago: an outage, nothing credited, but the check-in still counts
  update public.devices set last_seen = now() - interval '5 minutes' where id = v_dev;
  select coalesce(sum(online_s), 0) into v_before from public.device_daily where device_id = v_dev;
  r := public.agent_checkin(t_new, 'hash-n', '{}', '{}', null, null);
  if (select sum(online_s) from public.device_daily where device_id = v_dev) <> v_before
     or not exists (select 1 from public.device_daily where device_id = v_dev and day = v_day and checkins = 3) then
    fails := fails || format('9 after an outage: %s', (select jsonb_agg(to_jsonb(x)) from public.device_daily x where device_id = v_dev));
  end if;

  -- 10. Round 1 still holds: a registered Pi with no window is refused; only the server calls these functions
  insert into public.devices (serial) values (t_reg);
  r := public.agent_checkin(t_reg, 'hash-r', '{}', '{}', null, null);
  if coalesce(r ->> 'refused', '') <> 'enroll'
     or has_function_privilege('anon', 'public.device_credit(timestamptz,timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.device_credit(timestamptz,timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.agent_checkin(text,text,jsonb,jsonb,text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.agent_checkin(text,text,jsonb,jsonb,text,jsonb)', 'execute') then
    fails := fails || format('10 enrollment or permissions: %s', r);
  end if;

  if cardinality(fails) = 0 then
    raise exception 'ALL 10 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else
    raise exception 'FAILED: %', array_to_string(fails, ' || ');
  end if;
end $$;
