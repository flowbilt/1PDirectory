-- DP-13 round L1: boards that turn. Run after 45-logo-name.sql. Safe to run again.
--
-- Scot (2026-11-06): "the way that the directories reorient between landscape and portrait? What would be the
-- possibility of doing the same with the menu boards... and all boards for that matter." A layout may now carry its
-- other shape ("turned" in its JSON: every block placed again on that shape's grid, or hidden there); the screen's
-- Orientation picks the shape. So a screen may show a layout of the other shape when its published version has that
-- arrangement (29's guard_screen_layout, one condition more), and a new version (published or rolled back) can't drop
-- the arrangement while a screen shows it that way (29's guard_layout_update, one check more). Nothing else changed.

-- ─────────────────────────────────────────── a screen and its layout's shape (29's, turned layouts allowed)
create or replace function public.guard_screen_layout() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  l public.layouts%rowtype;
begin
  if new.layout_id is null then return new; end if;
  select * into l from public.layouts where id = new.layout_id;
  if l.published_version is null and (tg_op = 'INSERT' or new.layout_id is distinct from old.layout_id) then
    raise exception 'The layout "%" hasn''t been published yet. Publish it on the Layouts tab first.', l.name
      using errcode = 'check_violation';
  end if;
  if new.property_id is null then
    raise exception 'Choose the building this screen is in. A layout takes its time zone, weather and address from the screen''s building.'
      using errcode = 'check_violation';
  end if;
  if public.property_org(new.property_id) is distinct from l.org_id then
    raise exception 'That building belongs to a different account from the layout "%". Choose one of the layout''s account''s buildings.', l.name
      using errcode = 'check_violation';
  end if;
  -- L1 (DP-13): a layout that turns (its published version has the other shape, "turned") suits either Orientation
  if public.orientation_shape(new.orientation) <> l.orientation
     and not coalesce((select jsonb_typeof(v.doc -> 'turned') = 'object' from public.layout_versions v
                        where v.layout_id = l.id and v.version = l.published_version), false) then
    raise exception 'The layout "%" is %, and this screen''s Orientation is %. Change the screen''s Orientation to % first, choose a % layout, or give this one a % arrangement ("turned").',
      l.name, l.orientation, public.orientation_label(new.orientation),
      case l.orientation when 'portrait' then 'Portrait' else 'Landscape' end, public.orientation_shape(new.orientation), public.orientation_shape(new.orientation)
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists screens_layout_guard on public.screens;
create trigger screens_layout_guard before insert or update of layout_id, property_id, orientation on public.screens
  for each row execute function public.guard_screen_layout();

-- ─────────────────────────────────────────── a new version keeps the screens' shapes (29's, one check more)
create or replace function public.guard_layout_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n integer;
  shape text;
begin
  if new.orientation <> old.orientation or new.org_id <> old.org_id then
    select count(*) into n from public.screens where layout_id = old.id;
    if n > 0 then
      raise exception 'The layout "%" is shown on % screen(s). Choose something else for those screens first.', old.name, n
        using errcode = 'check_violation';
    end if;
  end if;
  -- L1 (DP-13): a new version (published or rolled back) keeps every screen showing it: a screen set to the layout's
  -- other shape needs that version to have its "turned" arrangement
  if new.published_version is distinct from old.published_version and new.published_version is not null then
    -- a layout's "turned" is always its other shape
    select case when jsonb_typeof(v.doc -> 'turned') = 'object' then (case new.orientation when 'portrait' then 'landscape' else 'portrait' end) end
      into shape from public.layout_versions v where v.layout_id = new.id and v.version = new.published_version;
    select count(*) into n from public.screens s where s.layout_id = new.id and public.orientation_shape(s.orientation) <> new.orientation
       and public.orientation_shape(s.orientation) is distinct from shape;
    if n > 0 then
      raise exception 'The layout "%" is shown on % screen(s) set to %, and this version has no % arrangement ("turned"). Keep the arrangement, or change those screens'' Orientation first.',
        new.name, n, case new.orientation when 'portrait' then 'Landscape' else 'Portrait' end, case new.orientation when 'portrait' then 'landscape' else 'portrait' end
        using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists layouts_guard on public.layouts;
create trigger layouts_guard before update on public.layouts for each row execute function public.guard_layout_update();
