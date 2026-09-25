-- Lobby Directory: database schema for Supabase
-- Run once in Supabase: SQL Editor -> New query -> paste this whole file -> Run.
--
-- Structure
--   organizations   an owner or property manager (e.g. Barber Companies)
--   properties      a building, with its branding and contacts (e.g. Perimeter Park One)
--   directories     one tenant listing, e.g. a floor lobby (e.g. "Two South")
--   tenants         rows in a directory
--   screens         a physical display; points at one directory
--   profiles        who can sign in, their role, and which organization they belong to
--   audit_log       who changed what, and when
--
-- Roles
--   platform_admin  1Point staff: everything
--   org_admin       an owner's lead: edits their buildings and manages their own users
--   org_editor      an owner's staff: edits their buildings' content only
--
-- Access is enforced by row-level security below, not just by the web pages.

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────── tables

create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  kind        text not null default 'owner' check (kind in ('owner', 'manager')),
  notes       text not null default '',
  created_at  timestamptz not null default now()
);

create table public.profiles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  role        text not null check (role in ('platform_admin', 'org_admin', 'org_editor')),
  org_id      uuid references public.organizations (id) on delete cascade,
  created_at  timestamptz not null default now(),
  constraint profiles_org_required check (role = 'platform_admin' or org_id is not null)
);

create table public.properties (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete restrict,
  name                text not null check (length(trim(name)) > 0),
  address             text not null default '',
  timezone            text not null default 'America/Chicago',
  lat                 double precision,
  lon                 double precision,
  logo                text not null default '',            -- image as a data URL
  logo_replaces_name  boolean not null default false,
  background          jsonb not null default '{}'::jsonb,  -- {enabled, image, visibility, size, position, offset}
  managed_by          jsonb not null default '{}'::jsonb,  -- {name, company, phone}
  leased_by           jsonb not null default '{}'::jsonb,
  footer              text not null default '',            -- bottom line, e.g. leasing phone
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null
);

create table public.directories (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references public.properties (id) on delete cascade,
  slug             text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  title            text not null check (length(trim(title)) > 0),  -- e.g. "Perimeter Park One - Two South"
  subtitle         text not null default '',                        -- e.g. "South Tower"
  footer_override  text,                                            -- null = use the property's footer
  news_enabled     boolean not null default true,
  rotate_seconds   integer not null default 12 check (rotate_seconds between 5 and 120),
  weather_enabled  boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null
);

create table public.tenants (
  id            uuid primary key default gen_random_uuid(),
  directory_id  uuid not null references public.directories (id) on delete cascade,
  sort          integer not null default 0,
  name          text not null check (length(trim(name)) > 0),
  suite         text not null default '',
  arrow         text not null default '' check (arrow in ('', 'left', 'right', 'up', 'down')),
  note          text not null default ''   -- small line under the name
);
create index tenants_directory_sort on public.tenants (directory_id, sort);

create table public.screens (
  id             uuid primary key default gen_random_uuid(),
  directory_id   uuid references public.directories (id) on delete set null,
  key            text not null unique check (key ~ '^[a-z0-9][a-z0-9-]{0,47}$'),  -- used in the Pi's address
  name           text not null,
  location_note  text not null default '',
  orientation    text not null default 'auto' check (orientation in ('auto', 'portrait', 'landscape')),
  hardware       jsonb not null default '{}'::jsonb,  -- serial, MAC, model, old Yodeck ID
  last_seen      timestamptz,
  last_report    jsonb not null default '{}'::jsonb,  -- what the screen reported at check-in
  created_at     timestamptz not null default now()
);

create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid references auth.users (id) on delete set null,
  action      text not null,
  entity      text not null,
  entity_id   uuid,
  detail      jsonb not null default '{}'::jsonb
);

-- ─────────────────────────────────────────── helper functions
-- security definer so they can read profiles without tripping the profiles policies.

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where user_id = auth.uid() and role = 'platform_admin');
$$;

create or replace function public.my_org() returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from public.profiles where user_id = auth.uid();
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where user_id = auth.uid();
$$;

