-- DP-13 round G1: Poppins, a font for the boards and the shop's brand. Run after 42-quick-switch.sql. Safe to run again.
--
-- Gibbs Garden Center's website and wordmark are in Poppins, so it joins WayTuGo's fonts (public/layout-format.mjs
-- FONTS, public/fonts/Poppins-*.ttf). The Brand panel offers every board font (menu-format.mjs BRAND_FONTS), so a
-- brand may now say Poppins too: 38's menu_brand_problem with one more font, nothing else changed.

-- ─────────────────────────────────────────── the brand's rules (38's, Poppins added)
create or replace function public.menu_brand_problem(p_brand jsonb, p_org uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare k text; v jsonb;
begin
  if jsonb_typeof(p_brand) <> 'object' then return 'The brand is { "name", "logo", "colours", "fonts" }.'; end if;
  if exists (select 1 from jsonb_object_keys(p_brand) x where x not in ('name', 'logo', 'colours', 'fonts')) then
    return 'The brand can say name, logo, colours and fonts.';
  end if;
  if p_brand ? 'name' and (jsonb_typeof(p_brand -> 'name') <> 'string' or length(trim(p_brand ->> 'name')) = 0 or length(p_brand ->> 'name') > 60) then
    return 'The shop''s name is 1 to 60 characters.';
  end if;
  if p_brand ? 'logo' then
    if jsonb_typeof(p_brand -> 'logo') <> 'string' or (p_brand ->> 'logo') !~ '^img:[a-z0-9][a-z0-9-]{0,59}$' then return 'The logo is one of the account''s pictures.'; end if;
    if not exists (select 1 from public.layout_images where org_id = p_org and key = substr(p_brand ->> 'logo', 5)) then
      return format('There''s no picture "%s" in this account for the logo.', substr(p_brand ->> 'logo', 5));
    end if;
  end if;
  if p_brand ? 'colours' then
    if jsonb_typeof(p_brand -> 'colours') <> 'object' then return 'The brand''s colours are background, text, accent, dark panel and highlight.'; end if;
    for k, v in select * from jsonb_each(p_brand -> 'colours') loop
      if k not in ('bg', 'ink', 'accent', 'panel', 'highlight') then return 'The brand''s colours are background, text, accent, dark panel and highlight.'; end if;
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^#[0-9a-fA-F]{6}$' then return 'Each brand colour is a colour like #3b2620.'; end if;
    end loop;
  end if;
  if p_brand ? 'fonts' then
    if jsonb_typeof(p_brand -> 'fonts') <> 'object' then return 'The brand''s fonts are for headings and body text.'; end if;
    for k, v in select * from jsonb_each(p_brand -> 'fonts') loop
      if k not in ('display', 'body') then return 'The brand''s fonts are for headings and body text.'; end if;
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('Instrument Sans', 'Lora', 'Oswald', 'Bebas Neue', 'Alfa Slab One', 'Fraunces',
                                                            'Playfair Display', 'Pacifico', 'Crimson Pro', 'Caveat Brush', 'Poppins') then
        return format('"%s" isn''t one of WayTuGo''s fonts.', v #>> '{}');
      end if;
    end loop;
  end if;
  return null;
end $$;
revoke all on function public.menu_brand_problem(jsonb, uuid) from public, anon, authenticated;
