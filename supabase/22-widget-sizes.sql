-- Lobby Directory: sizes for the news panel, the clock, the weather and the contacts (DP-08 round 10).
-- Run in Supabase BEFORE uploading the round 10 code: SQL Editor -> New query -> paste -> Run.
-- (The old editor never sends the new names, and the old display ignores them, so this order has no gap.)
-- Safe to run more than once. Then run check-widget-sizes.sql; it should end with ALL 7 CHECKS PASSED (red on purpose).
--
-- Only set_screen_sizes changes: it now keeps four more names, each 70-150% of the standard size:
--   news      the news panel's text (the panel grows with it; the tenant list keeps its room first)
--   clock     the time and date
--   weather   the weather icon, temperature and line
--   contacts  the Managed by / Leased by band
-- Everything else is exactly as in 18-sizes.sql: same column (screens.sizes), same access rule (1Point, or the
-- screen's own account), out-of-range values clamped, unknown names ignored, 100 not stored. screen_state already
-- sends the whole sizes object and counts it in the screen's version, so it isn't touched.

create or replace function public.set_screen_sizes(p_screen uuid, p_sizes jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_dir   uuid;
  v_out   jsonb := '{}'::jsonb;
  v_name  text;
  v_lo    int;
  v_hi    int;
  v_val   numeric;
begin
  select directory_id into v_dir from public.screens where id = p_screen;
  -- coalesce: with no account (or no directory) the comparison is unknown, which must mean no, not maybe
  if not found or not coalesce(public.is_platform_admin() or public.directory_org(v_dir) = public.my_org(), false) then
    raise exception 'That screen doesn''t exist, or you don''t have access to it.' using errcode = '42501';
  end if;
  for v_name, v_lo, v_hi in values ('title', 50, 120), ('logo', 60, 200), ('brand', 60, 250), ('welcome', 80, 160),
                                   ('news', 70, 150), ('clock', 70, 150), ('weather', 70, 150), ('contacts', 70, 150) loop
    if jsonb_typeof(p_sizes -> v_name) = 'number' then
      v_val := round((p_sizes ->> v_name)::numeric);
      v_val := least(v_hi, greatest(v_lo, v_val));
      if v_val <> 100 then v_out := v_out || jsonb_build_object(v_name, v_val::int); end if;   -- 100 = standard, not stored
    end if;
  end loop;
  update public.screens set sizes = v_out where id = p_screen;
  return v_out;
end $$;

revoke all on function public.set_screen_sizes(uuid, jsonb) from public, anon;
grant execute on function public.set_screen_sizes(uuid, jsonb) to authenticated, service_role;
