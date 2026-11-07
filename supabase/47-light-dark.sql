-- DP-14: Light and Dark looks, and a board's look by the time of day. Run after 46-turning-boards.sql, before the code.
-- Safe to run again.
--
-- Scot (2026-11-06): "The idea at one point was to go with a light and dark choice ... I like dark for the default";
-- "The dark and light menus should be able to be scheduled as well"; "Sunset option is great, and it needs to be a tick
-- box that overrides scheduling. Every day for now." A board's choice (menus.content.boards[<layout id>]) may now say
-- "look": "light" or "dark", and "when": { "day", "evening", "dayAt", "eveningAt", "sun" }: the day look from dayAt, the
-- evening look from eveningAt, every day by the building's clock, or at sunrise and sunset when "sun" is ticked. The
-- customer chooses it, as with the look itself (39's menu_write keeps only the sizes as 1Point's). 45's
-- menu_board_problem with those two parts more; nothing else changed. Boards on House or Chalkboard are untouched.

-- ─────────────────────────────────────────── the rules (45's, with Light, Dark and "when")
create or replace function public.menu_board_problem(p_board jsonb) returns text
language plpgsql immutable set search_path = public as $$
declare k text; v jsonb; w jsonb;
begin
  if jsonb_typeof(p_board) <> 'object' then return 'Each board''s look is { "look", "chalk", "lettering", "frame", "options" }.'; end if;
  if exists (select 1 from jsonb_object_keys(p_board) x where x not in ('look', 'chalk', 'lettering', 'frame', 'options', 'sizes', 'when')) then
    return 'A board''s look can say look, chalk, lettering, frame, options, sizes and when.';
  end if;
  -- T1d (DP-13): the QR code's size on the glass and the logo's share of its spot
  if p_board ? 'sizes' then
    if jsonb_typeof(p_board -> 'sizes') <> 'object' then return 'A board''s sizes are for the QR code, the logo, the headings and the body text.'; end if;
    for k, v in select * from jsonb_each(p_board -> 'sizes') loop
      if k = 'qr' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('s', 'm', 'l') then return 'The QR code is Small, Medium or Large.'; end if;
      elsif k = 'logo' then
        if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric not between 60 and 100 or (v #>> '{}')::numeric <> floor((v #>> '{}')::numeric) then
          return 'The logo''s size is 60% to 100% of its spot.';
        end if;
      -- T1e (DP-13): the headings' and the body text's sizes, 80% to 130% in steps of 10
      elsif k in ('headings', 'body') then
        if jsonb_typeof(v) <> 'number' or (v #>> '{}') not in ('80', '90', '100', '110', '120', '130') then
          return 'Text sizes are 80% to 130%, in steps of 10.';
        end if;
      -- T1f (DP-13): the QR code on its white square, or drawn on the board
      elsif k = 'qrcode' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('white', 'board') then return 'The QR code is on a white square or drawn on the board.'; end if;
      -- L2 (DP-13): the logo block: the picture, the name or both; the name's place; left, centre or right
      elsif k = 'logoShow' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('picture', 'name', 'both') then return 'The logo shows the picture, the name or both.'; end if;
      elsif k = 'logoPlace' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('right', 'left', 'below') then return 'The name sits right of the picture, left of it or below it.'; end if;
      elsif k = 'logoAlign' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('left', 'center', 'right') then return 'The logo sits left, centre or right.'; end if;
      -- L2b (DP-13): the logo's name: its font (WayTuGo's), size (60% to 140% in steps of 10), one line or wrapping, weight
      elsif k = 'logoFont' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('Instrument Sans', 'Lora', 'Oswald', 'Bebas Neue', 'Alfa Slab One', 'Fraunces', 'Playfair Display', 'Pacifico', 'Crimson Pro', 'Caveat Brush', 'Poppins') then
          return format('"%s" isn''t one of WayTuGo''s fonts.', left(v #>> '{}', 40));
        end if;
      elsif k = 'logoSize' then
        if jsonb_typeof(v) <> 'number' or (v #>> '{}') not in ('60', '70', '80', '90', '100', '110', '120', '130', '140') then return 'The logo''s name is 60% to 140%, in steps of 10.'; end if;
      elsif k = 'logoLine' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('one', 'wrap') then return 'The logo''s name is on one line or wraps.'; end if;
      elsif k = 'logoWeight' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('regular', 'bold') then return 'The logo''s name is regular or bold.'; end if;
      else return 'A board''s sizes are for the QR code, the logo, the headings and the body text.';
      end if;
    end loop;
  end if;
  if p_board ? 'look' and coalesce(p_board ->> 'look', '') not in ('house', 'chalkboard', 'light', 'dark') then return 'The look is House, Chalkboard, Light or Dark.'; end if;
  -- DP-14: the look by the time of day: a day look, an evening look, their times (every day), and the sunset tick box
  if p_board ? 'when' then
    w := p_board -> 'when';
    if jsonb_typeof(w) <> 'object' or exists (select 1 from jsonb_object_keys(w) x where x not in ('day', 'evening', 'dayAt', 'eveningAt', 'sun')) then
      return 'The look by the time of day is a day look, an evening look, their times and the sunset tick box.';
    end if;
    if coalesce(w ->> 'day', '') not in ('house', 'chalkboard', 'light', 'dark') or coalesce(w ->> 'evening', '') not in ('house', 'chalkboard', 'light', 'dark')
       or jsonb_typeof(w -> 'day') <> 'string' or jsonb_typeof(w -> 'evening') <> 'string' then
      return 'The day and evening looks are House, Chalkboard, Light or Dark.';
    end if;
    if w ->> 'day' = w ->> 'evening' then return 'The day look and the evening look are different looks.'; end if;
    if jsonb_typeof(w -> 'dayAt') is distinct from 'string' or jsonb_typeof(w -> 'eveningAt') is distinct from 'string'
       or w ->> 'dayAt' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or w ->> 'eveningAt' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      return 'The day and evening times are times of day, like 06:00 and 17:00.';
    end if;
    if w ->> 'dayAt' = w ->> 'eveningAt' then return 'The day look and the evening look start at different times.'; end if;
    if w ? 'sun' and jsonb_typeof(w -> 'sun') <> 'boolean' then return 'Sunrise and sunset is ticked or not.'; end if;
  end if;
  if p_board ? 'chalk' then
    if jsonb_typeof(p_board -> 'chalk') <> 'object' then return 'The chalk colours are for titles, prices and accents.'; end if;
    for k, v in select * from jsonb_each(p_board -> 'chalk') loop
      if k not in ('titles', 'prices', 'accents') then return 'The chalk colours are for titles, prices and accents.'; end if;
      if jsonb_typeof(v) <> 'string' or v #>> '{}' not in ('white', 'yellow', 'pink', 'blue', 'green', 'orange') then
        return 'Each chalk colour is white, yellow, pink, blue, green or orange.';
      end if;
    end loop;
  end if;
  if p_board ? 'lettering' and coalesce(p_board ->> 'lettering', '') not in ('sign', 'hand') then return 'The lettering is Sign-writer or Chalk hand.'; end if;
  if p_board ? 'frame' and jsonb_typeof(p_board -> 'frame') <> 'boolean' then return 'The frame is on or off.'; end if;
  if p_board ? 'options' then
    if jsonb_typeof(p_board -> 'options') <> 'object' or (select count(*) from jsonb_object_keys(p_board -> 'options')) > 6 then return 'A board has up to 6 options.'; end if;
    for k, v in select * from jsonb_each(p_board -> 'options') loop
      if k !~ '^[a-z0-9][a-z0-9-]{0,39}$' or jsonb_typeof(v) <> 'boolean' then return 'Each option is ticked or not.'; end if;
    end loop;
  end if;
  return null;
end $$;
revoke all on function public.menu_board_problem(jsonb) from public, anon, authenticated;
