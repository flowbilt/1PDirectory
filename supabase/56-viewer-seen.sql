-- DP-15 (V5e): background loads and quick exits in the viewer's figures. Run after 55-viewer-email.sql, BEFORE uploading
-- the V5e code: SQL Editor -> New query -> paste -> Run. Safe to run again. Then run check-viewer-seen.sql; it should end
-- with ALL 3 CHECKS PASSED (red on purpose).
--
-- Scot (2026-11-19), after the 30-day CSV: 24 of 43 ad visits were gone within about a second, 13 of them with the
-- page loaded twice in the same second; whether they're accidental taps or the Facebook app loading the page in the
-- background couldn't be told. Two more events (= viewer-sample.mjs VISIT_EVENTS):
--   viewer_loaded_unseen   the page loaded while it wasn't on screen (the browser says it's hidden or being
--                          prerendered), counted per load
--   viewer_seen            the page was on screen at some point (at its load, or later)
-- A visit with viewer_loaded_unseen and no viewer_seen is a background load: the console leaves it out of its figures.
-- Nothing else changes: no new column, the same rules for who may read or keep visits.

create or replace function public.viewer_events_problem(e jsonb) returns text
language plpgsql immutable set search_path = public as $$
begin
  if e is null then return null; end if;
  if jsonb_typeof(e) <> 'object' then return 'The events are an object.'; end if;
  if exists (select 1 from jsonb_each(e) x
             where x.key not in ('viewer_page_loaded', 'viewer_loaded_unseen', 'viewer_seen', 'viewer_initialized', 'configuration_edited',
                                 'full_preview_opened', 'full_preview_closed', 'directory_image_downloaded', 'directory_share_initiated',
                                 'directory_share_completed', 'directory_email_sent', 'quote_form_opened', 'quote_submitted', 'viewer_error')
                or jsonb_typeof(x.value) <> 'number' or (x.value #>> '{}') !~ '^[0-9]+$' or (x.value #>> '{}')::numeric > 10000) then
    return 'Each event is one of the viewer''s, counted 0 to 10,000.';
  end if;
  return null;
end $$;
revoke all on function public.viewer_events_problem(jsonb) from public, anon, authenticated;
