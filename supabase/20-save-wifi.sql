-- Lobby Directory: "Save for other screens" moves to the server (DP-05 round 6).
-- Run in Supabase BEFORE uploading the round 6 code: SQL Editor -> New query -> paste -> Run.
-- (The old technician page still saves from the phone as before, and the new column is simply empty for it, so
-- this order has no gap.) Safe to run more than once.
--
-- Before: the technician page saved the network itself once the join's result reached the phone, 2 to 3 minutes
-- after Join. A phone locked or a page closed in that wait meant the network silently wasn't saved.
-- Now: a join with Save ticked carries a second copy of the network in device_commands.save. The handover to the Pi
-- clears the payload as before, but not save. When the Pi reports the join worked, this check-in saves the network
-- (one entry per network name: the password that just worked replaces an older one; a new one is labelled with the
-- building and kept off cards), records it in the audit log (network name only), adds what it did to the join's
-- result, and clears save in the same statement. A failed or expired join clears save and saves nothing.
--
-- So a password to be saved sits in device_commands for the length of the join (about 3 minutes, an hour at most
-- if the Pi never answers) instead of about a minute. Like the rest of device_commands, and like wifi_networks
-- where it's going, it's server-only: row-level security on, no policies, and /api/devices never selects it.

alter table public.device_commands add column if not exists save jsonb;

alter table public.device_commands drop constraint if exists device_commands_save_check;
alter table public.device_commands add constraint device_commands_save_check
  check (save is null or (command = 'wifi_join' and length(coalesce(save ->> 'ssid', '')) between 1 and 32));

-- agent_checkin as in 13-tech.sql, with three changes (marked "20:" below): a successful join with save saves the
-- network and says so in its result; any result or expiry clears save; the handover leaves save alone.
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
  dv      public.devices%rowtype;
  v_now   timestamptz := now();
  v_day   date := (now() at time zone 'America/Chicago')::date;
  v_temp  real := case when jsonb_typeof(p_health -> 'temp_c') = 'number' then (p_health ->> 'temp_c')::real end;
  v_cmds  jsonb;
  v_key   text;
  v_cred  int[];       -- {seconds for today, seconds for yesterday}
  v_notes jsonb := '{}'::jsonb;   -- 20: command id -> what the save did, added to that join's result
  s       record;
  v_net   uuid;
  v_label text;
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

  -- 20: a join with "Save for other screens" ticked: saved now, only if the Pi says the join worked. A problem here
  -- never blocks the check-in; the result then says it wasn't saved.
  for s in
    select c.id, c.save, c.created_by, r.status
    from public.device_commands c
    join jsonb_to_recordset(coalesce(p_results, '[]'::jsonb)) as r(id bigint, status text, result text) on r.id = c.id
    where c.device_id = dv.id and c.status = 'sent' and c.command = 'wifi_join' and c.save is not null
  loop
    if s.status is distinct from 'done' then
      v_notes := v_notes || jsonb_build_object(s.id::text, ' Nothing was saved.');
      continue;
    end if;
    begin
      select id into v_net from public.wifi_networks where ssid = s.save ->> 'ssid' order by updated_at desc limit 1;
      if found then
        -- Already saved (from the field or the office): the password that just worked replaces the old one, and
        -- whether it goes on cards stays as it was
        update public.wifi_networks set psk = coalesce(s.save ->> 'psk', ''), hidden = coalesce((s.save ->> 'hidden')::boolean, false),
               updated_at = v_now, updated_by = s.created_by
        where id = v_net;
        insert into public.audit_log (user_id, action, entity, entity_id, detail)
        values (s.created_by, 'update wifi from field', 'wifi_network', v_net, jsonb_build_object('ssid', s.save ->> 'ssid', 'serial', dv.serial));
        v_notes := v_notes || jsonb_build_object(s.id::text, format(' The saved password is updated: other Pis can join %s with one tap.', s.save ->> 'ssid'));
      else
        select p.name into v_label
        from public.screens sc join public.directories d on d.id = sc.directory_id join public.properties p on p.id = d.property_id
        where sc.id = dv.screen_id;
        insert into public.wifi_networks (label, ssid, psk, hidden, on_cards, updated_at, updated_by)
        values (coalesce(v_label, ''), s.save ->> 'ssid', coalesce(s.save ->> 'psk', ''), coalesce((s.save ->> 'hidden')::boolean, false),
                false, v_now, s.created_by)
        returning id into v_net;
        insert into public.audit_log (user_id, action, entity, entity_id, detail)
        values (s.created_by, 'save wifi from field', 'wifi_network', v_net, jsonb_build_object('ssid', s.save ->> 'ssid', 'serial', dv.serial));
        v_notes := v_notes || jsonb_build_object(s.id::text, format(' Saved for other screens: other Pis can join %s with one tap.', s.save ->> 'ssid'));
      end if;
    exception when others then
      raise warning 'network not saved: %', sqlerrm;
      v_notes := v_notes || jsonb_build_object(s.id::text, ' It wasn''t saved for other screens; join it again with Save ticked.');
    end;
  end loop;

  -- Results of commands this Pi ran
  update public.device_commands c set
    status  = case when r.status = 'done' then 'done' else 'failed' end,
    result  = left(coalesce(r.result, ''), case when c.command = 'wifi_scan' then 4000 else 500 end)    -- 13: a scan's list is longer
              || coalesce(v_notes ->> c.id::text, ''),                                                   -- 20: what the save did
    payload = null,                                                                                     -- 13
    save    = null,                                                                                     -- 20
    done_at = v_now
  from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb)) as r(id bigint, status text, result text)
  where c.id = r.id and c.device_id = dv.id and c.status = 'sent';

  -- Anything queued over an hour ago is dropped rather than run late (and its payload and save with it)
  update public.device_commands set status = 'expired', payload = null, save = null                     -- 13, 20
  where device_id = dv.id and status in ('pending', 'sent') and created_at < v_now - interval '1 hour';

  -- 13: hand over what's waiting, with each command's payload, marking it sent (so it's delivered once) and clearing
  -- the payload in the same statement. Every part of a WITH reads the same snapshot, so "pend" still holds the payload.
  -- 20: save stays until the result, and never goes to the Pi.
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
