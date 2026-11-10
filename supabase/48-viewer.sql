-- DP-14 (V1): "See Your WayTuGo in Action", the viewer on waytugo.com. Each visit that builds something is kept,
-- without a name, so 1Point can see what visitors build before they ask for a quote. Run before the code. Safe to run
-- again.
--
-- Scot (2026-11-10): "I would want to know that they've been there and created something ... a way to know the
-- configurator is drawing interest in advance of knowing if that interest is leading to sales"; the choices kept in
-- place of screenshots (the console redraws them exactly). Kept: the choices (display, building name, tenants,
-- landscape or portrait, extras), when and for how long, which page or ad brought them (from the address only), and
-- whether they started or sent a quote request. Not kept: an IP address, a cookie, or anything about the person.
-- Written only by the site (netlify/functions/viewer.mjs, with the service key) through viewer_record; read and
-- removed only by 1Point.

-- ─────────────────────────────────────────── the visits
create table if not exists public.viewer_visits (
  id uuid primary key,                                   -- made by the visitor's page; it's also the visit's code
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  config jsonb not null,                                 -- the choices (public/viewer-sample.mjs normalizeConfig)
  seconds integer not null default 0 check (seconds between 0 and 7200),
  changes integer not null default 0 check (changes between 0 and 10000),
  quote text check (quote in ('started', 'sent')),       -- Request a Quote clicked; the site's form sent
  source jsonb not null default '{}'::jsonb              -- the page and the ad's utm_ words, from the address
);
create index if not exists viewer_visits_started on public.viewer_visits (started_at desc);
alter table public.viewer_visits enable row level security;
drop policy if exists viewer_visits_read on public.viewer_visits;
create policy viewer_visits_read on public.viewer_visits for select to authenticated using (public.is_platform_admin());
drop policy if exists viewer_visits_remove on public.viewer_visits;
create policy viewer_visits_remove on public.viewer_visits for delete to authenticated using (public.is_platform_admin());
revoke all on public.viewer_visits from anon;
revoke insert, update on public.viewer_visits from authenticated;
grant select, delete on public.viewer_visits to authenticated;

-- ─────────────────────────────────────────── the rules for the choices (= viewer-sample.mjs configProblem)
create or replace function public.viewer_config_problem(c jsonb) returns text
language plpgsql immutable set search_path = public as $$
begin
  if jsonb_typeof(c) is distinct from 'object' then return 'The choices are an object.'; end if;
  if exists (select 1 from jsonb_object_keys(c) k where k not in ('v', 'kind', 'name', 'subtitle', 'tenants', 'shape', 'weather', 'qr', 'places', 'contacts')) then
    return 'Something isn''t one of the viewer''s choices.';
  end if;
  if c -> 'v' is distinct from '1'::jsonb then return 'The choices are version 1.'; end if;
  if jsonb_typeof(c -> 'kind') is distinct from 'string' or c ->> 'kind' not in ('directory', 'touch') then return 'The display is a building directory or a touch directory.'; end if;
  if jsonb_typeof(c -> 'name') is distinct from 'string' or char_length(c ->> 'name') > 60
     or jsonb_typeof(c -> 'subtitle') is distinct from 'string' or char_length(c ->> 'subtitle') > 60 then
    return 'The name and subtitle are text of up to 60 characters.';
  end if;
  if jsonb_typeof(c -> 'tenants') is distinct from 'number' or (c ->> 'tenants') !~ '^[0-9]+$' or (c ->> 'tenants')::int not between 4 and 60 then
    return 'The tenants are 4 to 60.';
  end if;
  if jsonb_typeof(c -> 'shape') is distinct from 'string' or c ->> 'shape' not in ('landscape', 'portrait') then return 'The screen is landscape or portrait.'; end if;
  if jsonb_typeof(c -> 'weather') is distinct from 'boolean' or jsonb_typeof(c -> 'qr') is distinct from 'boolean'
     or jsonb_typeof(c -> 'places') is distinct from 'boolean' or jsonb_typeof(c -> 'contacts') is distinct from 'boolean' then
    return 'Each extra is on or off.';
  end if;
  return null;
end $$;
revoke all on function public.viewer_config_problem(jsonb) from public, anon, authenticated;

-- ─────────────────────────────────────────── keeping a visit (the site only)
-- A visit is kept from its first change and updated as it goes (the same code). A quote, once started or sent, stays.
-- Limits so the table can't be flooded: at most 120 new visits a minute and 5,000 a day across the site, an update only
-- within a day of the visit's start; visits older than 400 days are removed as new ones arrive.
create or replace function public.viewer_record(p_id uuid, p_config jsonb, p_seconds integer, p_changes integer, p_quote text, p_source jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare problem text := public.viewer_config_problem(p_config); v_started timestamptz;
begin
  if p_id is null then raise exception 'A visit has a code.' using errcode = 'check_violation'; end if;
  if problem is not null then raise exception '%', problem using errcode = 'check_violation'; end if;
  if p_quote is not null and p_quote not in ('started', 'sent') then raise exception 'A quote is started or sent.' using errcode = 'check_violation'; end if;
  if jsonb_typeof(coalesce(p_source, '{}'::jsonb)) <> 'object'
     or exists (select 1 from jsonb_each(coalesce(p_source, '{}'::jsonb)) e
                where e.key not in ('page', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term')
                   or jsonb_typeof(e.value) <> 'string' or char_length(e.value #>> '{}') > 200) then
    raise exception 'The source is the page and the ad''s utm_ words, each up to 200 characters.' using errcode = 'check_violation';
  end if;
  select started_at into v_started from public.viewer_visits where id = p_id;
  if v_started is null then
    if (select count(*) from public.viewer_visits where started_at > now() - interval '1 minute') >= 120
       or (select count(*) from public.viewer_visits where started_at > now() - interval '1 day') >= 5000 then
      raise exception 'Too many visits right now.' using errcode = 'P0001';
    end if;
    delete from public.viewer_visits where started_at < now() - interval '400 days';
    insert into public.viewer_visits (id, config, seconds, changes, quote, source)
    values (p_id, p_config, least(greatest(coalesce(p_seconds, 0), 0), 7200), least(greatest(coalesce(p_changes, 0), 0), 10000), p_quote, coalesce(p_source, '{}'::jsonb));
  elsif v_started > now() - interval '1 day' then
    update public.viewer_visits set config = p_config, updated_at = now(),
      seconds = greatest(seconds, least(greatest(coalesce(p_seconds, 0), 0), 7200)),
      changes = greatest(changes, least(greatest(coalesce(p_changes, 0), 0), 10000)),
      quote = case when quote = 'sent' or p_quote = 'sent' then 'sent' when quote = 'started' or p_quote = 'started' then 'started' else null end,
      source = case when source = '{}'::jsonb then coalesce(p_source, '{}'::jsonb) else source end
    where id = p_id;
  end if;
end $$;
revoke all on function public.viewer_record(uuid, jsonb, integer, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.viewer_record(uuid, jsonb, integer, integer, text, jsonb) to service_role;
