-- Lobby Directory: uptime counting (DP-02 round 2).
-- Run in Supabase BEFORE uploading the round 2 code: SQL Editor -> New query -> paste -> Run.
-- (The new Health tab reads device_daily.online_s, which this file adds. The old code doesn't mind it.)
-- Safe to run more than once.
--
-- Uptime used to be "check-ins per day out of 1,440", so a Pi that checked in every 61 seconds looked 98% up.
-- Now each check-in credits the time since the Pi's previous check-in, as long as that gap is 3 minutes or less:
-- a Pi checking in every 58 to 62 seconds, or after a slow check-in, still counts as up the whole time. A longer
-- gap is an outage and credits nothing; the Pi starts earning again from its next check-in. Rows from before
-- this file have no online_s, and the Health tab counts them the old way (a minute per check-in).

alter table public.device_daily add column if not exists online_s integer;   -- seconds credited as up; null = before round 2

-- The credit for one check-in: {seconds for today, seconds for the day before}, days in Central time.
create or replace function public.device_credit(p_prev timestamptz, p_now timestamptz) returns int[]
language sql stable set search_path = public as $$
  with g as (
    select case when p_prev is not null and p_now > p_prev and p_now - p_prev <= interval '3 minutes'
                then round(extract(epoch from p_now - p_prev))::int else 0 end as total,
           floor(extract(epoch from p_now - ((p_now at time zone 'America/Chicago')::date::timestamp at time zone 'America/Chicago')))::int as into_today
  )
  select array[least(total, into_today), total - least(total, into_today)] from g;
$$;

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
revoke all on function public.device_credit(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.device_credit(timestamptz, timestamptz) to service_role;

-- Tell the API layer about the changes straight away
notify pgrst, 'reload schema';
