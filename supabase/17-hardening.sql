-- Lobby Directory: keeping the console fast and its history bounded as the fleet grows (DP-04 round 2).
-- Run in Supabase BEFORE uploading the code that uses it: SQL Editor -> New query -> paste -> Run.
-- (The old code doesn't call these functions, so this order has no gap.) Safe to run more than once.
-- Then run check-hardening.sql; it should end with ALL 8 CHECKS PASSED (red on purpose).
--
--   recent_device_commands  each Pi's latest few actions, one row per Pi. The console used to read every action
--                           ever sent to every Pi, every 10 seconds, and keep only the last five.
--   health_window           each Pi's 30-day health totals, one row per Pi. The Health tab used to read 30 daily
--                           rows per Pi, and Supabase hands back at most 1,000 rows, so past about 33 Pis it would
--                           quietly have counted from part of the history.
--   trim_device_history     actions older than 90 days go (each Pi's latest five always stay), and daily
--                           history older than 400 days. Called by the alert check every 10 minutes; most runs
--                           delete nothing.
-- All three are for the site's server only: nobody signed in can call them.

create index if not exists device_commands_device_recent on public.device_commands (device_id, id desc);
create index if not exists device_commands_created on public.device_commands (created_at);

create or replace function public.recent_device_commands(p_device_ids uuid[], p_per integer default 5)
returns table (device_id uuid, commands jsonb)
language sql stable
set search_path = public
as $$
  select c.device_id,
         jsonb_agg(jsonb_build_object('id', c.id, 'device_id', c.device_id, 'command', c.command, 'status', c.status,
                                      'result', c.result, 'created_at', c.created_at, 'done_at', c.done_at)
                   order by c.id desc)
  from (select x.id, x.device_id, x.command, x.status, x.result, x.created_at, x.done_at,
               row_number() over (partition by x.device_id order by x.id desc) as rn
        from public.device_commands x
        where x.device_id = any (p_device_ids)) c
  where c.rn <= greatest(1, least(coalesce(p_per, 5), 20))
  group by c.device_id;
$$;

-- p_today is the Central day the console counts from. Uptime seconds are online_s, or a minute per check-in for
-- days recorded before 07-uptime.sql (the same rule as the console's own).
create or replace function public.health_window(p_today date)
returns table (device_id uuid, first_day date, first_at timestamptz,
               up_s_1 bigint, up_s_7 bigint, up_s_30 bigint,
               dips_7 bigint, dips_30 bigint, browser_down_7 bigint, max_temp_7 real)
language sql stable
set search_path = public
as $$
  select d.device_id,
         min(d.day),
         (array_agg(d.first_at order by d.day))[1],
         coalesce(sum(coalesce(d.online_s, d.checkins * 60)) filter (where d.day >= p_today), 0),
         coalesce(sum(coalesce(d.online_s, d.checkins * 60)) filter (where d.day >= p_today - 6), 0),
         coalesce(sum(coalesce(d.online_s, d.checkins * 60)), 0),
         coalesce(sum(d.power_dips) filter (where d.day >= p_today - 6), 0),
         coalesce(sum(d.power_dips), 0),
         coalesce(sum(d.browser_down) filter (where d.day >= p_today - 6), 0),
         max(d.max_temp_c) filter (where d.day >= p_today - 6)
  from public.device_daily d
  where d.day >= p_today - 29
  group by d.device_id;
$$;

create or replace function public.trim_device_history()
returns jsonb
language sql volatile
set search_path = public
as $$
  with keep as (
    select id from (select id, row_number() over (partition by device_id order by id desc) as rn
                    from public.device_commands) k
    where k.rn <= 5
  ), gone as (
    delete from public.device_commands c
    where c.created_at < now() - interval '90 days'
      and c.status not in ('pending', 'sent')
      and c.id not in (select id from keep)
    returning 1
  ), gone_days as (
    delete from public.device_daily
    where day < (now() at time zone 'America/Chicago')::date - 400
    returning 1
  )
  select jsonb_build_object('commands', (select count(*) from gone), 'days', (select count(*) from gone_days));
$$;

revoke all on function public.recent_device_commands(uuid[], integer) from public, anon, authenticated;
revoke all on function public.health_window(date) from public, anon, authenticated;
revoke all on function public.trim_device_history() from public, anon, authenticated;
grant execute on function public.recent_device_commands(uuid[], integer) to service_role;
grant execute on function public.health_window(date) to service_role;
grant execute on function public.trim_device_history() to service_role;

notify pgrst, 'reload schema';
