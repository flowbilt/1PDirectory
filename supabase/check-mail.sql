-- Confirms 19-mail.sql worked. Run after 19: SQL Editor -> New query -> paste -> Run. Every column should read true.
select
  exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'mail_settings')            as table_exists,
  (select relrowsecurity from pg_class where oid = 'public.mail_settings'::regclass)                                          as row_security_on,
  not has_table_privilege('authenticated', 'public.mail_settings', 'select')
    and not has_table_privilege('anon', 'public.mail_settings', 'select')                                                     as hidden_from_users,
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'mail_settings')                         as no_policies,
  (select count(*) from public.mail_settings) <= 1                                                                            as at_most_one_row,
  not exists (select 1 from public.mail_settings where password_enc not like 'v1:%')                                         as only_encrypted_passwords;
