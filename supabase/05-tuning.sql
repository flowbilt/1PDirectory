-- Lobby Directory: cheaper check-ins (fewer trips between Netlify and Supabase).
-- Run in Supabase after 04-health.sql: SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once: it only creates or replaces the two functions below.
--
--   agent_checkin   everything a Pi's once-a-minute check-in does, in one database call
--                   (it used to take about seven, and Netlify bills for the time spent waiting)
--   screen_state    everything a lobby screen's once-a-minute check does, in one call. It records the
--                   check-in (at most every 4 minutes) and sends the full directory only when something
--                   changed, so the logo and background photo aren't read out of the database every minute.
--
-- Only the site's server functions may call these (service key). Signed-in users and the public can't.

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
  -- Enrollment: the first key a serial checks in with is the one it must keep using
  select * into dv from public.devices where serial = p_serial for update;
  if not found then
    insert into public.devices (serial, key_hash) values (p_serial, p_key_hash) returning * into dv;
  elsif dv.key_hash is null then
    update public.devices set key_hash = p_key_hash where id = dv.id;
  elsif dv.key_hash <> p_key_hash then
    return jsonb_build_object('refused', 'key');
  end if;
  if dv.status = 'revoked' then
    return jsonb_build_object('refused', 'revoked');
  end if;

  update public.devices set
    last_seen     = v_now,
    last_health   = coalesce(p_health, '{}'::jsonb),
    model         = coalesce(p_info ->> 'model', ''),
    hostname      = coalesce(p_info ->> 'hostname', ''),
    agent_version = coalesce(p_info ->> 'version', ''),
    screenshot    = coalesce(p_screenshot, screenshot),
    screenshot_at = case when p_screenshot is not null then v_now else screenshot_at end
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


create or replace function public.screen_state(
  p_key     text,    -- screen address, or null when p_device is given
  p_device  text,    -- Pi serial for /?device= screens
  p_etag    text,    -- the version the screen already has, or null
  p_report  jsonb    -- {w, h, version, agent} from the screen, or null for no check-in
) returns jsonb
language plpgsql set search_path = public as $$
declare
  s      public.screens%rowtype;
  d      public.directories%rowtype;
  p      public.properties%rowtype;
  v_etag text;
begin
  if coalesce(p_device, '') <> '' then
    select sc.* into s from public.devices dv join public.screens sc on sc.id = dv.screen_id where dv.serial = p_device;
    if not found then return jsonb_build_object('new_device', true); end if;
  else
    select * into s from public.screens where key = p_key;
    if not found then return jsonb_build_object('missing', true); end if;
  end if;

  -- The check-in (this used to be a separate heartbeat call). Every 4 minutes is plenty for Online/Offline.
  if p_report is not null and (s.last_seen is null or s.last_seen < now() - interval '4 minutes') then
    update public.screens set last_seen = now(), last_report = p_report where id = s.id;
  end if;

  if s.directory_id is not null then
    select * into d from public.directories where id = s.directory_id;
    if found then select * into p from public.properties where id = d.property_id; end if;
  end if;

  -- The version: anything the screen shows. Tenant edits bump the directory's updated_at (trigger in 01),
  -- and building or directory edits bump their own.
  v_etag := md5(concat_ws('|', s.key, s.name, s.orientation, coalesce(s.directory_id::text, '-'),
                          coalesce(s.identify_until::text, '-'), coalesce(d.updated_at::text, '-'), coalesce(p.updated_at::text, '-')));
  if v_etag = p_etag then
    return jsonb_build_object('etag', v_etag, 'not_modified', true);
  end if;

  return jsonb_build_object(
    'etag', v_etag,
    'screen', jsonb_build_object('key', s.key, 'name', s.name, 'orientation', s.orientation, 'identify_until', s.identify_until),
    'dir',  case when d.id is not null then to_jsonb(d) end,
    'prop', case when p.id is not null then to_jsonb(p) end,
    'tenants', case when d.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('name', t.name, 'suite', t.suite, 'arrow', t.arrow, 'note', t.note, 'sort', t.sort) order by t.sort, t.name)
      from public.tenants t where t.directory_id = d.id), '[]'::jsonb) end
  );
end $$;

-- Server only
revoke all on function public.agent_checkin(text, text, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function public.screen_state(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.agent_checkin(text, text, jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.screen_state(text, text, text, jsonb) to service_role;

-- Tell the API layer about the new functions straight away
notify pgrst, 'reload schema';
