-- Lobby Directory: starting data, migrated from Yodeck and Wix.
-- Run once, after 01-schema.sql. Transcribed from screenshots: proofread in the editor afterwards.
begin;

insert into public.organizations (id, name, kind) values ('835c37be-d7f5-4932-a7e8-514bd39ef443', 'Barber Companies', 'manager');

-- The Landmark Center
insert into public.properties (id, org_id, name, address, lat, lon, footer, managed_by, leased_by) values ('6bf447ef-3120-4294-afde-c99b5ae8c308', '835c37be-d7f5-4932-a7e8-514bd39ef443', 'The Landmark Center', '2100 1st Avenue North, Birmingham', 33.5186, -86.8104, 'Welcome to The Landmark Center. Have a great day.', '{"name": "Leigh Ann Kornegay", "company": "Barber Companies", "phone": "205-995-9116"}'::jsonb, '{"name": "Weyman Prater", "company": "Barber Companies", "phone": "205-995-9119"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('dad08450-70f0-49fa-8c8b-90042e4509eb', '6bf447ef-3120-4294-afde-c99b5ae8c308', 'landmark-center', 'The Landmark Center', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('dad08450-70f0-49fa-8c8b-90042e4509eb', 0, 'EMW Law LLC.', '300', '', ''),
  ('dad08450-70f0-49fa-8c8b-90042e4509eb', 10, 'Life Key', '251', '', ''),
  ('dad08450-70f0-49fa-8c8b-90042e4509eb', 20, 'Martin Law Firm, LLC.', '220', '', ''),
  ('dad08450-70f0-49fa-8c8b-90042e4509eb', 30, 'PRP Logistics', '410', '', ''),
  ('dad08450-70f0-49fa-8c8b-90042e4509eb', 40, 'Red Mountain Law Group', '500', '', ''),
  ('dad08450-70f0-49fa-8c8b-90042e4509eb', 50, 'Roy M. West d/b/a Manly & Manly, Attorney', '210', '', ''),
  ('dad08450-70f0-49fa-8c8b-90042e4509eb', 60, 'The Alabama Messenger', '240', '', ''),
  ('dad08450-70f0-49fa-8c8b-90042e4509eb', 70, 'Vogtle Howell Companies', '571', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('dad08450-70f0-49fa-8c8b-90042e4509eb', 'landmark-center', 'The Landmark Center', 'portrait', '{}'::jsonb);

-- Perimeter Park One
insert into public.properties (id, org_id, name, address, lat, lon, footer, managed_by, leased_by) values ('fdae532d-e2ce-4036-abb7-86e5aab72e7c', '835c37be-d7f5-4932-a7e8-514bd39ef443', 'Perimeter Park One', '', 33.4663, -86.808, 'Barber Companies - For leasing information call 205-795-4732', '{}'::jsonb, '{}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('d8b72c48-53e9-4232-930e-2c6012c55e21', 'fdae532d-e2ce-4036-abb7-86e5aab72e7c', 'ppi-1s', 'Perimeter Park One - One South', 'South Tower');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('d8b72c48-53e9-4232-930e-2c6012c55e21', 0, 'Veracity Wealth Management LLC', '123 S', 'left', ''),
  ('d8b72c48-53e9-4232-930e-2c6012c55e21', 10, 'Common Bond Title, LLC', '130 S', 'left', 'A subsidiary of Affiliates Consolidated Services'),
  ('d8b72c48-53e9-4232-930e-2c6012c55e21', 20, 'Perpetual Lifestyle Planning, LLC', '140 S', 'left', ''),
  ('d8b72c48-53e9-4232-930e-2c6012c55e21', 30, 'Hyde Roofing', '145 S', 'left', ''),
  ('d8b72c48-53e9-4232-930e-2c6012c55e21', 40, 'Fitness Room', '120 S', 'left', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('d8b72c48-53e9-4232-930e-2c6012c55e21', 'ppi-1s', 'TBC - PPI - 1 S - NEW', 'landscape', '{"yodeck_id": "375320", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000005c3650c4", "ethernet_mac": "d8:3a:dd:f9:2d:f5", "ethernet_ip": "UNKNOWN", "wifi_mac": "d8:3a:dd:f9:2d:f6", "resolution": "3840x2160", "power_supply": "UNDER", "cpu_temp_c": "49.7", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('943d2aab-818b-491e-8404-780c02c21944', 'fdae532d-e2ce-4036-abb7-86e5aab72e7c', 'ppi-2s', 'Perimeter Park One - Two South', 'South Tower');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('943d2aab-818b-491e-8404-780c02c21944', 0, 'Evan Terry Associates, LLC', '200 S', 'right', ''),
  ('943d2aab-818b-491e-8404-780c02c21944', 10, 'MortgageRight', '230 S', 'left', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('943d2aab-818b-491e-8404-780c02c21944', 'ppi-2s', 'TBC - PPI - 2 S - 194292', 'landscape', '{"yodeck_id": "194292", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000008294ba46", "ethernet_mac": "e4:5f:01:f0:c5:ae", "ethernet_ip": "192.168.44.70", "wifi_mac": "e4:5f:01:f0:c5:af", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "42.4", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('2361cba9-0d3c-4ed7-901d-239c822dc870', 'fdae532d-e2ce-4036-abb7-86e5aab72e7c', 'ppi-3n', 'Perimeter Park One - Three North', 'North Tower');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('2361cba9-0d3c-4ed7-901d-239c822dc870', 0, 'Jacobs Engineering Group, Inc.', '315 N', 'right', ''),
  ('2361cba9-0d3c-4ed7-901d-239c822dc870', 10, 'Alliance Wealth Management Group, LLC', '318 N', 'right', ''),
  ('2361cba9-0d3c-4ed7-901d-239c822dc870', 20, 'American Financial Education Alliance', '318 N', 'right', ''),
  ('2361cba9-0d3c-4ed7-901d-239c822dc870', 30, 'Broom Financial Services, LLC', '325 N', 'left', ''),
  ('2361cba9-0d3c-4ed7-901d-239c822dc870', 40, 'MicroPulse Technologies', '330 N', 'left', ''),
  ('2361cba9-0d3c-4ed7-901d-239c822dc870', 50, 'First Command', '340 N', 'left', ''),
  ('2361cba9-0d3c-4ed7-901d-239c822dc870', 60, 'USI Insurance Services, LLC', '344 N', 'left', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('2361cba9-0d3c-4ed7-901d-239c822dc870', 'ppi-3n', 'TBC - PPI - 3 N - 194293', 'landscape', '{"yodeck_id": "194293", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "10000000335b04b3", "ethernet_mac": "e4:5f:01:f0:c6:50", "ethernet_ip": "192.168.44.16", "wifi_mac": "e4:5f:01:f0:c6:51", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "43.8", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('59de0364-44a4-4210-b3f2-27f5127182dc', 'fdae532d-e2ce-4036-abb7-86e5aab72e7c', 'ppi-3s', 'Perimeter Park One - Three South', 'South Tower');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('59de0364-44a4-4210-b3f2-27f5127182dc', 0, 'Fairvoy Private Wealth, LLC', '300 S', 'right', ''),
  ('59de0364-44a4-4210-b3f2-27f5127182dc', 10, 'Conference Room', '310 S', 'left', ''),
  ('59de0364-44a4-4210-b3f2-27f5127182dc', 20, 'Gelch & Associates, P.A.', '312 S', 'right', ''),
  ('59de0364-44a4-4210-b3f2-27f5127182dc', 30, 'Naderpour & Associates, P.A.', '315 S', 'left', ''),
  ('59de0364-44a4-4210-b3f2-27f5127182dc', 40, 'Progress Residential Property Mgr, LLC', '320 S', 'left', ''),
  ('59de0364-44a4-4210-b3f2-27f5127182dc', 50, 'AFRY USA, LLC', '360 S', 'left', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('59de0364-44a4-4210-b3f2-27f5127182dc', 'ppi-3s', 'TBC - PPI - 3 S - 194294', 'landscape', '{"yodeck_id": "194294", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "10000000da6fdb50", "ethernet_mac": "e4:5f:01:f0:c5:ff", "ethernet_ip": "192.168.44.53", "wifi_mac": "e4:5f:01:f0:c6:00", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "40.9", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('0b3d1546-7a2f-4fd6-8cb9-ac35e372516e', 'fdae532d-e2ce-4036-abb7-86e5aab72e7c', 'ppi-4n', 'Perimeter Park One - Four North', 'North Tower');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('0b3d1546-7a2f-4fd6-8cb9-ac35e372516e', 0, 'Spina & Lavelle, P.C.', '400 N', 'right', ''),
  ('0b3d1546-7a2f-4fd6-8cb9-ac35e372516e', 10, 'Waggoner Engineering, Inc.', '450 N', 'left', ''),
  ('0b3d1546-7a2f-4fd6-8cb9-ac35e372516e', 20, 'Insight Therapeutic Services', '486 N', 'left', ''),
  ('0b3d1546-7a2f-4fd6-8cb9-ac35e372516e', 30, 'Alabama Wellness & Aesthetics', '410 N', 'left', ''),
  ('0b3d1546-7a2f-4fd6-8cb9-ac35e372516e', 40, 'Alvis Law Firm, LLC', '475 N', 'left', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('0b3d1546-7a2f-4fd6-8cb9-ac35e372516e', 'ppi-4n', 'TBC - PPI - 4 N - 194295', 'landscape', '{"yodeck_id": "194295", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "1000000025b7d4d6", "ethernet_mac": "e4:5f:01:f0:c5:30", "ethernet_ip": "192.168.44.42", "wifi_mac": "e4:5f:01:f0:c5:31", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "43.3", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('96a307cc-db4f-4d18-9a2d-c3b787d721a7', 'fdae532d-e2ce-4036-abb7-86e5aab72e7c', 'ppi-4s', 'Perimeter Park One - Four South', 'South Tower');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('96a307cc-db4f-4d18-9a2d-c3b787d721a7', 0, 'STONE Financial Group', '400 S', 'left', ''),
  ('96a307cc-db4f-4d18-9a2d-c3b787d721a7', 10, 'Project Consulting Services, Inc.', '425 S', 'left', ''),
  ('96a307cc-db4f-4d18-9a2d-c3b787d721a7', 20, 'Statewide Title Services, Inc.', '440 S', 'left', ''),
  ('96a307cc-db4f-4d18-9a2d-c3b787d721a7', 30, 'Roger King Fuston', '430 S', 'left', ''),
  ('96a307cc-db4f-4d18-9a2d-c3b787d721a7', 40, 'TTURNER & Associates, LLC', '465 S', 'left', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('96a307cc-db4f-4d18-9a2d-c3b787d721a7', 'ppi-4s', 'TBC - PPI - 4 S - 194296', 'landscape', '{"yodeck_id": "194296", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000005d2454ef", "ethernet_mac": "e4:5f:01:f0:c5:fc", "ethernet_ip": "192.168.44.50", "wifi_mac": "e4:5f:01:f0:c5:fd", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "42.8", "orientation": "landscape"}'::jsonb);

-- Perimeter Park Two
insert into public.properties (id, org_id, name, address, lat, lon, footer, managed_by, leased_by) values ('aeed9367-30e0-4e8f-89af-59cece50be45', '835c37be-d7f5-4932-a7e8-514bd39ef443', 'Perimeter Park Two', '', 33.4663, -86.808, 'Barber Companies - For leasing information call 205-795-4732', '{}'::jsonb, '{}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('8f7ef2cd-b3fc-4804-8eb7-b48e015ea3f9', 'aeed9367-30e0-4e8f-89af-59cece50be45', 'ppii-1e', 'PPII - 1 East', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('8f7ef2cd-b3fc-4804-8eb7-b48e015ea3f9', 0, 'Colliers Valuation & Advisory', '130 E', '', ''),
  ('8f7ef2cd-b3fc-4804-8eb7-b48e015ea3f9', 10, 'Assurance Scientific Laboratories', '172 E', '', ''),
  ('8f7ef2cd-b3fc-4804-8eb7-b48e015ea3f9', 20, 'Fitness Room', '140 E', '', ''),
  ('8f7ef2cd-b3fc-4804-8eb7-b48e015ea3f9', 30, 'Hickcox, Robertson & Stunda, LLC', '100 E', '', ''),
  ('8f7ef2cd-b3fc-4804-8eb7-b48e015ea3f9', 40, 'Headwater Asset Management LLC', '140 E', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('8f7ef2cd-b3fc-4804-8eb7-b48e015ea3f9', 'ppii-1e', 'PPII - 1-East', 'landscape', '{"yodeck_id": "197675", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "1000000023c89c7c", "ethernet_mac": "e4:5f:01:fd:88:b4", "ethernet_ip": "192.168.44.3", "wifi_mac": "e4:5f:01:fd:88:b5", "resolution": "1920x1080", "power_supply": "UNDER", "cpu_temp_c": "44.3", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('4f387883-0411-4658-8b85-3a3d58274b8b', 'aeed9367-30e0-4e8f-89af-59cece50be45', 'ppii-2e', 'PPII - 2 East', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('4f387883-0411-4658-8b85-3a3d58274b8b', 0, 'IAT Insurance Group', '228 E', '', ''),
  ('4f387883-0411-4658-8b85-3a3d58274b8b', 10, 'Summit Family Law P.C.', '230 E', '', ''),
  ('4f387883-0411-4658-8b85-3a3d58274b8b', 20, 'Birmingham Capital Management', '235 E', '', ''),
  ('4f387883-0411-4658-8b85-3a3d58274b8b', 30, 'ContinuumRX of Central Alabama', '250 E', '', ''),
  ('4f387883-0411-4658-8b85-3a3d58274b8b', 40, 'ContinuumRX Services', '260 E', '', ''),
  ('4f387883-0411-4658-8b85-3a3d58274b8b', 50, '76 FENCE Iron City', '229 E', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('4f387883-0411-4658-8b85-3a3d58274b8b', 'ppii-2e', 'PPII - 2-East', 'landscape', '{"yodeck_id": "344518", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000006a459f35", "ethernet_mac": "2c:cf:67:01:cf:db", "ethernet_ip": "192.168.44.7", "wifi_mac": "2c:cf:67:01:cf:dd", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "44.8", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('d1a2ae6e-39a3-429a-81a2-acfb5d6797ab', 'aeed9367-30e0-4e8f-89af-59cece50be45', 'ppii-3e', 'PPII - 3 East', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('d1a2ae6e-39a3-429a-81a2-acfb5d6797ab', 0, 'PharmaPoint', '300 E', '', ''),
  ('d1a2ae6e-39a3-429a-81a2-acfb5d6797ab', 10, 'Prometheus Group, LLC', '305 E', '', ''),
  ('d1a2ae6e-39a3-429a-81a2-acfb5d6797ab', 20, 'ContinuumRx Services', '370 E', '', ''),
  ('d1a2ae6e-39a3-429a-81a2-acfb5d6797ab', 30, 'Conference Room', '318 E', '', ''),
  ('d1a2ae6e-39a3-429a-81a2-acfb5d6797ab', 40, 'Law Offices of Stevan Goozee, P.C.', '364 E', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('d1a2ae6e-39a3-429a-81a2-acfb5d6797ab', 'ppii-3e', 'PPII - 3-East', 'landscape', '{"yodeck_id": "344519", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000007d156a62", "ethernet_mac": "2c:cf:67:01:d2:b6", "ethernet_ip": "192.168.44.6", "wifi_mac": "2c:cf:67:01:d2:b7", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "43.8", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('12e51249-217f-4b64-b81a-26331612f481', 'aeed9367-30e0-4e8f-89af-59cece50be45', 'ppii-4e', 'PPII - 4 East', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('12e51249-217f-4b64-b81a-26331612f481', 0, 'Iris Health', '404 E', '', ''),
  ('12e51249-217f-4b64-b81a-26331612f481', 10, 'Valmont Newmark, Inc.', '405 E', '', ''),
  ('12e51249-217f-4b64-b81a-26331612f481', 20, 'King Forstman Law LLC', '410 E', '', ''),
  ('12e51249-217f-4b64-b81a-26331612f481', 30, 'Forstman & Cutchen LLP', '410 E', '', ''),
  ('12e51249-217f-4b64-b81a-26331612f481', 40, 'Summit Family Law', '423 E', '', ''),
  ('12e51249-217f-4b64-b81a-26331612f481', 50, 'Walker360/Seek Publishing', '425 E', '', ''),
  ('12e51249-217f-4b64-b81a-26331612f481', 60, 'Stillwell Counseling Group', '435 E', '', ''),
  ('12e51249-217f-4b64-b81a-26331612f481', 70, 'Smart Source, LLC', '440 E', '', ''),
  ('12e51249-217f-4b64-b81a-26331612f481', 80, 'Webster, Henry, Lyons, Bradwell, Cohen & Speagle, P.C.', '445 E', '', ''),
  ('12e51249-217f-4b64-b81a-26331612f481', 90, 'Prime Senior Placement & Your Choice Senior Care', '460 E', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('12e51249-217f-4b64-b81a-26331612f481', 'ppii-4e', 'PPII - 4-East', 'landscape', '{"yodeck_id": "344521", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000001dff1cf6", "ethernet_mac": "2c:cf:67:01:d0:61", "ethernet_ip": "192.168.44.10", "wifi_mac": "2c:cf:67:01:d0:62", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "42.8", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('3d79fc87-84f0-4cba-a2d0-4a145ec85e90', 'aeed9367-30e0-4e8f-89af-59cece50be45', 'ppii-5e', 'PPII - 5 East', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('3d79fc87-84f0-4cba-a2d0-4a145ec85e90', 0, 'Sain Associates', '500 E', '', ''),
  ('3d79fc87-84f0-4cba-a2d0-4a145ec85e90', 10, 'Drake Law Firm', '510 E', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('3d79fc87-84f0-4cba-a2d0-4a145ec85e90', 'ppii-5e', 'PPII - 5-East', 'landscape', '{"yodeck_id": "344520", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000000cb94421", "ethernet_mac": "d8:3a:dd:fe:23:87", "ethernet_ip": "192.168.44.5", "wifi_mac": "d8:3a:dd:fe:23:8b", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "42.8", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('65a6e569-42ed-4867-9d8b-90318f5cfc11', 'aeed9367-30e0-4e8f-89af-59cece50be45', 'ppii-3w', 'PPII - 3 West', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('65a6e569-42ed-4867-9d8b-90318f5cfc11', 0, 'Norluxe Realty Birmingham', '305 W', '', ''),
  ('65a6e569-42ed-4867-9d8b-90318f5cfc11', 10, 'Prometheus Group', '312 W', '', ''),
  ('65a6e569-42ed-4867-9d8b-90318f5cfc11', 20, 'Organogenesis, Inc.', '320 W', '', ''),
  ('65a6e569-42ed-4867-9d8b-90318f5cfc11', 30, 'Hair Club', '350 W', '', ''),
  ('65a6e569-42ed-4867-9d8b-90318f5cfc11', 40, 'Willcam, Inc', '335 W', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('65a6e569-42ed-4867-9d8b-90318f5cfc11', 'ppii-3w', 'PPII - 3-West', 'landscape', '{"yodeck_id": "344524", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "10000000eb1199eb", "ethernet_mac": "d8:3a:dd:fe:2a:d1", "ethernet_ip": "192.168.44.9", "wifi_mac": "d8:3a:dd:fe:2a:d2", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "43.3", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('3d1f3d68-8508-41dc-bd50-2563ee7adadb', 'aeed9367-30e0-4e8f-89af-59cece50be45', 'ppii-4w', 'PPII - 4 West', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('3d1f3d68-8508-41dc-bd50-2563ee7adadb', 0, 'Neel-Schaffer, Inc.', '400 W', '', ''),
  ('3d1f3d68-8508-41dc-bd50-2563ee7adadb', 10, 'Alvarez & Marsal Holdings, LLC', '430 W', '', ''),
  ('3d1f3d68-8508-41dc-bd50-2563ee7adadb', 20, 'Harmon-Dennis-Bradshaw, Inc.', '450 W', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('3d1f3d68-8508-41dc-bd50-2563ee7adadb', 'ppii-4w', 'PPII - 4-West', 'landscape', '{"yodeck_id": "372930", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "10000000dafecaaa", "ethernet_mac": "d8:3a:dd:fd:d7:f6", "ethernet_ip": "192.168.44.8", "wifi_mac": "d8:3a:dd:fd:d7:f9", "resolution": "1920x1080", "power_supply": "UNDER", "cpu_temp_c": "44.3", "orientation": "landscape"}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('aeab5642-e80e-47c5-b2dc-653aee50497f', 'aeed9367-30e0-4e8f-89af-59cece50be45', 'ppii-5w', 'PPII - 5 West', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('aeab5642-e80e-47c5-b2dc-653aee50497f', 0, 'StoneX Wealth Management', '500 W', '', ''),
  ('aeab5642-e80e-47c5-b2dc-653aee50497f', 10, 'Anistar Technologies', '575 W', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('aeab5642-e80e-47c5-b2dc-653aee50497f', 'ppii-5w', 'PPII - 5-West', 'landscape', '{"yodeck_id": "344522", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "100000009ebd5abe", "ethernet_mac": "2c:cf:67:01:d3:2b", "ethernet_ip": "192.168.44.4", "wifi_mac": "2c:cf:67:01:d3:2c", "resolution": "1920x1080", "power_supply": "OK", "cpu_temp_c": "42.8", "orientation": "landscape"}'::jsonb);

-- Cadence Place
insert into public.properties (id, org_id, name, address, lat, lon, footer, managed_by, leased_by) values ('098f351a-1ab3-4756-a9db-ce1c1af902f4', '835c37be-d7f5-4932-a7e8-514bd39ef443', 'Cadence Place', '', 33.5186, -86.8104, '', '{}'::jsonb, '{}'::jsonb);
insert into public.directories (id, property_id, slug, title, subtitle) values ('e18e6295-b070-40d8-8340-9e2ee709f575', '098f351a-1ab3-4756-a9db-ce1c1af902f4', 'cadence-place', 'Welcome', '');
insert into public.tenants (directory_id, sort, name, suite, arrow, note) values
  ('e18e6295-b070-40d8-8340-9e2ee709f575', 0, 'Butler & Company Architects, LLC', '202', '', ''),
  ('e18e6295-b070-40d8-8340-9e2ee709f575', 10, 'Acrisure Mortgage, LLC', '204', '', ''),
  ('e18e6295-b070-40d8-8340-9e2ee709f575', 20, 'Advo(K)ate Advisors, LLC', '206', '', ''),
  ('e18e6295-b070-40d8-8340-9e2ee709f575', 30, 'Office Suites', '208', '', ''),
  ('e18e6295-b070-40d8-8340-9e2ee709f575', 40, 'Reliance Partners, LLC', '208E', '', ''),
  ('e18e6295-b070-40d8-8340-9e2ee709f575', 50, 'Dyer Orthodontics, LLC', '210', '', ''),
  ('e18e6295-b070-40d8-8340-9e2ee709f575', 60, 'American Fidelity Insurance', '212', '', '');
insert into public.screens (directory_id, key, name, orientation, hardware) values ('e18e6295-b070-40d8-8340-9e2ee709f575', 'cadence-place', 'Cadence Place', 'portrait', '{"yodeck_id": "561904", "model": "Raspberry Pi 4 Model B Rev 1.5", "serial": "10000000a4ae272d", "ethernet_mac": "2c:cf:67:55:70:5f", "ethernet_ip": "192.168.0.245", "wifi_mac": "2c:cf:67:55:70:61", "resolution": "1080x1920", "power_supply": "OK", "cpu_temp_c": "38", "orientation": "portrait"}'::jsonb);

commit;

-- Make yourself the first 1Point admin. First create your login under Authentication -> Users -> Add user,
-- then change the email below to match and run just this statement:
-- insert into public.profiles (user_id, email, full_name, role)
--   select id, email, 'Scot', 'platform_admin' from auth.users where email = 'you@1pointusa.com';
