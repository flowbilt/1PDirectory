-- DP-13 round T0b: a sample's phone menu ends with its sample links. Run after 36-templates.sql. Safe to run again.
--
-- Scot (testing T0): turning a sample link off stopped the page at once, but the board's QR code (its phone menu,
-- waytugo.com/m/<code>) still opened. Now a board in a WayTuGo samples account has a phone menu (and "See the board")
-- only while one of its sample links is open: turned off, or past its date, the QR code says the link isn't active;
-- opening a link again brings it back. Boards in every other account (customers', WayTuGo templates) are unchanged.

create or replace function public.menu_page(p_code text, p_count boolean default true) returns jsonb
language plpgsql set search_path = public as $$
declare
  l  public.layouts%rowtype;
  lv public.layout_versions%rowtype;
  p  public.properties%rowtype;
  m  public.menus%rowtype;
begin
  select * into l from public.layouts where menu_code = upper(coalesce(p_code, ''));
  if not found or l.published_version is null then return jsonb_build_object('missing', true); end if;
  -- T0b (DP-13): a board in a WayTuGo samples account answers only while one of its sample links is open, so turning
  -- off (or the end of) its last link ends its phone menu and QR code too. Every other account's boards are unchanged.
  if exists (select 1 from public.organizations o where o.id = l.org_id and o.kind = 'samples')
     and not exists (select 1 from public.sample_links sl where sl.layout_id = l.id and sl.turned_off_at is null and sl.expires_at > now()) then
    return jsonb_build_object('missing', true);
  end if;
  select * into lv from public.layout_versions where layout_id = l.id and version = l.published_version;
  if l.menu_id is not null then select * into m from public.menus where id = l.menu_id; end if;
  select pr.* into p from public.screens s join public.properties pr on pr.id = s.property_id
   where s.layout_id = l.id order by s.last_seen desc nulls last limit 1;
  -- T0 (DP-13): a board on no screen yet (a sample) names the building of its newest sample link that's still open
  if not found then
    select pr.* into p from public.sample_links sl join public.properties pr on pr.id = sl.property_id
     where sl.layout_id = l.id and sl.turned_off_at is null and sl.expires_at > now() order by sl.created_at desc limit 1;
  end if;
  if not found then select * into p from public.properties where org_id = l.org_id order by name limit 1; end if;
  if p_count then
    insert into public.menu_scans (layout_id, day, scans) values (l.id, (now() at time zone 'America/Chicago')::date, 1)
      on conflict (layout_id, day) do update set scans = public.menu_scans.scans + 1;
  end if;
  return jsonb_build_object(
    'layout', jsonb_build_object('id', l.id, 'name', l.name, 'orientation', l.orientation, 'version', lv.version, 'doc', lv.doc,
                                 'menu_code', l.menu_code),
    'lists', case when m.id is not null then jsonb_build_object('id', m.id, 'spec', m.spec, 'content', m.content) end,
    'images', coalesce((
      select jsonb_object_agg(i.key, jsonb_build_object('path', i.path, 'w', i.width, 'h', i.height))
        from public.layout_images i
       where i.org_id = l.org_id and (lv.doc::text || coalesce(m.content::text, '')) like '%"img:' || i.key || '"%'), '{}'::jsonb),
    'prop', case when p.id is not null then jsonb_build_object('id', p.id, 'name', p.name, 'address', p.address, 'timezone', p.timezone,
                                                                'lat', p.lat, 'lon', p.lon, 'updated_at', p.updated_at) end);
end $$;
revoke all on function public.menu_page(text, boolean) from public, anon, authenticated;
grant execute on function public.menu_page(text, boolean) to service_role;
