-- DP-13 round M1b: Sold out and Hide save on a tap. Run after 41-qr-on-board.sql. Safe to run again.
--
-- Scot (2026-11-03), behind the counter: "I sell out of baked ziti ... I need it off the board and I don't need to wait
-- for the save, and at the same time ... I also don't have anchovy pizza." Prices and names still go through Save
-- ("Those need a 'Yes, I meant to do that' that save implies and the audit trail to verify it"); Sold out and Hide
-- (Scot: "a. Yes") change one entry at once. menu_switch changes only that entry in the menu as it is now, so a tap on
-- one phone never undoes a tap or a save on another, then saves through menu_write like any save: the same rules
-- (who may edit, customer editing on, the menu's own checks, the brand and sizes kept), a new revision in History.

create or replace function public.menu_switch(p_menu uuid, p_list text, p_entry text, p_what text, p_on boolean, p_today date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_content jsonb; v_rev integer; v_entries jsonb; v_i integer; v_e jsonb;
begin
  if p_what not in ('sold', 'hidden') then raise exception 'A switch is sold or hidden.' using errcode = '22023'; end if;
  if p_today is null or abs(p_today - current_date) > 1 then raise exception 'Sold out is for today.' using errcode = '22023'; end if;
  -- who may: someone in the menu's account (menu_write then checks the role and customer editing) or 1Point
  if not coalesce(public.is_platform_admin() or exists (select 1 from public.menus where id = p_menu and org_id = public.my_org()), false) then
    raise exception 'That menu doesn''t exist, or you don''t have access to it.' using errcode = '42501';
  end if;
  select content, rev into v_content, v_rev from public.menus where id = p_menu for update;
  if not found then raise exception 'That menu doesn''t exist, or you don''t have access to it.' using errcode = '42501'; end if;
  v_entries := v_content -> 'lists' -> p_list -> 'entries';
  if jsonb_typeof(v_entries) is distinct from 'array' then raise exception 'That list isn''t on this menu any more.' using errcode = 'P0002'; end if;
  select i - 1, e into v_i, v_e from jsonb_array_elements(v_entries) with ordinality as t(e, i) where e ->> 'id' = p_entry;
  if v_i is null then raise exception 'That item isn''t on the menu any more. Reload to see the menu as it is now.' using errcode = 'P0002'; end if;
  if p_what = 'sold' then
    v_e := case when p_on then v_e || jsonb_build_object('soldOut', to_char(p_today, 'YYYY-MM-DD')) else v_e - 'soldOut' end;
  else
    v_e := case when p_on then v_e || '{"hidden": true}'::jsonb else v_e - 'hidden' end;
  end if;
  v_content := jsonb_set(v_content, array['lists', p_list, 'entries', v_i::text], v_e);
  return public.menu_write(p_menu, v_rev, v_content, null) || jsonb_build_object('entry', v_e);
end $$;
revoke all on function public.menu_switch(uuid, text, text, text, boolean, date) from public, anon;
grant execute on function public.menu_switch(uuid, text, text, text, boolean, date) to authenticated, service_role;
