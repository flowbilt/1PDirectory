-- Lobby Directory: trust fixes (DP-02).
-- Run in Supabase AFTER the DP-02 code is live on Netlify: SQL Editor -> New query -> paste -> Run.
-- (The old console asks for every screen column, which this file stops signed-in users from reading.)
-- Safe to run more than once.
--
--   1. Enrollment window. A Pi with no key yet (a pre-registered Yodeck Pi, or one whose key was reset) only
--      accepts a key while 1Point has opened a window for it in the console (24 hours). Pis that aren't
--      registered at all still enroll on first contact and appear under New devices, but no screenshot is
--      stored for a Pi until it's assigned to a screen.
--   2. Owner users can no longer read screens.hardware (serials, MACs, IPs, the Yodeck snapshot). Signed-in
--      users may read only the columns listed below; 1Point sees hardware through the site's server.
--      A column added to screens later is hidden from signed-in users until it's added to this list.
--   3. PPI 2 South's name had a typo in its Yodeck ID (194242; the ID is 194292).

-- ─────────────────────────────────────────── 1. enrollment window

alter table public.devices add column if not exists enroll_until timestamptz;  -- null = closed

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
    return jsonb_build_object('refused', 'revoked');
  end if;

  if dv.key_hash is null then
    -- Registered but no key yet: only while 1Point has the enrollment window open
    if dv.enroll_until is null or dv.enroll_until < v_now then
      return jsonb_build_object('refused', 'enroll');
    end if;
    update public.devices set key_hash = p_key_hash, enroll_until = null where id = dv.id;
    dv.key_hash := p_key_hash;
  elsif dv.key_hash <> p_key_hash then
    return jsonb_build_object('refused', 'key');
  end if;

  update public.devices set
    last_seen     = v_now,
    last_health   = coalesce(p_health, '{}'::jsonb),
    model         = coalesce(p_info ->> 'model', ''),
    hostname      = coalesce(p_info ->> 'hostname', ''),
    agent_version = coalesce(p_info ->> 'version', ''),
    -- no screenshot is kept for a Pi that isn't assigned to a screen
    screenshot    = case when p_screenshot is not null and dv.screen_id is not null then p_screenshot else screenshot end,
    screenshot_at = case when p_screenshot is not null and dv.screen_id is not null then v_now else screenshot_at end
  where id = dv.id;

  -- Today's summary. A problem here never blocks the check-in itself.
  begin
    insert into public.device_daily as dd (device_id, day, checkins, power_dips, browser_down, max_temp_c, first_at, last_at)
    values (dv.id, v_day, 1,
            case when (p_health ->> 'under_voltage_now') = 'true' then 1 else 0 end,
            case when (p_health ->> 'browser_running') = 'false' then 1 else 0 end,
            v_temp, v_now, v_now)
    on conflict (device_id, day) do update set
      checkins     = dd.checkins + 1,
      power_dips   = dd.power_dips + excluded.power_dips,
      browser_down = dd.browser_down + excluded.browser_down,
      max_temp_c   = greatest(dd.max_temp_c, excluded.max_temp_c),   -- greatest() ignores nulls
      last_at      = excluded.last_at;
  exception when others then
    raise warning 'daily summary not recorded: %', sqlerrm;
  end;

  -- Results of commands this Pi ran
  update public.device_commands c set
    status  = case when r.status = 'done' then 'done' else 'failed' end,
    result  = left(coalesce(r.result, ''), 500),
    done_at = v_now
  from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb)) as r(id bigint, status text, result text)
  where c.id = r.id and c.device_id = dv.id and c.status = 'sent';

  -- Anything queued over an hour ago is dropped rather than run late
  update public.device_commands set status = 'expired'
  where device_id = dv.id and status in ('pending', 'sent') and created_at < v_now - interval '1 hour';

  -- Hand over what's waiting, marking it sent so it's delivered once
  with sent as (
    update public.device_commands set status = 'sent', sent_at = v_now
    where device_id = dv.id and status = 'pending'
    returning id, command
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'command', command) order by id), '[]'::jsonb) into v_cmds from sent;

  select key into v_key from public.screens where id = dv.screen_id;
  return jsonb_build_object('screen', v_key, 'commands', v_cmds);
end $$;

revoke all on function public.agent_checkin(text, text, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.agent_checkin(text, text, jsonb, jsonb, text, jsonb) to service_role;

-- ─────────────────────────────────────────── 2. screens.hardware is server-only

revoke select on public.screens from anon, authenticated;
grant select (id, directory_id, key, name, location_note, orientation, last_seen, last_report, identify_until, created_at)
  on public.screens to authenticated;

-- ─────────────────────────────────────────── 3. PPI 2 South's name

update public.screens set name = 'TBC - PPI - 2 S - 194292'
where key = 'ppi-2s' and name = 'TBC - PPI - 2 S - 194242';

-- Tell the API layer about the changes straight away
notify pgrst, 'reload schema';
