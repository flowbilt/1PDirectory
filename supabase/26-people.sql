-- Lobby Directory: people under tenants (DP-09 round 14).
-- Run in Supabase BEFORE uploading the round 14 code: SQL Editor -> New query -> paste -> Run.
-- (The new editor reads and writes the new tables, so they must exist first; the old code never asks for them.)
-- Safe to run more than once. Then run check-people.sql; it should end with ALL 10 CHECKS PASSED (red on purpose).
--
-- Scot's decisions (2026-10-23):
--   * People are found only through their company: tap the company to see its people. There's no building-wide
--     list or search of names, so nothing here makes one.
--   * Whether people show is the owner's choice: a switch per tenant (company) and a Show tick per person. Off until
--     the owner turns it on. 1Point keeps the same access as for tenants (for the rare customer who pays for full
--     management) but sets no default of its own.
--   * A person is kept whether or not they show: later work (a visitor alert to the person, access control) needs the
--     record in spite of the screen. So an entry has room for first and last name, title, phone or extension, email
--     and a suite when it differs from the company's; the customer fills in as much as they want.
--   * People are kept per building, under the company, so every screen in the building that lists a company shares
--     one list of its people (the Perimeter Park Two entrance screens have a directory each).
--
--   companies        one per company name per building, made and linked automatically from the tenant rows
--                    (the same name in any of the building's directories is the same company; case and extra spaces
--                    don't matter). show_people is the owner's switch; show_title, show_phone, show_email say which
--                    details go to the screens with it on. Renaming a tenant renames its company, people and all,
--                    when that tenant row is the company's only listing and the new name is free.
--   people           a company's people. show = the person's own tick.
--   tenants.company_id  set by the database from the tenant's name, never by the editor.
--   screen_state     each tenant carries its people ONLY on a screen marked touch (screens.touch, round 13), only
--                    with the company's switch on, only people ticked Show, and only the details the company shows.
--                    Display-only screens and the Directory to Go phone page (togo_page, unchanged) never get people.
--   Changes to people or a company's switches mark every directory listing that company as changed, so screens pick
--   them up within a minute, like tenant edits.

-- ── the tables ──
create or replace function public.company_key(n text) returns text
language sql immutable as $$ select lower(regexp_replace(btrim(coalesce(n, '')), '\s+', ' ', 'g')) $$;

create table if not exists public.companies (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties (id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 90),
  name_key     text generated always as (public.company_key(name)) stored,
  show_people  boolean not null default false,   -- the owner's switch: people show on touch screens
  show_title   boolean not null default true,    -- which details show, with the switch on
  show_phone   boolean not null default false,
  show_email   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users (id) on delete set null,
  unique (property_id, name_key)
);

create table if not exists public.people (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  sort         integer not null default 0,
  first_name   text not null default '' check (length(first_name) <= 60),
  last_name    text not null default '' check (length(last_name) <= 60),
  title        text not null default '' check (length(title) <= 80),
  phone        text not null default '' check (length(phone) <= 40),     -- a phone number or an extension
  email        text not null default '' check (length(email) <= 120),
  suite        text not null default '' check (length(suite) <= 16),     -- only when it differs from the company's
  show         boolean not null default true,                            -- the person's own tick
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users (id) on delete set null,
  constraint people_named check (length(btrim(first_name)) > 0 or length(btrim(last_name)) > 0)
);
create index if not exists people_company_sort on public.people (company_id, sort);

alter table public.tenants add column if not exists company_id uuid references public.companies (id) on delete set null;
create index if not exists tenants_company on public.tenants (company_id);

-- ── helpers ──
create or replace function public.company_org(c uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select p.org_id from public.companies co join public.properties p on p.id = co.property_id where co.id = c;
$$;

-- Every directory that lists this company is changed, so its screens fetch the new people
create or replace function public.touch_company(c uuid) returns void
language sql security definer set search_path = public as $$
  update public.directories set updated_at = now(), updated_by = auth.uid()
   where id in (select directory_id from public.tenants where company_id = c);
$$;
revoke all on function public.touch_company(uuid) from public, anon, authenticated;

-- ── tenants find their company by name (before insert or update) ──
create or replace function public.tenant_company() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_prop uuid;
  v_key  text := public.company_key(new.name);
  v_co   uuid;
begin
  select property_id into v_prop from public.directories where id = new.directory_id;
  if v_prop is null then return new; end if;
  -- An upsert of a row that already exists arrives here first as an insert: leave it to the update that follows,
  -- so a rename isn't mistaken for a new company
  if tg_op = 'INSERT' and exists (select 1 from public.tenants where id = new.id) then return new; end if;
  -- A rename keeps the company (and its people) when this row is its only listing and the new name is free
  if tg_op = 'UPDATE' and old.company_id is not null and new.directory_id = old.directory_id
     and public.company_key(old.name) <> v_key
     and not exists (select 1 from public.tenants where company_id = old.company_id and id <> old.id)
     and not exists (select 1 from public.companies where property_id = v_prop and name_key = v_key) then
    update public.companies set name = btrim(new.name), updated_at = now(), updated_by = auth.uid() where id = old.company_id;
    new.company_id := old.company_id;
    return new;
  end if;
  select id into v_co from public.companies where property_id = v_prop and name_key = v_key;
  if v_co is null then
    insert into public.companies (property_id, name) values (v_prop, btrim(new.name))
    on conflict (property_id, name_key) do nothing returning id into v_co;
    if v_co is null then select id into v_co from public.companies where property_id = v_prop and name_key = v_key; end if;
  end if;
  new.company_id := v_co;
  return new;
end $$;
drop trigger if exists tenants_company on public.tenants;
create trigger tenants_company before insert or update on public.tenants for each row execute function public.tenant_company();

-- ── a company's name and building are the database's to keep; owners change only the switches ──
create or replace function public.guard_company_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_platform_admin()
     and (new.property_id is distinct from old.property_id or new.name is distinct from old.name) then
    raise exception 'A company takes its name from the tenant list: rename the tenant instead';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists companies_guard on public.companies;
create trigger companies_guard before update on public.companies for each row execute function public.guard_company_update();

create or replace function public.people_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists people_stamp on public.people;
create trigger people_stamp before insert or update on public.people for each row execute function public.people_stamp();

create or replace function public.people_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'companies' then
    if (new.show_people, new.show_title, new.show_phone, new.show_email, new.name)
       is distinct from (old.show_people, old.show_title, old.show_phone, old.show_email, old.name) then
      perform public.touch_company(new.id);
    end if;
  else
    perform public.touch_company(coalesce(new.company_id, old.company_id));
    if tg_op = 'UPDATE' and new.company_id is distinct from old.company_id then perform public.touch_company(old.company_id); end if;
  end if;
  return null;
end $$;
drop trigger if exists companies_touch on public.companies;
create trigger companies_touch after update on public.companies for each row execute function public.people_touch();
drop trigger if exists people_touch on public.people;
create trigger people_touch after insert or update or delete on public.people for each row execute function public.people_touch();

-- ── existing tenants get their companies ──
update public.tenants set name = name where company_id is null;

-- ── row-level security: as for tenants (the owner's admins and editors, and 1Point) ──
alter table public.companies enable row level security;
alter table public.people    enable row level security;

drop policy if exists company_read on public.companies;
create policy company_read on public.companies for select to authenticated
  using (public.is_platform_admin() or public.company_org(id) = public.my_org());
drop policy if exists company_edit on public.companies;
create policy company_edit on public.companies for update to authenticated
  using (public.is_platform_admin() or public.company_org(id) = public.my_org())
  with check (public.is_platform_admin() or public.company_org(id) = public.my_org());
drop policy if exists company_delete on public.companies;
create policy company_delete on public.companies for delete to authenticated using (public.is_platform_admin());
-- (no insert policy: companies are made by the tenant list)

drop policy if exists people_all on public.people;
create policy people_all on public.people for all to authenticated
  using (public.is_platform_admin() or public.company_org(company_id) = public.my_org())
  with check (public.is_platform_admin() or public.company_org(company_id) = public.my_org());

revoke all on public.companies, public.people from anon;
grant select, update, delete on public.companies to authenticated;
revoke insert on public.companies from authenticated;          -- made only by the tenant list
grant select, insert, update, delete on public.people to authenticated;

-- ── screen_state (from 25-touch.sql), with each tenant's people on touch screens only ──
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

  -- The version: anything the screen shows. Tenant and people edits bump the directory's updated_at (triggers in 01
  -- and 26), and building or directory edits bump their own. The screen's own sizes, its WayTuGo mark and its touch
  -- settings count too.
  v_etag := md5(concat_ws('|', s.key, s.name, s.orientation, coalesce(s.directory_id::text, '-'),
                          coalesce(s.identify_until::text, '-'), coalesce(d.updated_at::text, '-'), coalesce(p.updated_at::text, '-'),
                          coalesce(s.sizes::text, '{}'), s.hide_powered_by::text,
                          s.touch::text, coalesce(s.screen_inches::text, '-')));
  if v_etag = p_etag then
    return jsonb_build_object('etag', v_etag, 'not_modified', true);
  end if;

  return jsonb_build_object(
    'etag', v_etag,
    'screen', jsonb_build_object('key', s.key, 'name', s.name, 'orientation', s.orientation, 'identify_until', s.identify_until,
                                 'sizes', coalesce(s.sizes, '{}'::jsonb), 'hide_powered_by', s.hide_powered_by,
                                 'touch', s.touch, 'screen_inches', s.screen_inches),
    'dir',  case when d.id is not null then to_jsonb(d) end,
    'prop', case when p.id is not null then to_jsonb(p) end,
    'tenants', case when d.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('name', t.name, 'suite', t.suite, 'arrow', t.arrow, 'note', t.note, 'sort', t.sort,
        'people', case when not s.touch then '[]'::jsonb else coalesce((
          select jsonb_agg(jsonb_build_object(
                   'first', pe.first_name, 'last', pe.last_name,
                   'title', case when co.show_title then pe.title else '' end,
                   'phone', case when co.show_phone then pe.phone else '' end,
                   'email', case when co.show_email then pe.email else '' end,
                   'suite', pe.suite)
                 order by pe.sort, lower(pe.last_name), lower(pe.first_name))
            from public.people pe join public.companies co on co.id = pe.company_id
           where pe.company_id = t.company_id and co.show_people and pe.show), '[]'::jsonb) end)
        order by t.sort, t.name)
      from public.tenants t where t.directory_id = d.id), '[]'::jsonb) end
  );
end $$;

revoke all on function public.screen_state(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.screen_state(text, text, text, jsonb) to service_role;

notify pgrst, 'reload schema';
