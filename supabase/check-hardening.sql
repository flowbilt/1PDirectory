-- Confirms 17-hardening.sql works. Run after 17: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 8 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
do $$
declare
  v_dev   uuid;
  v_other uuid;
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_ids   bigint[] := '{}';
  v_id    bigint;
  r       record;
  j       jsonb;
  i       int;
  fails   text[] := '{}';
begin
  insert into public.devices (serial) values ('feedc0de000000a1') returning id into v_dev;
  insert into public.devices (serial) values ('feedc0de000000a2') returning id into v_other;

  -- Eight actions on one Pi: six from 100 days ago, two from today; one action on another Pi
  for i in 1..8 loop
    insert into public.device_commands (device_id, command, status, result, created_at)
    values (v_dev, 'reload', 'done', 'r' || i, case when i <= 6 then now() - interval '100 days' else now() end)
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  insert into public.device_commands (device_id, command, status) values (v_other, 'reboot', 'done');

  -- 1. The latest five per Pi, newest first, one row per Pi
  select count(*) into i from public.recent_device_commands(array[v_dev, v_other], 5);
  if i <> 2 then fails := fails || format('1 one row per Pi: %s rows', i); end if;

  -- 2. ...and for this Pi exactly its five newest, newest first, with nothing beyond the listed fields
  select commands into j from public.recent_device_commands(array[v_dev], 5);
  if jsonb_array_length(j) <> 5 or (j -> 0 ->> 'id')::bigint <> v_ids[8] or (j -> 4 ->> 'id')::bigint <> v_ids[4]
     or (j -> 0) ? 'payload' or (j -> 0 ->> 'command') <> 'reload' then
    fails := fails || format('2 newest five: %s', j);
  end if;

  -- 35 days of history: a check-in a minute, a power dip a day, temperatures 40 + days ago.
  -- Today's row is from before 07-uptime.sql (no online_s): counted as a minute per check-in (10 -> 600 s).
  for i in 0..34 loop
    insert into public.device_daily (device_id, day, checkins, online_s, power_dips, browser_down, max_temp_c, first_at)
    values (v_dev, v_today - i, case when i = 0 then 10 else 60 end, case when i = 0 then null else 3600 end,
            1, case when i < 7 then 2 else 0 end, 40 + i, (v_today - i)::timestamp + interval '8 hours');
  end loop;
  select * into r from public.health_window(v_today) where device_id = v_dev;

  -- 3. Uptime seconds for today, 7 days and 30 days
  if r.up_s_1 <> 600 or r.up_s_7 <> 600 + 6 * 3600 or r.up_s_30 <> 600 + 29 * 3600 then
    fails := fails || format('3 uptime seconds: %s %s %s', r.up_s_1, r.up_s_7, r.up_s_30);
  end if;

  -- 4. Power dips, browser stops and the hottest day of the week
  if r.dips_7 <> 7 or r.dips_30 <> 30 or r.browser_down_7 <> 14 or r.max_temp_7 <> 46 then
    fails := fails || format('4 dips, browser, temperature: %s %s %s %s', r.dips_7, r.dips_30, r.browser_down_7, r.max_temp_7);
  end if;

  -- 5. The window starts 29 days back, with that day's first check-in
  if r.first_day <> v_today - 29 or r.first_at <> (v_today - 29)::timestamp + interval '8 hours' then
    fails := fails || format('5 first day: %s %s', r.first_day, r.first_at);
  end if;

  -- 6. Trimming: actions over 90 days old go, except each Pi's newest five; today's stay
  insert into public.device_daily (device_id, day, checkins) values (v_dev, v_today - 401, 1), (v_dev, v_today - 399, 1);
  j := public.trim_device_history();
  if exists (select 1 from public.device_commands where id = any (v_ids[1:3]))
     or (select count(*) from public.device_commands where id = any (v_ids)) <> 5
     or not exists (select 1 from public.device_commands where device_id = v_other) then
    fails := fails || format('6 trimming actions: %s', j);
  end if;

  -- 7. Daily history over 400 days old goes, newer stays
  if exists (select 1 from public.device_daily where device_id = v_dev and day = v_today - 401)
     or not exists (select 1 from public.device_daily where device_id = v_dev and day = v_today - 399) then
    fails := fails || format('7 trimming days: %s', j);
  end if;

  -- 8. Server only: no one signed in (or not) can call them
  if has_function_privilege('anon', 'public.recent_device_commands(uuid[], integer)', 'execute')
     or has_function_privilege('authenticated', 'public.recent_device_commands(uuid[], integer)', 'execute')
     or has_function_privilege('anon', 'public.health_window(date)', 'execute')
     or has_function_privilege('authenticated', 'public.health_window(date)', 'execute')
     or has_function_privilege('anon', 'public.trim_device_history()', 'execute')
     or has_function_privilege('authenticated', 'public.trim_device_history()', 'execute')
     or not has_function_privilege('service_role', 'public.health_window(date)', 'execute') then
    fails := fails || '8 permissions'::text;
  end if;

  if cardinality(fails) = 0 then
    raise exception 'ALL 8 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else
    raise exception 'FAILED: %', array_to_string(fails, ' || ');
  end if;
end $$;
