-- Lobby Directory: starting data, migrated from Yodeck and Wix.
-- Run once, after 01-schema.sql. Transcribed from screenshots: proofread in the editor afterwards.
begin;

insert into public.organizations (id, name, kind) values ('9b661b37-87f3-4194-9486-dbf0b825cbda', 'Barber Companies', 'manager');

-- The Landmark Center
insert into public.properties (id, org_id, name, address, lat, lon, footer, managed_by, leased_by) values ('91c1faf2-7e78-4aeb-9951-41d2c38590f9', '9b661b37-87f3-4194-9486-dbf0b825cbda', 'The Landmark Center', '2100 1st Avenue North, Birmingham', 33.5186, -86.8104, 'Welcome to The Landmark Center. Have a great day.', '{"name": "Leigh Ann Kornegay", "company": "Barber Companies", "phone": "205-995-9116"}'::jsonb, '{"name": "Weyman Prater", "company": "Barber Companies", "phone": "205-995-9119"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('09f4814f-a4b4-4fc5-802b-62c1cff09f9d', '91c1faf2-7e78-4aeb-9951-41d2c38590f9', 'landmark-center', 'The Landmark Center', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('09f4814f-a4b4-4fc5-802b-62c1cff09f9d', 0, 'EMW Law LLC.', '300', '', ''),
  ('09f4814f-a4b4-4fc5-802b-62c1cff09f9d', 10, 'Life Key', '251', '', ''),
  ('09f4814f-a4b4-4fc5-802b-62c1cff09f9d', 20, 'Martin Law Firm, LLC.', '220', '', ''),
  ('09f4814f-a4b4-4fc5-802b-62c1cff09f9d', 30, 'PRP Logistics', '410', '', ''),
  ('09f4814f-a4b4-4fc5-802b-62c1cff09f9d', 40, 'Red Mountain Law Group', '500', '', ''),
  ('09f4814f-a4b4-4fc5-802b-62c1cff09f9d', 50, 'Roy M. West d/b/a Manly & Manly, Attorney', '210', '', ''),
  ('09f4814f-a4b4-4fc5-802b-62c1cff09f9d', 60, 'The Alabama Messenger', '240', '', ''),
  ('09f4814f-a4b4-4fc5-802b-62c1cff09f9d', 70, 'Vogtle Howell Companies', '571', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('09f4814f-a4b4-4fc5-802b-62c1cff09f9d', 'landmark-center', 'The Landmark Center', 'portrait', '{}'::jsonb);

-- Perimeter Park One
insert into public.properties (id, org_id, name, address, lat, lon, footer, managed_by, leased_by) values ('313ca48b-0081-44da-81ae-d30652dc022f', '9b661b37-87f3-4194-9486-dbf0b825cbda', 'Perimeter Park One', '', 33.4663, -86.808, 'Barber Companies - For leasing information call 205-795-4732', '{}'::jsonb, '{}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('bf586648-750a-42bc-b6d1-460db8f6495b', '313ca48b-0081-44da-81ae-d30652dc022f', 'ppi-1s', 'Perimeter Park One - One South', 'South Tower');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('bf586648-750a-42bc-b6d1-460db8f6495b', 0, 'Veracity Wealth Management LLC', '123 S', 'left', ''),
  ('bf586648-750a-42bc-b6d1-460db8f6495b', 10, 'Common Bond Title, LLC', '130 S', 'left', 'A subsidiary of Affiliates Consolidated Services'),
  ('bf586648-750a-42bc-b6d1-460db8f6495b', 20, 'Perpetual Lifestyle Planning, LLC', '140 S', 'left', ''),
  ('bf586648-750a-42bc-b6d1-460db8f6495b', 30, 'Hyde Roofing', '145 S', 'left', ''),
  ('bf586648-750a-42bc-b6d1-460db8f6495b', 40, 'Fitness Room', '120 S', 'left', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('bf586648-750a-42bc-b6d1-460db8f6495b', 'ppi-1s', 'TBC - PPI - 1 S - NEW', 'landscape', '{"yodeck_id": "375320", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000005c3650c4", "ethernet_mac": "d8:3a:dd:f9:2d:f5", "ethernet_ip": "UNKNOWN", "wifi_mac": "d8:3a:dd:f9:2d:f6", "resolution": "3840x2160", "power_supply": "UNDER", "cpu_temp_c": "49.7", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('aae1f1da-6528-440c-afe7-73e9a07fcc47', '313ca48b-0081-44da-81ae-d30652dc022f', 'ppi-2s', 'Perimeter Park One - Two South', 'South Tower');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('aae1f1da-6528-440c-afe7-73e9a07fcc47', 0, 'Evan Terry Associates, LLC', '200 S', 'right', ''),
  ('aae1f1da-6528-440c-afe7-73e9a07fcc47', 10, 'MortgageRight', '230 S', 'left', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('aae1f1da-6528-440c-afe7-73e9a07fcc47', 'ppi-2s', 'TBC - PPI - 2 S - 194242', 'landscape', '{"yodeck_id": "194292", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000008294ba46", "ethernet_mac": "e4:5f:01:f0:c5:ae", "ethernet_ip": "192.168.44.70", "wifi_mac": "e4:5f:01:f0:c5:af", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "42.4", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('9e3fed46-4afe-4f7d-a58d-98ce62cc03ac', '313ca48b-0081-44da-81ae-d30652dc022f', 'ppi-3n', 'Perimeter Park One - Three North', 'North Tower');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('9e3fed46-4afe-4f7d-a58d-98ce62cc03ac', 0, 'Jacobs Engineering Group, Inc.', '315 N', 'right', ''),
  ('9e3fed46-4afe-4f7d-a58d-98ce62cc03ac', 10, 'Alliance Wealth Management Group, LLC', '318 N', 'right', ''),
  ('9e3fed46-4afe-4f7d-a58d-98ce62cc03ac', 20, 'American Financial Education Alliance', '318 N', 'right', ''),
  ('9e3fed46-4afe-4f7d-a58d-98ce62cc03ac', 30, 'Broom Financial Services, LLC', '325 N', 'left', ''),
  ('9e3fed46-4afe-4f7d-a58d-98ce62cc03ac', 40, 'MicroPulse Technologies', '330 N', 'left', ''),
  ('9e3fed46-4afe-4f7d-a58d-98ce62cc03ac', 50, 'First Command', '340 N', 'left', ''),
  ('9e3fed46-4afe-4f7d-a58d-98ce62cc03ac', 60, 'USI Insurance Services, LLC', '344 N', 'left', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('9e3fed46-4afe-4f7d-a58d-98ce62cc03ac', 'ppi-3n', 'TBC - PPI - 3 N - 194293', 'landscape', '{"yodeck_id": "194293", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "10000000335b04b3", "ethernet_mac": "e4:5f:01:f0:c6:50", "ethernet_ip": "192.168.44.16", "wifi_mac": "e4:5f:01:f0:c6:51", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "43.8", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('6963b73a-ca3f-4566-8a33-c2483f16c30b', '313ca48b-0081-44da-81ae-d30652dc022f', 'ppi-3s', 'Perimeter Park One - Three South', 'South Tower');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('6963b73a-ca3f-4566-8a33-c2483f16c30b', 0, 'Fairvoy Private Wealth, LLC', '300 S', 'right', ''),
  ('6963b73a-ca3f-4566-8a33-c2483f16c30b', 10, 'Conference Room', '310 S', 'left', ''),
  ('6963b73a-ca3f-4566-8a33-c2483f16c30b', 20, 'Gelch & Associates, P.A.', '312 S', 'right', ''),
  ('6963b73a-ca3f-4566-8a33-c2483f16c30b', 30, 'Naderpour & Associates, P.A.', '315 S', 'left', ''),
  ('6963b73a-ca3f-4566-8a33-c2483f16c30b', 40, 'Progress Residential Property Mgr, LLC', '320 S', 'left', ''),
  ('6963b73a-ca3f-4566-8a33-c2483f16c30b', 50, 'AFRY USA, LLC', '360 S', 'left', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('6963b73a-ca3f-4566-8a33-c2483f16c30b', 'ppi-3s', 'TBC - PPI - 3 S - 194294', 'landscape', '{"yodeck_id": "194294", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "10000000da6fdb50", "ethernet_mac": "e4:5f:01:f0:c5:ff", "ethernet_ip": "192.168.44.53", "wifi_mac": "e4:5f:01:f0:c6:00", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "40.9", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('2ce4ee8f-f2d9-4677-aa27-1bda0230e22c', '313ca48b-0081-44da-81ae-d30652dc022f', 'ppi-4n', 'Perimeter Park One - Four North', 'North Tower');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('2ce4ee8f-f2d9-4677-aa27-1bda0230e22c', 0, 'Spina & Lavelle, P.C.', '400 N', 'right', ''),
  ('2ce4ee8f-f2d9-4677-aa27-1bda0230e22c', 10, 'Waggoner Engineering, Inc.', '450 N', 'left', ''),
  ('2ce4ee8f-f2d9-4677-aa27-1bda0230e22c', 20, 'Insight Therapeutic Services', '486 N', 'left', ''),
  ('2ce4ee8f-f2d9-4677-aa27-1bda0230e22c', 30, 'Alabama Wellness & Aesthetics', '410 N', 'left', ''),
  ('2ce4ee8f-f2d9-4677-aa27-1bda0230e22c', 40, 'Alvis Law Firm, LLC', '475 N', 'left', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('2ce4ee8f-f2d9-4677-aa27-1bda0230e22c', 'ppi-4n', 'TBC - PPI - 4 N - 194295', 'landscape', '{"yodeck_id": "194295", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "1000000025b7d4d6", "ethernet_mac": "e4:5f:01:f0:c5:30", "ethernet_ip": "192.168.44.42", "wifi_mac": "e4:5f:01:f0:c5:31", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "43.3", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('bf4416aa-545d-4649-aa0e-264dda42e55d', '313ca48b-0081-44da-81ae-d30652dc022f', 'ppi-4s', 'Perimeter Park One - Four South', 'South Tower');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('bf4416aa-545d-4649-aa0e-264dda42e55d', 0, 'STONE Financial Group', '400 S', 'left', ''),
  ('bf4416aa-545d-4649-aa0e-264dda42e55d', 10, 'Project Consulting Services, Inc.', '425 S', 'left', ''),
  ('bf4416aa-545d-4649-aa0e-264dda42e55d', 20, 'Statewide Title Services, Inc.', '440 S', 'left', ''),
  ('bf4416aa-545d-4649-aa0e-264dda42e55d', 30, 'Roger King Fuston', '430 S', 'left', ''),
  ('bf4416aa-545d-4649-aa0e-264dda42e55d', 40, 'TTURNER & Associates, LLC', '465 S', 'left', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('bf4416aa-545d-4649-aa0e-264dda42e55d', 'ppi-4s', 'TBC - PPI - 4 S - 194296', 'landscape', '{"yodeck_id": "194296", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000005d2454ef", "ethernet_mac": "e4:5f:01:f0:c5:fc", "ethernet_ip": "192.168.44.50", "wifi_mac": "e4:5f:01:f0:c5:fd", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "42.8", "orientation": "landscape"}'::jsonb);

-- Perimeter Park Two
insert into public.properties (id, org_id, name, address, lat, lon, footer, managed_by, leased_by) values ('8eeacd63-8dcc-4cbe-9b83-de356a08aef6', '9b661b37-87f3-4194-9486-dbf0b825cbda', 'Perimeter Park Two', '', 33.4663, -86.808, 'Barber Companies - For leasing information call 205-795-4732', '{}'::jsonb, '{}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('ed7d0d25-d207-4ee4-bea1-630e04acf1b4', '8eeacd63-8dcc-4cbe-9b83-de356a08aef6', 'ppii-1e', 'PPII - 1 East', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('ed7d0d25-d207-4ee4-bea1-630e04acf1b4', 0, 'Colliers Valuation & Advisory', '130 E', '', ''),
  ('ed7d0d25-d207-4ee4-bea1-630e04acf1b4', 10, 'Assurance Scientific Laboratories', '172 E', '', ''),
  ('ed7d0d25-d207-4ee4-bea1-630e04acf1b4', 20, 'Fitness Room', '140 E', '', ''),
  ('ed7d0d25-d207-4ee4-bea1-630e04acf1b4', 30, 'Hickcox, Robertson & Stunda, LLC', '100 E', '', ''),
  ('ed7d0d25-d207-4ee4-bea1-630e04acf1b4', 40, 'Headwater Asset Management LLC', '140 E', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('ed7d0d25-d207-4ee4-bea1-630e04acf1b4', 'ppii-1e', 'PPII - 1-East', 'landscape', '{"yodeck_id": "197675", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "1000000023c89c7c", "ethernet_mac": "e4:5f:01:fd:88:b4", "ethernet_ip": "192.168.44.3", "wifi_mac": "e4:5f:01:fd:88:b5", "resolution": "1920x1080", "power_supply": "UNDER", "cpu_temp_c": "44.3", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('f08293da-6ee3-4828-b8ca-9bc22e7923f3', '8eeacd63-8dcc-4cbe-9b83-de356a08aef6', 'ppii-2e', 'PPII - 2 East', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('f08293da-6ee3-4828-b8ca-9bc22e7923f3', 0, 'IAT Insurance Group', '228 E', '', ''),
  ('f08293da-6ee3-4828-b8ca-9bc22e7923f3', 10, 'Summit Family Law P.C.', '230 E', '', ''),
  ('f08293da-6ee3-4828-b8ca-9bc22e7923f3', 20, 'Birmingham Capital Management', '235 E', '', ''),
  ('f08293da-6ee3-4828-b8ca-9bc22e7923f3', 30, 'ContinuumRX of Central Alabama', '250 E', '', ''),
  ('f08293da-6ee3-4828-b8ca-9bc22e7923f3', 40, 'ContinuumRX Services', '260 E', '', ''),
  ('f08293da-6ee3-4828-b8ca-9bc22e7923f3', 50, '76 FENCE Iron City', '229 E', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('f08293da-6ee3-4828-b8ca-9bc22e7923f3', 'ppii-2e', 'PPII - 2-East', 'landscape', '{"yodeck_id": "344518", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000006a459f35", "ethernet_mac": "2c:cf:67:01:cf:db", "ethernet_ip": "192.168.44.7", "wifi_mac": "2c:cf:67:01:cf:dd", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "44.8", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('98253b95-69f7-485d-bd9f-eef984b20b32', '8eeacd63-8dcc-4cbe-9b83-de356a08aef6', 'ppii-3e', 'PPII - 3 East', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('98253b95-69f7-485d-bd9f-eef984b20b32', 0, 'PharmaPoint', '300 E', '', ''),
  ('98253b95-69f7-485d-bd9f-eef984b20b32', 10, 'Prometheus Group, LLC', '305 E', '', ''),
  ('98253b95-69f7-485d-bd9f-eef984b20b32', 20, 'ContinuumRx Services', '370 E', '', ''),
  ('98253b95-69f7-485d-bd9f-eef984b20b32', 30, 'Conference Room', '318 E', '', ''),
  ('98253b95-69f7-485d-bd9f-eef984b20b32', 40, 'Law Offices of Stevan Goozee, P.C.', '364 E', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('98253b95-69f7-485d-bd9f-eef984b20b32', 'ppii-3e', 'PPII - 3-East', 'landscape', '{"yodeck_id": "344519", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000007d156a62", "ethernet_mac": "2c:cf:67:01:d2:b6", "ethernet_ip": "192.168.44.6", "wifi_mac": "2c:cf:67:01:d2:b7", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "43.8", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('4d8a80cd-2782-4d7a-9b80-850749b46c4c', '8eeacd63-8dcc-4cbe-9b83-de356a08aef6', 'ppii-4e', 'PPII - 4 East', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('4d8a80cd-2782-4d7a-9b80-850749b46c4c', 0, 'Iris Health', '404 E', '', ''),
  ('4d8a80cd-2782-4d7a-9b80-850749b46c4c', 10, 'Valmont Newmark, Inc.', '405 E', '', ''),
  ('4d8a80cd-2782-4d7a-9b80-850749b46c4c', 20, 'King Forstman Law LLC', '410 E', '', ''),
  ('4d8a80cd-2782-4d7a-9b80-850749b46c4c', 30, 'Forstman & Cutchen LLP', '410 E', '', ''),
  ('4d8a80cd-2782-4d7a-9b80-850749b46c4c', 40, 'Summit Family Law', '423 E', '', ''),
  ('4d8a80cd-2782-4d7a-9b80-850749b46c4c', 50, 'Walker360/Seek Publishing', '425 E', '', ''),
  ('4d8a80cd-2782-4d7a-9b80-850749b46c4c', 60, 'Stillwell Counseling Group', '435 E', '', ''),
  ('4d8a80cd-2782-4d7a-9b80-850749b46c4c', 70, 'Smart Source, LLC', '440 E', '', ''),
  ('4d8a80cd-2782-4d7a-9b80-850749b46c4c', 80, 'Webster, Henry, Lyons, Bradwell, Cohen & Speagle, P.C.', '445 E', '', ''),
  ('4d8a80cd-2782-4d7a-9b80-850749b46c4c', 90, 'Prime Senior Placement & Your Choice Senior Care', '460 E', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('4d8a80cd-2782-4d7a-9b80-850749b46c4c', 'ppii-4e', 'PPII - 4-East', 'landscape', '{"yodeck_id": "344521", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000001dff1cf6", "ethernet_mac": "2c:cf:67:01:d0:61", "ethernet_ip": "192.168.44.10", "wifi_mac": "2c:cf:67:01:d0:62", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "42.8", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('ef0afd02-5a99-4540-ac2f-ba7dd80cb099', '8eeacd63-8dcc-4cbe-9b83-de356a08aef6', 'ppii-5e', 'PPII - 5 East', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('ef0afd02-5a99-4540-ac2f-ba7dd80cb099', 0, 'Sain Associates', '500 E', '', ''),
  ('ef0afd02-5a99-4540-ac2f-ba7dd80cb099', 10, 'Drake Law Firm', '510 E', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('ef0afd02-5a99-4540-ac2f-ba7dd80cb099', 'ppii-5e', 'PPII - 5-East', 'landscape', '{"yodeck_id": "344520", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000000cb94421", "ethernet_mac": "d8:3a:dd:fe:23:87", "ethernet_ip": "192.168.44.5", "wifi_mac": "d8:3a:dd:fe:23:8b", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "42.8", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('2dfedfc7-46f5-45c3-8eb3-6723b0600de4', '8eeacd63-8dcc-4cbe-9b83-de356a08aef6', 'ppii-3w', 'PPII - 3 West', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('2dfedfc7-46f5-45c3-8eb3-6723b0600de4', 0, 'Norluxe Realty Birmingham', '305 W', '', ''),
  ('2dfedfc7-46f5-45c3-8eb3-6723b0600de4', 10, 'Prometheus Group', '312 W', '', ''),
  ('2dfedfc7-46f5-45c3-8eb3-6723b0600de4', 20, 'Organogenesis, Inc.', '320 W', '', ''),
  ('2dfedfc7-46f5-45c3-8eb3-6723b0600de4', 30, 'Hair Club', '350 W', '', ''),
  ('2dfedfc7-46f5-45c3-8eb3-6723b0600de4', 40, 'Willcam, Inc', '335 W', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('2dfedfc7-46f5-45c3-8eb3-6723b0600de4', 'ppii-3w', 'PPII - 3-West', 'landscape', '{"yodeck_id": "344524", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "10000000eb1199eb", "ethernet_mac": "d8:3a:dd:fe:2a:d1", "ethernet_ip": "192.168.44.9", "wifi_mac": "d8:3a:dd:fe:2a:d2", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "43.3", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('4c57ed3e-66c6-45f9-a2fc-ba6d5bea2a2d', '8eeacd63-8dcc-4cbe-9b83-de356a08aef6', 'ppii-4w', 'PPII - 4 West', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('4c57ed3e-66c6-45f9-a2fc-ba6d5bea2a2d', 0, 'Neel-Schaffer, Inc.', '400 W', '', ''),
  ('4c57ed3e-66c6-45f9-a2fc-ba6d5bea2a2d', 10, 'Alvarez & Marsal Holdings, LLC', '430 W', '', ''),
  ('4c57ed3e-66c6-45f9-a2fc-ba6d5bea2a2d', 20, 'Harmon-Dennis-Bradshaw, Inc.', '450 W', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('4c57ed3e-66c6-45f9-a2fc-ba6d5bea2a2d', 'ppii-4w', 'PPII - 4-West', 'landscape', '{"yodeck_id": "372930", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "10000000dafecaaa", "ethernet_mac": "d8:3a:dd:fd:d7:f6", "ethernet_ip": "192.168.44.8", "wifi_mac": "d8:3a:dd:fd:d7:f9", "resolution": "1920x1080", "power_supply": "UNDER", "cpu_temp_c": "44.3", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('f7f2800c-6a9c-45f0-928e-9d26ec7f2453', '8eeacd63-8dcc-4cbe-9b83-de356a08aef6', 'ppii-5w', 'PPII - 5 West', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('f7f2800c-6a9c-45f0-928e-9d26ec7f2453', 0, 'StoneX Wealth Management', '500 W', '', ''),
  ('f7f2800c-6a9c-45f0-928e-9d26ec7f2453', 10, 'Anistar Technologies', '575 W', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('f7f2800c-6a9c-45f0-928e-9d26ec7f2453', 'ppii-5w', 'PPII - 5-West', 'landscape', '{"yodeck_id": "344522", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000009ebd5abe", "ethernet_mac": "2c:cf:67:01:d3:2b", "ethernet_ip": "192.168.44.4", "wifi_mac": "2c:cf:67:01:d3:2c", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "42.8", "orientation": "landscape"}'::jsonb);

insert into public.organizations (id, name, kind) values ('a93e73e1-6fcf-467a-a175-461e64a3fafd', 'Cadence Place (owner to confirm)', 'owner');

-- Cadence Place
insert into public.properties (id, org_id, name, address, lat, lon, footer, managed_by, leased_by) values ('cdc22c83-3420-4310-b1c5-04e2cb1c6f95', 'a93e73e1-6fcf-467a-a175-461e64a3fafd', 'Cadence Place', '', 33.5186, -86.8104, '', '{}'::jsonb, '{}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('e85e8e5e-901a-4c42-b5b6-3c7765120c5d', 'cdc22c83-3420-4310-b1c5-04e2cb1c6f95', 'cadence-place', 'Welcome', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('e85e8e5e-901a-4c42-b5b6-3c7765120c5d', 0, 'Butler & Company Architects, LLC', '202', '', ''),
  ('e85e8e5e-901a-4c42-b5b6-3c7765120c5d', 10, 'Acrisure Mortgage, LLC', '204', '', ''),
  ('e85e8e5e-901a-4c42-b5b6-3c7765120c5d', 20, 'Advo(K)ate Advisors, LLC', '206', '', ''),
  ('e85e8e5e-901a-4c42-b5b6-3c7765120c5d', 30, 'Office Suites', '208', '', ''),
  ('e85e8e5e-901a-4c42-b5b6-3c7765120c5d', 40, 'Reliance Partners, LLC', '208E', '', ''),
  ('e85e8e5e-901a-4c42-b5b6-3c7765120c5d', 50, 'Dyer Orthodontics, LLC', '210', '', ''),
  ('e85e8e5e-901a-4c42-b5b6-3c7765120c5d', 60, 'American Fidelity Insurance', '212', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('e85e8e5e-901a-4c42-b5b6-3c7765120c5d', 'cadence-place', 'Cadence Place', 'portrait', '{"yodeck_id": "561904", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "10000000a4ae272d", "ethernet_mac": "2c:cf:67:55:70:5f", "ethernet_ip": "192.168.0.245", "wifi_mac": "2c:cf:67:55:70:61", "resolution": "1080x1920", "power_supply": "OK", "cpu_temp_c": "38", "orientation": "portrait"}'::jsonb);

commit;

-- Make yourself the first 1Point admin. First create your login under Authentication -> Users -> Add user,
-- then change the email below to match and run just this statement:
-- insert into public.profiles (user_id, email, full_name, role)
--   select id, email, 'Scot', 'platform_admin' from auth.users where email = 'you@1pointusa.com';
