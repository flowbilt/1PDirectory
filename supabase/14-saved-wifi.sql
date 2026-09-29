-- Lobby Directory: Wi-Fi saved from the technician page (DP-03 round 3).
-- Run in Supabase BEFORE uploading the round 3 code: SQL Editor -> New query -> paste -> Run.
-- (Only the new code saves networks from the field, so until it's live every network still goes on cards, as now.)
-- Safe to run more than once.
--
-- The saved Wi-Fi list now holds two kinds of network:
--   on_cards = true   added in the console (Pi setup): carried by every card prepared from now on, as before
--   on_cards = false  saved from the technician page after a Pi joined it: offered there to other Pis with one tap,
--                     but never put on a card, so a lost card doesn't carry every building's password
-- The console can move a network from one kind to the other (Pi setup -> Edit -> Put on newly prepared cards).

alter table public.wifi_networks add column if not exists on_cards boolean not null default true;

notify pgrst, 'reload schema';
