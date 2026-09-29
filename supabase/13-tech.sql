-- Lobby Directory: Wi-Fi search and join from the technician page (DP-03 round 2).
-- Run in Supabase BEFORE uploading the round 2 code: SQL Editor -> New query -> paste -> Run.
-- (The old code never sends the new commands and never reads payload, so this order has no gap.)
-- Safe to run more than once.
--
--   wifi_scan   the Pi lists the Wi-Fi networks it can see; the list comes back as the command's result
--   wifi_join   the Pi joins one network (payload: {ssid, psk, hidden}). If it can't reach the site through it
--               within a minute, it drops it and goes back to the connection it had.
--
-- A join's password travels in device_commands.payload, and only as far as the Pi: it is cleared in the same
-- statement that hands the command to the Pi, so it sits in the database from the moment it's queued until the
-- Pi's next check-in (about a minute), or until the command expires after an hour. It is never listed back to
-- the console (/api/devices doesn't select payload), and like the other device tables, device_commands has
-- row-level security on and no policies, so only the site's server functions can reach it.

alter table public.device_commands add column if not exists payload jsonb;

alter table public.device_commands drop constraint if exists device_commands_command_check;
alter table public.device_commands add constraint device_commands_command_check
  check (command in ('reboot', 'reload', 'screenshot', 'update_agent', 'update_pi', 'wifi_scan', 'wifi_join'));

-- agent_checkin as in 10-refused.sql, with three changes (marked "13:" below): a scan's result may be up to 4,000
-- characters (others stay at 500), a payload is cleared once a command is done, failed or expired, and the handover
-- gives the Pi each command's payload and clears it in the same statement.
create or replace function public.agent_checkin(
  p_serial      text,
  p_key_hash    text,
  p_info        jsonb,   -- {model, hostname, version}
  p_health      jsonb,   -- already cleaned by the site
  p_screenshot  text,    -- null = none this time (already checked by the site)
  p_results     jsonb    -- [{id, status, result}] for commands this Pi ran
) returns jsonb
language plpgsql set search_path = public as $$
declare
  dv     public.devices%rowtype;
  v_now  timestamptz := now();
  v_day  date := (now() at time zone 'America/Chicago')::date;
  v_temp real := case when jsonb_typeof(p_health -> 'temp_c') = 'number' then (p_health ->> 'temp_c')::real end;
  v_cmds jsonb;
  v_key  text;
  v_cred int[];       -- {seconds for today, seconds for yesterday}
begin
  select * into dv from public.devices where serial = p_serial for update;
  if not found then
    -- Not registered at all: enrolls on first contact and waits under New devices
    insert into public.devices (serial, key_hash) values (p_serial, p_key_hash)
    on conflict (serial) do nothing
    returning * into dv;
    if not found then  -- created a moment ago by another check-in
      select * into dv from public.devices where serial = p_serial for update;
    end if;
  end if;

  if dv.status = 'revoked' then
    update public.devices set refused_at = v_now, refused_why = 'revoked' where id = dv.id;
    return jsonb_build_object('refused', 'revoked');
  end if;

  if dv.key_hash is null then
    -- Registered but no key yet: only while 1Point has the enrollment window open
    if dv.enroll_until is null or dv.enroll_until < v_now then
      update public.devices set refused_at = v_now, refused_why = 'enroll' where id = dv.id;
      return jsonb_build_object('refused', 'enroll');
    end if;
    update public.devices set key_hash = p_key_hash, enroll_until = null where id = dv.id;
    dv.key_hash := p_key_hash;
  elsif dv.key_hash <> p_key_hash then
    update public.devices set refused_at = v_now, refused_why = 'key' where id = dv.id;
    return jsonb_build_object('refused', 'key');
  end if;

  update public.devices set
    last_seen     = v_now,
    refused_at    = null,
    refused_why   = null,
    last_health   = coalesce(p_health, '{}'::jsonb),
    model         = coalesce(p_info ->> 'model', ''),
    hostname      = coalesce(p_info ->> 'hostname', ''),
    agent_version = coalesce(p_info ->> 'version', ''),
    -- no screenshot is kept for a Pi that isn't assigned to a screen
    screenshot    = case when p_screenshot is not null and dv.screen_id is not null then p_screenshot else screenshot end,
    screenshot_at = case when p_screenshot is not null and dv.screen_id is not null then v_now else screenshot_at end
  where id = dv.id;

  -- Today's summary. A problem here never blocks the check-in itself.
  -- Uptime credit: the time since this Pi's previous check-in, if that was 3 minutes ago or less (dv.last_seen is
  -- still the previous check-in here). Split at midnight so each day gets its own share.
  begin
    v_cred := public.device_credit(dv.last_seen, v_now);
    insert into public.device_daily as dd (device_id, day, checkins, online_s, power_dips, browser_down, max_temp_c, first_at, last_at)
    values (dv.id, v_day, 1, v_cred[1],
            case when (p_health ->> 'under_voltage_now') = 'true' then 1 else 0 end,
            case when (p_health ->> 'browser_running') = 'false' then 1 else 0 end,
            v_temp, v_now, v_now)
    on conflict (device_id, day) do update set
      checkins     = dd.checkins + 1,
      online_s     = coalesce(dd.online_s, 0) + excluded.online_s,
      power_dips   = dd.power_dips + excluded.power_dips,
      browser_down = dd.browser_down + excluded.browser_down,
      max_temp_c   = greatest(dd.max_temp_c, excluded.max_temp_c),   -- greatest() ignores nulls
      last_at      = excluded.last_at;
    if v_cred[2] > 0 then
      update public.device_daily set online_s = coalesce(online_s, 0) + v_cred[2] where device_id = dv.id and day = v_day - 1;
    end if;
  exception when others then
    raise warning 'daily summary not recorded: %', sqlerrm;
  end;

  -- Results of commands this Pi ran
  update public.device_commands c set
    status  = case when r.status = 'done' then 'done' else 'failed' end,
    result  = left(coalesce(r.result, ''), case when c.command = 'wifi_scan' then 4000 else 500 end),   -- 13: a scan's list is longer
    payload = null,                                                                                   -- 13
    done_at = v_now
  from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb)) as r(id bigint, status text, result text)
  where c.id = r.id and c.device_id = dv.id and c.status = 'sent';

  -- Anything queued over an hour ago is dropped rather than run late (and its payload with it)
  update public.device_commands set status = 'expired', payload = null                                -- 13
  where device_id = dv.id and status in ('pending', 'sent') and created_at < v_now - interval '1 hour';

  -- 13: hand over what's waiting, with each command's payload, marking it sent (so it's delivered once) and clearing
  -- the payload in the same statement. Every part of a WITH reads the same snapshot, so "pend" still holds the payload.
  with pend as (
    select id, command, payload from public.device_commands
    where device_id = dv.id and status = 'pending'
    order by id
    for update
  ), sent as (
    update public.device_commands c set status = 'sent', sent_at = v_now, payload = null
    from pend where c.id = pend.id
    returning c.id
  )
  select coalesce(jsonb_agg(
           jsonb_build_object('id', pend.id, 'command', pend.command)
           || case when pend.payload is not null then jsonb_build_object('payload', pend.payload) else '{}'::jsonb end
         order by pend.id), '[]'::jsonb)
  into v_cmds
  from pend;

  select key into v_key from public.screens where id = dv.screen_id;
  return jsonb_build_object('screen', v_key, 'commands', v_cmds);
end $$;

revoke all on function public.agent_checkin(text, text, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.agent_checkin(text, text, jsonb, jsonb, text, jsonb) to service_role;

notify pgrst, 'reload schema';