create or replace function public.directory_org(d uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select p.org_id from public.directories di join public.properties p on p.id = di.property_id where di.id = d;
$$;

-- ─────────────────────────────────────────── guard rails
-- Owner users may edit content, but may not move a building or directory to another owner,
-- (auth.uid() is null when the server's service key or the SQL editor makes the change; those are allowed)
-- rename a screen address, or change hardware settings. Only platform admins can.

create or replace function public.guard_property_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_platform_admin() and new.org_id is distinct from old.org_id then
    raise exception 'Only 1Point admins can move a building to another owner';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

create or replace function public.guard_directory_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_platform_admin() and (new.property_id is distinct from old.property_id or new.slug is distinct from old.slug) then
    raise exception 'Only 1Point admins can move or rename a directory';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

-- Editing a tenant marks its directory as changed, so screens pick it up on their next check.
create or replace function public.touch_directory() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.directories set updated_at = now(), updated_by = auth.uid()
   where id = coalesce(new.directory_id, old.directory_id);
  return null;
end $$;

create trigger properties_guard before update on public.properties for each row execute function public.guard_property_update();
create trigger directories_guard before update on public.directories for each row execute function public.guard_directory_update();
create trigger tenants_touch after insert or update or delete on public.tenants for each row execute function public.touch_directory();

-- ─────────────────────────────────────────── row-level security

alter table public.organizations enable row level security;
alter table public.profiles      enable row level security;
alter table public.properties    enable row level security;
alter table public.directories   enable row level security;
alter table public.tenants       enable row level security;
alter table public.screens       enable row level security;
alter table public.audit_log     enable row level security;

-- organizations: see your own; 1Point sees and manages all
create policy org_read   on public.organizations for select to authenticated using (public.is_platform_admin() or id = public.my_org());
create policy org_write  on public.organizations for all    to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

-- profiles: see yourself; org admins see their own team; 1Point sees all.
-- Creating users and changing roles happens only through the server (Netlify function), never directly.
create policy profile_read on public.profiles for select to authenticated using (
  public.is_platform_admin() or user_id = auth.uid() or (public.my_role() = 'org_admin' and org_id = public.my_org()));

-- properties: owners read and edit theirs; only 1Point creates or deletes
create policy prop_read   on public.properties for select to authenticated using (public.is_platform_admin() or org_id = public.my_org());
create policy prop_edit   on public.properties for update to authenticated using (public.is_platform_admin() or org_id = public.my_org()) with check (public.is_platform_admin() or org_id = public.my_org());
create policy prop_create on public.properties for insert to authenticated with check (public.is_platform_admin());
create policy prop_delete on public.properties for delete to authenticated using (public.is_platform_admin());

-- directories: same pattern
create policy dir_read   on public.directories for select to authenticated using (public.is_platform_admin() or public.directory_org(id) = public.my_org());
create policy dir_edit   on public.directories for update to authenticated using (public.is_platform_admin() or public.directory_org(id) = public.my_org()) with check (public.is_platform_admin() or public.directory_org(id) = public.my_org());
create policy dir_create on public.directories for insert to authenticated with check (public.is_platform_admin());
create policy dir_delete on public.directories for delete to authenticated using (public.is_platform_admin());

-- tenants: owners fully manage the rows in their own directories
create policy tenant_all on public.tenants for all to authenticated
  using (public.is_platform_admin() or public.directory_org(directory_id) = public.my_org())
  with check (public.is_platform_admin() or public.directory_org(directory_id) = public.my_org());

-- screens: owners can see status of their screens; only 1Point changes them
create policy screen_read  on public.screens for select to authenticated using (public.is_platform_admin() or public.directory_org(directory_id) = public.my_org());
create policy screen_write on public.screens for all    to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

-- audit log: 1Point reads it; rows are written by the server
create policy audit_read on public.audit_log for select to authenticated using (public.is_platform_admin());

-- The lobby screens never talk to the database directly. They read through the Netlify site,
-- which uses the service key, so nothing here is readable without signing in.
