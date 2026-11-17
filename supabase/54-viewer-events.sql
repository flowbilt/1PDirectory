-- DP-15 (V5): the viewer's full-screen view, Save / Share, and what visitors do, from the moment the page loads.
-- Run after 53-viewer-menu.sql, BEFORE uploading the V5 code: SQL Editor -> New query -> paste -> Run. Safe to run
-- again. Then run check-viewer-events.sql; it should end with ALL 8 CHECKS PASSED (red on purpose).
--
-- Scot's brief (2026-11-16), "Full-Screen Preview, Save/Share & Engagement Tracking", and his answers: Meta reported
-- about 54 landing-page views while the console showed one outside visit. Until now a visit was kept only from its
-- first change, so anyone who looked and left was never counted. From V5:
--
--   viewer_visits        a visit is kept from the moment the viewer page loads (config is null until the viewer has
--                        drawn its first preview), with:
--     events             how many times each thing happened: viewer_page_loaded, viewer_initialized,
--                        configuration_edited (once per control the visitor actually changed, when they finished with
--                        it; samples and placeholders never count), full_preview_opened, full_preview_closed,
--                        directory_image_downloaded, directory_share_initiated, directory_share_completed,
--                        quote_form_opened, quote_submitted, and viewer_error (the page failed before it started; no
--                        message kept). Counts only go up.
--     snapshots          the choices each time the full-screen view opened (the last 5, with the time; the same
--                        choices twice in a row are kept once)
--     device, browser    a category only (Scot, 2026-11-16: "OK"): phone, tablet or desktop; the Facebook browser,
--                        the Instagram browser or other. Worked out by the site from the browser's own description,
--                        which is never kept.
--     init_ms            how long the viewer took to draw its first preview (the first load's)
--     failures           sends the visitor's page reports as failed (it retries once, then says so next time)
--     page_load          the waytugo.com page load that opened the viewer (below), when the page says so
--   viewer_page_loads    each load of waytugo.com/waytugo-viewer, sent by the page itself (the site builder's script)
--                        before the viewer loads: when, the page and utm_ words, device and browser categories. A
--                        load with no visit is a visitor who left before the viewer started (or a viewer that failed
--                        to load). Same limits, 400 days kept, read and removed only by 1Point.
--
-- viewer_record keeps its first six inputs, so the code before V5 keeps working between this file and the upload; the
-- new ones are optional. viewer_page_record is new. Both for the site only (service_role).

-- ─────────────────────────────────────────── the visits: what's new
alter table public.viewer_visits alter column config drop not null;
alter table public.viewer_visits add column if not exists events jsonb not null default '{}'::jsonb;
alter table public.viewer_visits add column if not exists snapshots jsonb not null default '[]'::jsonb;
alter table public.viewer_visits add column if not exists device text;
alter table public.viewer_visits add column if not exists browser text;
alter table public.viewer_visits add column if not exists init_ms integer;
alter table public.viewer_visits add column if not exists failures integer not null default 0;
alter table public.viewer_visits add column if not exists page_load uuid;
alter table public.viewer_visits drop constraint if exists viewer_visits_device;
alter table public.viewer_visits add constraint viewer_visits_device check (device in ('phone', 'tablet', 'desktop'));
alter table public.viewer_visits drop constraint if exists viewer_visits_browser;
alter table public.viewer_visits add constraint viewer_visits_browser check (browser in ('facebook', 'instagram', 'other'));
alter table public.viewer_visits drop constraint if exists viewer_visits_init;
alter table public.viewer_visits add constraint viewer_visits_init check (init_ms between 0 and 600000);
alter table public.viewer_visits drop constraint if exists viewer_visits_failures;
alter table public.viewer_visits add constraint viewer_visits_failures check (failures between 0 and 10000);
create index if not exists viewer_visits_page_load on public.viewer_visits (page_load) where page_load is not null;

-- ─────────────────────────────────────────── the page loads (from waytugo.com's own page)
create table if not exists public.viewer_page_loads (
  id uuid primary key,                                   -- made by the page; it passes it to the viewer as ?load=
  at timestamptz not null default now(),
  source jsonb not null default '{}'::jsonb,             -- the page and the ad's utm_ words, from the address
  device text check (device in ('phone', 'tablet', 'desktop')),
  browser text check (browser in ('facebook', 'instagram', 'other'))
);
create index if not exists viewer_page_loads_at on public.viewer_page_loads (at desc);
alter table public.viewer_page_loads enable row level security;
drop policy if exists viewer_page_loads_read on public.viewer_page_loads;
create policy viewer_page_loads_read on public.viewer_page_loads for select to authenticated using (public.is_platform_admin());
drop policy if exists viewer_page_loads_remove on public.viewer_page_loads;
create policy viewer_page_loads_remove on public.viewer_page_loads for delete to authenticated using (public.is_platform_admin());
revoke all on public.viewer_page_loads from anon;
revoke insert, update on public.viewer_page_loads from authenticated;
grant select, delete on public.viewer_page_loads to authenticated;

-- ─────────────────────────────────────────── the rules (= viewer-sample.mjs eventsProblem, sourceProblem)
create or replace function public.viewer_events_problem(e jsonb) returns text
language plpgsql immutable set search_path = public as $$
begin
  if e is null then return null; end if;
  if jsonb_typeof(e) <> 'object' then return 'The events are an object.'; end if;
  if exists (select 1 from jsonb_each(e) x
             where x.key not in ('viewer_page_loaded', 'viewer_initialized', 'configuration_edited', 'full_preview_opened', 'full_preview_closed',
                                 'directory_image_downloaded', 'directory_share_initiated', 'directory_share_completed', 'quote_form_opened',
                                 'quote_submitted', 'viewer_error')
                or jsonb_typeof(x.value) <> 'number' or (x.value #>> '{}') !~ '^[0-9]+$' or (x.value #>> '{}')::numeric > 10000) then
    return 'Each event is one of the viewer''s, counted 0 to 10,000.';
  end if;
  return null;
end $$;
revoke all on function public.viewer_events_problem(jsonb) from public, anon, authenticated;

create or replace function public.viewer_source_problem(s jsonb) returns text
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(coalesce(s, '{}'::jsonb)) <> 'object'
                or exists (select 1 from jsonb_each(coalesce(s, '{}'::jsonb)) e
                           where e.key not in ('page', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term')
                              or jsonb_typeof(e.value) <> 'string' or char_length(e.value #>> '{}') > 200)
              then 'The source is the page and the ad''s utm_ words, each up to 200 characters.' end
$$;
revoke all on function public.viewer_source_problem(jsonb) from public, anon, authenticated;

-- ─────────────────────────────────────────── keeping a visit (the site only)
-- 48's, with: a visit kept before anything is drawn (config null; a later send fills it, and a send without choices
-- never clears them); the events merged by the larger count; a snapshot added to the last 5 (unless it's the same as
-- the last); device, browser, init_ms and page_load kept from the first send that has them; failures the larger.
drop function if exists public.viewer_record(uuid, jsonb, integer, integer, text, jsonb);
create or replace function public.viewer_record(p_id uuid, p_config jsonb, p_seconds integer, p_changes integer, p_quote text, p_source jsonb,
  p_events jsonb default null, p_snapshot jsonb default null, p_device text default null, p_browser text default null,
  p_init_ms integer default null, p_failures integer default null, p_load uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare problem text; v_started timestamptz; v_snaps jsonb;
begin
  if p_id is null then raise exception 'A visit has a code.' using errcode = 'check_violation'; end if;
  if p_config is not null then
    problem := public.viewer_config_problem(p_config);
    if problem is not null then raise exception '%', problem using errcode = 'check_violation'; end if;
  end if;
  if p_snapshot is not null then
    problem := public.viewer_config_problem(p_snapshot);
    if problem is not null then raise exception 'The snapshot: %', problem using errcode = 'check_violation'; end if;
  end if;
  problem := public.viewer_events_problem(p_events);
  if problem is not null then raise exception '%', problem using errcode = 'check_violation'; end if;
  if p_quote is not null and p_quote not in ('started', 'sent') then raise exception 'A quote is started or sent.' using errcode = 'check_violation'; end if;
  problem := public.viewer_source_problem(p_source);
  if problem is not null then raise exception '%', problem using errcode = 'check_violation'; end if;
  if p_device is not null and p_device not in ('phone', 'tablet', 'desktop') then raise exception 'The device is phone, tablet or desktop.' using errcode = 'check_violation'; end if;
  if p_browser is not null and p_browser not in ('facebook', 'instagram', 'other') then raise exception 'The browser is facebook, instagram or other.' using errcode = 'check_violation'; end if;

  select started_at into v_started from public.viewer_visits where id = p_id;
  if v_started is null then
    if (select count(*) from public.viewer_visits where started_at > now() - interval '1 minute') >= 120
       or (select count(*) from public.viewer_visits where started_at > now() - interval '1 day') >= 5000 then
      raise exception 'Too many visits right now.' using errcode = 'P0001';
    end if;
    delete from public.viewer_visits where started_at < now() - interval '400 days';
    insert into public.viewer_visits (id, config, seconds, changes, quote, source, events, snapshots, device, browser, init_ms, failures, page_load)
    values (p_id, p_config, least(greatest(coalesce(p_seconds, 0), 0), 7200), least(greatest(coalesce(p_changes, 0), 0), 10000), p_quote,
      coalesce(p_source, '{}'::jsonb), coalesce(p_events, '{}'::jsonb),
      case when p_snapshot is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('at', now(), 'config', p_snapshot)) end,
      p_device, p_browser, case when p_init_ms is null then null else least(greatest(p_init_ms, 0), 600000) end, least(greatest(coalesce(p_failures, 0), 0), 10000), p_load);
  elsif v_started > now() - interval '1 day' then
    select snapshots into v_snaps from public.viewer_visits where id = p_id;
    if p_snapshot is not null and (jsonb_array_length(v_snaps) = 0 or v_snaps -> -1 -> 'config' is distinct from p_snapshot) then
      v_snaps := v_snaps || jsonb_build_array(jsonb_build_object('at', now(), 'config', p_snapshot));
      while jsonb_array_length(v_snaps) > 5 loop v_snaps := v_snaps - 0; end loop;
    end if;
    update public.viewer_visits set config = coalesce(p_config, config), updated_at = now(),
      seconds = greatest(seconds, least(greatest(coalesce(p_seconds, 0), 0), 7200)),
      changes = greatest(changes, least(greatest(coalesce(p_changes, 0), 0), 10000)),
      quote = case when quote = 'sent' or p_quote = 'sent' then 'sent' when quote = 'started' or p_quote = 'started' then 'started' else null end,
      source = case when source = '{}'::jsonb then coalesce(p_source, '{}'::jsonb) else source end,
      events = (select coalesce(jsonb_object_agg(k, greatest(coalesce((events ->> k)::int, 0), coalesce((p_events ->> k)::int, 0))), '{}'::jsonb)
                  from (select jsonb_object_keys(events) k union select jsonb_object_keys(coalesce(p_events, '{}'::jsonb))) keys),
      snapshots = v_snaps,
      device = coalesce(device, p_device), browser = coalesce(browser, p_browser),
      init_ms = coalesce(init_ms, case when p_init_ms is null then null else least(greatest(p_init_ms, 0), 600000) end),
      failures = greatest(failures, least(greatest(coalesce(p_failures, 0), 0), 10000)),
      page_load = coalesce(page_load, p_load)
    where id = p_id;
  end if;
end $$;
revoke all on function public.viewer_record(uuid, jsonb, integer, integer, text, jsonb, jsonb, jsonb, text, text, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.viewer_record(uuid, jsonb, integer, integer, text, jsonb, jsonb, jsonb, text, text, integer, integer, uuid) to service_role;

-- ─────────────────────────────────────────── a page load (the site only): kept once per code
create or replace function public.viewer_page_record(p_id uuid, p_source jsonb, p_device text default null, p_browser text default null)
returns void language plpgsql security definer set search_path = public as $$
declare problem text := public.viewer_source_problem(p_source);
begin
  if p_id is null then raise exception 'A page load has a code.' using errcode = 'check_violation'; end if;
  if problem is not null then raise exception '%', problem using errcode = 'check_violation'; end if;
  if p_device is not null and p_device not in ('phone', 'tablet', 'desktop') then raise exception 'The device is phone, tablet or desktop.' using errcode = 'check_violation'; end if;
  if p_browser is not null and p_browser not in ('facebook', 'instagram', 'other') then raise exception 'The browser is facebook, instagram or other.' using errcode = 'check_violation'; end if;
  if exists (select 1 from public.viewer_page_loads where id = p_id) then return; end if;
  if (select count(*) from public.viewer_page_loads where at > now() - interval '1 minute') >= 120
     or (select count(*) from public.viewer_page_loads where at > now() - interval '1 day') >= 5000 then
    raise exception 'Too many page loads right now.' using errcode = 'P0001';
  end if;
  delete from public.viewer_page_loads where at < now() - interval '400 days';
  insert into public.viewer_page_loads (id, source, device, browser) values (p_id, coalesce(p_source, '{}'::jsonb), p_device, p_browser);
end $$;
revoke all on function public.viewer_page_record(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.viewer_page_record(uuid, jsonb, text, text) to service_role;
