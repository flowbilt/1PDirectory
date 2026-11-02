-- DP-13 round T1f: how a board draws its QR code. Run after 40-text-sizes.sql. Safe to run again.
--
-- Scot (2026-11-02), on the chalkboard's white square behind the code: "Inverting the code may be the way to go. We can
-- try it for layout purposes and test it later before launch." A board's sizes (39, 40) may now also say "qrcode":
-- "white" (the code on its white square, as before; every phone reads it) or "board" (the code drawn in the board's own
-- lettering colour straight on the board: light on a chalkboard, dark on a light board). Only 1Point sets it (39's
-- menu_write keeps a board's sizes on anyone else's save or Restore).

-- ─────────────────────────────────────────── the rules (40's menu_board_problem, one part more)
create or replace function public.menu_board_problem(p_board jsonb) returns text
language plpgsql immutable set search_path = public as $$
declare k text; v jsonb;
begin
  if jsonb_typeof(p_board) <> 'object' then return 'Each board''s look is { "look", "chalk", "lettering", "frame", "options" }.'; end if;
  if exists (select 1 from jsonb_object_keys(p_board) x where x not in ('look', 'chalk', 'lettering', 'frame', 'options', 'sizes')) then
    return 'A board''s look can say look, chalk, lettering, frame, options and sizes.';
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
      else return 'A board''s sizes are for the QR code, the logo, the headings and the body text.';
      end if;
    end loop;
  end if;
  if p_board ? 'look' and coalesce(p_board ->> 'look', '') not in ('house', 'chalkboard') then return 'The look is House or Chalkboard.'; end if;
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
