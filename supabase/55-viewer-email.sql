-- DP-15 (V5b): the viewer's Email Me a Copy. Run after 54-viewer-events.sql, BEFORE uploading the V5b code:
-- SQL Editor -> New query -> paste -> Run. Safe to run again. Then run check-viewer-email.sql; it should end with
-- ALL 6 CHECKS PASSED (red on purpose).
--
-- Scot (2026-11-17): Share didn't list his email program, so the visitor emails the picture to themselves instead,
-- from the address the alert emails use (for now scotmuncher@gmail.com), with the sending address changeable in the
-- console. The picture passes through the site once to be emailed (Scot: "that would be fine") and isn't kept; nor is
-- the visitor's address.
--
--   viewer_email_settings  one row (or none: off). enabled (off until 1Point turns it on); from_name; from_address
--                          (empty: the mail server's own, Pi setup -> Alert emails); reply_to (where answers go);
--                          daily_limit. Only the site's server functions reach it (like mail_settings).
--   viewer_email_sends     one line per email sent: when, the visit, and a one-way fingerprint of the address (to
--                          refuse a second email to it within the hour without keeping the address). Two days kept.
--   viewer_email_claim     the limits, checked and counted in one step: a visit kept in the last day, 3 emails a visit,
--                          1 an hour to the same address, the daily limit. Returns null (go ahead) or why not.
--   viewer_email_release   a send that failed gives its claim back (so "try again" works).
--   viewer_events_problem  gains directory_email_sent.

create table if not exists public.viewer_email_settings (
  id           boolean primary key default true check (id),   -- at most one row
  enabled      boolean not null default false,
  from_name    text not null default 'WayTuGo' check (char_length(from_name) <= 80 and from_name !~ '[<>"\r\n]'),
  from_address text check (from_address is null or from_address ~* '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$'),
  reply_to     text check (reply_to is null or reply_to ~* '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$'),
  daily_limit  integer not null default 50 check (daily_limit between 1 and 500),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users (id) on delete set null
);
alter table public.viewer_email_settings enable row level security;
revoke all on public.viewer_email_settings from anon, authenticated;

create table if not exists public.viewer_email_sends (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  visit     uuid not null,
  addr_hash text not null check (addr_hash ~ '^[0-9a-f]{64}$')
);
create index if not exists viewer_email_sends_at on public.viewer_email_sends (at desc);
alter table public.viewer_email_sends enable row level security;
revoke all on public.viewer_email_sends from anon, authenticated;

create or replace function public.viewer_email_claim(p_visit uuid, p_hash text, p_limit integer)
returns text language plpgsql security definer set search_path = public as $$
begin
  if p_visit is null or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then return 'bad'; end if;
  perform pg_advisory_xact_lock(hashtext('viewer_email_claim'));
  delete from public.viewer_email_sends where at < now() - interval '2 days';
  if not exists (select 1 from public.viewer_visits where id = p_visit and started_at > now() - interval '1 day') then return 'visit'; end if;
  if (select count(*) from public.viewer_email_sends where visit = p_visit) >= 3 then return 'visit-limit'; end if;
  if exists (select 1 from public.viewer_email_sends where addr_hash = p_hash and at > now() - interval '1 hour') then return 'address-limit'; end if;
  if (select count(*) from public.viewer_email_sends where at > now() - interval '1 day') >= least(greatest(coalesce(p_limit, 50), 1), 500) then return 'daily-limit'; end if;
  insert into public.viewer_email_sends (visit, addr_hash) values (p_visit, p_hash);
  return null;
end $$;
revoke all on function public.viewer_email_claim(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.viewer_email_claim(uuid, text, integer) to service_role;

create or replace function public.viewer_email_release(p_visit uuid, p_hash text)
returns void language sql security definer set search_path = public as $$
  delete from public.viewer_email_sends
  where id = (select max(id) from public.viewer_email_sends where visit = p_visit and addr_hash = p_hash and at > now() - interval '10 minutes')
$$;
revoke all on function public.viewer_email_release(uuid, text) from public, anon, authenticated;
grant execute on function public.viewer_email_release(uuid, text) to service_role;

-- 54's rules, with directory_email_sent (= viewer-sample.mjs VISIT_EVENTS)
create or replace function public.viewer_events_problem(e jsonb) returns text
language plpgsql immutable set search_path = public as $$
begin
  if e is null then return null; end if;
  if jsonb_typeof(e) <> 'object' then return 'The events are an object.'; end if;
  if exists (select 1 from jsonb_each(e) x
             where x.key not in ('viewer_page_loaded', 'viewer_initialized', 'configuration_edited', 'full_preview_opened', 'full_preview_closed',
                                 'directory_image_downloaded', 'directory_share_initiated', 'directory_share_completed', 'directory_email_sent',
                                 'quote_form_opened', 'quote_submitted', 'viewer_error')
                or jsonb_typeof(x.value) <> 'number' or (x.value #>> '{}') !~ '^[0-9]+$' or (x.value #>> '{}')::numeric > 10000) then
    return 'Each event is one of the viewer''s, counted 0 to 10,000.';
  end if;
  return null;
end $$;
revoke all on function public.viewer_events_problem(jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';
