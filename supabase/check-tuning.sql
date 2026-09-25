-- Confirms 05-tuning.sql works. Run after 05: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 10 CHECKS PASSED"  means everything works.
--   "FAILED: ..."           lists what didn't. Copy the whole message to Claude.
do $$
declare
  t_serial text := 'feedc0de00000001';   -- a made-up Pi, removed again when the test ends
  r jsonb;
  v_dev uuid;
  v_cmd bigint;
  v_etag text;
  fails text[] := '{}';
begin
  -- 1. A new Pi enrolls
  r := public.agent_checkin(t_serial, 'hash-a', '{"model":"test","hostname":"t","version":"9"}', '{"temp_c":50,"under_voltage_now":true}', null, null);
  if r ->> 'refused' is not null or r -> 'commands' <> '[]'::jsonb then fails := fails || format('1 enroll: %s', r); end if;
  select id into v_dev from public.devices where serial = t_serial;

  -- 2. A different key is refused
  r := public.agent_checkin(t_serial, 'hash-b', '{}', '{}', null, null);
  if coalesce(r ->> 'refused', '') <> 'key' then fails := fails || format('2 wrong key: %s', r); end if;

  -- 3. A queued command is delivered once
  insert into public.device_commands (device_id, command) values (v_dev, 'reload') returning id into v_cmd;
  r := public.agent_checkin(t_serial, 'hash-a', '{}', '{"temp_c":62,"under_voltage_now":true}', null, null);
  if (r -> 'commands' -> 0 ->> 'id')::bigint is distinct from v_cmd then fails := fails || format('3 deliver: %s', r); end if;
  r := public.agent_checkin(t_serial, 'hash-a', '{}', '{"under_voltage_now":true}', null, null);
  if r -> 'commands' <> '[]'::jsonb then fails := fails || format('3 delivered twice: %s', r); end if;

  -- 4. The Pi's result is recorded
  r := public.agent_checkin(t_serial, 'hash-a', '{}', '{}', null, jsonb_build_array(jsonb_build_object('id', v_cmd, 'status', 'done', 'result', 'ok')));
  if (select status from public.device_commands where id = v_cmd) <> 'done' then fails := fails || '4 result not recorded'::text; end if;

  -- 5. Old commands expire
  insert into public.device_commands (device_id, command, created_at) values (v_dev, 'reboot', now() - interval '2 hours') returning id into v_cmd;
  r := public.agent_checkin(t_serial, 'hash-a', '{}', '{}', null, null);
  if (select status from public.device_commands where id = v_cmd) <> 'expired' then fails := fails || '5 old command not expired'::text; end if;

  -- 6. Daily summary: 5 accepted check-ins (the refused one doesn't count), 3 power dips, peak 62
  if not exists (select 1 from public.device_daily where device_id = v_dev and checkins = 5 and power_dips = 3 and max_temp_c = 62) then
    fails := fails || format('6 daily summary: %s', (select to_jsonb(x) from public.device_daily x where device_id = v_dev));
  end if;

  -- 7. An unassigned Pi's screen says it's new
  r := public.screen_state(null, t_serial, null, null);
  if coalesce(r ->> 'new_device', '') <> 'true' then fails := fails || format('7 new device: %s', r); end if;

  -- 8. A real screen gets its directory, then "not modified" when nothing changed
  r := public.screen_state('ppi-2s', null, null, null);
  v_etag := r ->> 'etag';
  if v_etag is null or jsonb_array_length(r -> 'tenants') < 1 or r -> 'prop' is null then fails := fails || '8 ppi-2s payload missing parts'::text; end if;
  r := public.screen_state('ppi-2s', null, v_etag, null);
  if coalesce(r ->> 'not_modified', '') <> 'true' then fails := fails || format('8 not-modified: %s', r); end if;

  -- 9. Editing a tenant changes the version
  update public.tenants set note = note where directory_id = (select directory_id from public.screens where key = 'ppi-2s');
  r := public.screen_state('ppi-2s', null, v_etag, null);
  if r ->> 'not_modified' = 'true' then fails := fails || '9 tenant edit not noticed'::text; end if;

  -- 10. Nobody but the server can call them
  if has_function_privilege('anon', 'public.agent_checkin(text,text,jsonb,jsonb,text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.agent_checkin(text,text,jsonb,jsonb,text,jsonb)', 'execute')
     or has_function_privilege('anon', 'public.screen_state(text,text,text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.screen_state(text,text,text,jsonb)', 'execute') then
    fails := fails || '10 functions are callable without the server key'::text;
  end if;

  if cardinality(fails) = 0 then
    raise exception 'ALL 10 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else
    raise exception 'FAILED: %', array_to_string(fails, ' || ');
  end if;
end $$;
