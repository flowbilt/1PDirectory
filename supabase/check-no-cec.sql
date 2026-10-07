-- Confirms 21-no-cec.sql worked. Run after 21: SQL Editor -> New query -> paste -> Run. Every column should read true.
select
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'screens' and column_name = 'no_cec'
          and data_type = 'boolean' and is_nullable = 'NO')                                                     as column_present,
  not exists (select 1 from public.screens where no_cec)                                                        as every_screen_checked_as_before,
  has_column_privilege('authenticated', 'public.screens', 'no_cec', 'select')                                    as signed_in_users_can_read_it,
  not has_column_privilege('authenticated', 'public.screens', 'hardware', 'select')                              as hardware_still_hidden;
