# Generates supabase/02-seed.sql from migration/directories.json.
import json, uuid
data = json.load(open("/home/claude/dir/migration/directories.json"))
q = lambda s: "'" + str(s).replace("'", "''") + "'"
j = lambda o: q(json.dumps(o)) + "::jsonb"
num = lambda v: "null" if v is None else repr(float(v))
out = ["-- Lobby Directory: starting data, migrated from Yodeck and Wix.",
       "-- Run once, after 01-schema.sql. Transcribed from screenshots: proofread in the editor afterwards.",
       "begin;", ""]
for o in data["organizations"]:
    oid = uuid.uuid4()
    out.append(f"insert into public.organizations (id, name, kind) values ({q(oid)}, {q(o['name'])}, {q(o['kind'])});")
    for p in o["properties"]:
        pid = uuid.uuid4()
        out.append(f"\n-- {p['name']}")
        out.append("insert into public.properties (id, org_id, name, address, lat, lon, footer, managed_by, leased_by) values "
                   f"({q(pid)}, {q(oid)}, {q(p['name'])}, {q(p.get('address',''))}, {num(p.get('lat'))}, {num(p.get('lon'))}, "
                   f"{q(p.get('footer',''))}, {j(p.get('managed_by',{}))}, {j(p.get('leased_by',{}))});")
        for d in p["directories"]:
            did = uuid.uuid4()
            out.append(f"insert into public.directories (id, property_id, slug, title, subtitle) values "
                       f"({q(did)}, {q(pid)}, {q(d['slug'])}, {q(d['title'])}, {q(d['subtitle'])});")
            rows = [f"({q(did)}, {i*10}, {q(t['name'])}, {q(t['suite'])}, {q(t['arrow'])}, {q(t['note'])})" for i, t in enumerate(d["tenants"])]
            out.append("insert into public.tenants (directory_id, sort, name, suite, arrow, note) values\n  " + ",\n  ".join(rows) + ";")
            s = d["screen"]
            out.append(f"insert into public.screens (directory_id, key, name, orientation, hardware) values "
                       f"({q(did)}, {q(s['key'])}, {q(s['name'])}, {q(s['orientation'])}, {j(s['hardware'])});")
    out.append("")
out += ["commit;", "",
  "-- Make yourself the first 1Point admin. First create your login under Authentication -> Users -> Add user,",
  "-- then change the email below to match and run just this statement:",
  "-- insert into public.profiles (user_id, email, full_name, role)",
  "--   select id, email, 'Scot', 'platform_admin' from auth.users where email = 'you@1pointusa.com';"]
open("/home/claude/dir/supabase/02-seed.sql", "w").write("\n".join(out) + "\n")
print("seed lines:", len(out))
