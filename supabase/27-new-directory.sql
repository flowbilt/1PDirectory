-- Lobby Directory: adding a directory works again (DP-09 round 14c).
-- Run in Supabase: SQL Editor -> New query -> paste -> Run. No code upload goes with it. Safe to run more than once.
-- Then run check-new-directory.sql; it should end with ALL 5 CHECKS PASSED (red on purpose).
--
-- The bug (from 24-directory-to-go.sql, DP-08 round 12): every directory's Directory to Go code came from a column
-- default that calls togo_new_code_value(), and signed-in users may not run that function. A default runs with the
-- rights of whoever adds the row, so the console's Add directory, used by 1Point admins, failed with "You don't have
-- permission to make that change." 24's own check added its test directory from the SQL Editor, which may run the
-- function, so it didn't show. (Found by Scot, 2026-10-23, adding a test directory to WayTuGo Towers.)
--
-- The fix: no default; a trigger gives a new directory its code instead, running with the database's own rights
-- (security definer), so the code maker stays private. Nothing else changes: existing codes stay as they are, only
-- 1Point can add directories (as before), and only 1Point can set a code by hand (24's guard on updates).

alter table public.directories alter column togo_code drop default;

create or replace function public.directories_togo_new() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.togo_code is null then
    new.togo_code := public.togo_new_code_value();
  end if;
  return new;
end $$;
revoke all on function public.directories_togo_new() from public, anon, authenticated;

drop trigger if exists directories_togo_new on public.directories;
create trigger directories_togo_new before insert on public.directories for each row execute function public.directories_togo_new();

notify pgrst, 'reload schema';
