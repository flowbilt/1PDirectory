# Builds migration/directories.json from the Yodeck screenshots (transcribed by hand) and the Yodeck CSV.
# Arrows: L = left, R = right, "" = none. Order is kept exactly as each screen shows it today.
import csv, json, re

BARBER_FOOTER = "Barber Companies - For leasing information call 205-795-4732"

def t(name, suite, arrow="", note=""):
    return {"name": name, "suite": suite, "arrow": {"L": "left", "R": "right", "": ""}[arrow], "note": note}

PPI = [
  ("ppi-1s", "TBC - PPI - 1 S - NEW", "Perimeter Park One - One South", "South Tower", [
    t("Veracity Wealth Management LLC", "123 S", "L"),
    t("Common Bond Title, LLC", "130 S", "L", "A subsidiary of Affiliates Consolidated Services"),
    t("Perpetual Lifestyle Planning, LLC", "140 S", "L"),
    t("Hyde Roofing", "145 S", "L"),
    t("Fitness Room", "120 S", "L")]),
  ("ppi-2s", "TBC - PPI - 2 S - 194242", "Perimeter Park One - Two South", "South Tower", [
    t("Evan Terry Associates, LLC", "200 S", "R"),
    t("MortgageRight", "230 S", "L")]),
  ("ppi-3n", "TBC - PPI - 3 N - 194293", "Perimeter Park One - Three North", "North Tower", [
    t("Jacobs Engineering Group, Inc.", "315 N", "R"),
    t("Alliance Wealth Management Group, LLC", "318 N", "R"),
    t("American Financial Education Alliance", "318 N", "R"),
    t("Broom Financial Services, LLC", "325 N", "L"),
    t("MicroPulse Technologies", "330 N", "L"),
    t("First Command", "340 N", "L"),
    t("USI Insurance Services, LLC", "344 N", "L")]),
  ("ppi-3s", "TBC - PPI - 3 S - 194294", "Perimeter Park One - Three South", "South Tower", [
    t("Fairvoy Private Wealth, LLC", "300 S", "R"),
    t("Conference Room", "310 S", "L"),
    t("Gelch & Associates, P.A.", "312 S", "R"),
    t("Naderpour & Associates, P.A.", "315 S", "L"),
    t("Progress Residential Property Mgr, LLC", "320 S", "L"),
    t("AFRY USA, LLC", "360 S", "L")]),
  ("ppi-4n", "TBC - PPI - 4 N - 194295", "Perimeter Park One - Four North", "North Tower", [
    t("Spina & Lavelle, P.C.", "400 N", "R"),
    t("Waggoner Engineering, Inc.", "450 N", "L"),
    t("Insight Therapeutic Services", "486 N", "L"),
    t("Alabama Wellness & Aesthetics", "410 N", "L"),
    t("Alvis Law Firm, LLC", "475 N", "L")]),
  ("ppi-4s", "TBC - PPI - 4 S - 194296", "Perimeter Park One - Four South", "South Tower", [
    t("STONE Financial Group", "400 S", "L"),
    t("Project Consulting Services, Inc.", "425 S", "L"),
    t("Statewide Title Services, Inc.", "440 S", "L"),
    t("Roger King Fuston", "430 S", "L"),
    t("TTURNER & Associates, LLC", "465 S", "L")]),
]

PPII = [
  ("ppii-1e", "PPII - 1-East", "PPII - 1 East", "", [
    t("Colliers Valuation & Advisory", "130 E"),
    t("Assurance Scientific Laboratories", "172 E"),
    t("Fitness Room", "140 E"),
    t("Hickcox, Robertson & Stunda, LLC", "100 E"),
    t("Headwater Asset Management LLC", "140 E")]),
  ("ppii-2e", "PPII - 2-East", "PPII - 2 East", "", [
    t("IAT Insurance Group", "228 E"),
    t("Summit Family Law P.C.", "230 E"),
    t("Birmingham Capital Management", "235 E"),
    t("ContinuumRX of Central Alabama", "250 E"),
    t("ContinuumRX Services", "260 E"),
    t("76 FENCE Iron City", "229 E")]),
  ("ppii-3e", "PPII - 3-East", "PPII - 3 East", "", [
    t("PharmaPoint", "300 E"),
    t("Prometheus Group, LLC", "305 E"),
    t("ContinuumRx Services", "370 E"),
    t("Conference Room", "318 E"),
    t("Law Offices of Stevan Goozee, P.C.", "364 E")]),
  ("ppii-4e", "PPII - 4-East", "PPII - 4 East", "", [
    t("Iris Health", "404 E"),
    t("Valmont Newmark, Inc.", "405 E"),
    t("King Forstman Law LLC", "410 E"),
    t("Forstman & Cutchen LLP", "410 E"),
    t("Summit Family Law", "423 E"),
    t("Walker360/Seek Publishing", "425 E"),
    t("Stillwell Counseling Group", "435 E"),
    t("Smart Source, LLC", "440 E"),
    t("Webster, Henry, Lyons, Bradwell, Cohen & Speagle, P.C.", "445 E"),
    t("Prime Senior Placement & Your Choice Senior Care", "460 E")]),
  ("ppii-5e", "PPII - 5-East", "PPII - 5 East", "", [
    t("Sain Associates", "500 E"),
    t("Drake Law Firm", "510 E")]),
  ("ppii-3w", "PPII - 3-West", "PPII - 3 West", "", [
    t("Norluxe Realty Birmingham", "305 W"),
    t("Prometheus Group", "312 W"),
    t("Organogenesis, Inc.", "320 W"),
    t("Hair Club", "350 W"),
    t("Willcam, Inc", "335 W")]),
  ("ppii-4w", "PPII - 4-West", "PPII - 4 West", "", [
    t("Neel-Schaffer, Inc.", "400 W"),
    t("Alvarez & Marsal Holdings, LLC", "430 W"),
    t("Harmon-Dennis-Bradshaw, Inc.", "450 W")]),
  ("ppii-5w", "PPII - 5-West", "PPII - 5 West", "", [
    t("StoneX Wealth Management", "500 W"),
    t("Anistar Technologies", "575 W")]),
]

CADENCE = [
  ("cadence-place", "Cadence Place", "Welcome", "", [
    t("Butler & Company Architects, LLC", "202"),
    t("Acrisure Mortgage, LLC", "204"),
    t("Advo(K)ate Advisors, LLC", "206"),
    t("Office Suites", "208"),
    t("Reliance Partners, LLC", "208E"),
    t("Dyer Orthodontics, LLC", "210"),
    t("American Fidelity Insurance", "212")]),
]

LANDMARK = [
  ("landmark-center", None, "The Landmark Center", "", [
    t("EMW Law LLC.", "300"), t("Life Key", "251"), t("Martin Law Firm, LLC.", "220"), t("PRP Logistics", "410"),
    t("Red Mountain Law Group", "500"), t("Roy M. West d/b/a Manly & Manly, Attorney", "210"),
    t("The Alabama Messenger", "240"), t("Vogtle Howell Companies", "571")]),
]

# Yodeck hardware report, matched by screen name
hw = {}
with open("/mnt/user-data/uploads/monitors_report_ws_all.csv", newline="", encoding="utf-8-sig") as f:
    rows = list(csv.reader(f))
hdr_i = next(i for i, r in enumerate(rows) if r and r[0] == "Assigned Workspace")
hdr = rows[hdr_i]
for r in rows[hdr_i + 1:]:
    if len(r) < len(hdr) or not r[2]: continue
    d = dict(zip(hdr, r))
    w, h = (d["Screen Resolution"].split("x") + ["0"])[:2]
    hw[d["Screen Name"]] = {
        "yodeck_id": d["Screen ID"], "model": d["Hardware Version"], "serial": d["Serial Number"],
        "ethernet_mac": d["Ethernet MAC"], "ethernet_ip": d["Ethernet IPv4"], "wifi_mac": d["WLAN MAC"],
        "resolution": d["Screen Resolution"], "power_supply": d["Power Supply"], "cpu_temp_c": d["CPU Temperature (℃)"],
        "orientation": "portrait" if int(h or 0) > int(w or 0) else "landscape",
    }

def build(prop_list, prop_name):
    out = []
    for slug, yname, title, subtitle, tenants in prop_list:
        h = hw.get(yname, {}) if yname else {}
        out.append({"slug": slug, "title": title, "subtitle": subtitle, "tenants": tenants,
                    "screen": {"key": slug, "name": yname or title, "orientation": h.get("orientation", "portrait" if slug == "landmark-center" else "landscape"), "hardware": h}})
        if yname and yname not in hw: raise SystemExit(f"No Yodeck row for {yname}")
    return out

data = {
  "organizations": [
    {"key": "barber", "name": "Barber Companies", "kind": "manager", "properties": [
      {"key": "landmark-center", "name": "The Landmark Center", "address": "2100 1st Avenue North, Birmingham",
       "footer": "Welcome to The Landmark Center. Have a great day.",
       "managed_by": {"name": "Leigh Ann Kornegay", "company": "Barber Companies", "phone": "205-995-9116"},
       "leased_by": {"name": "Weyman Prater", "company": "Barber Companies", "phone": "205-995-9119"},
       "lat": 33.5186, "lon": -86.8104, "directories": build(LANDMARK, "Landmark")},
      {"key": "perimeter-park-one", "name": "Perimeter Park One", "address": "", "footer": BARBER_FOOTER,
       "lat": 33.4663, "lon": -86.8080, "directories": build(PPI, "PPI")},
      {"key": "perimeter-park-two", "name": "Perimeter Park Two", "address": "", "footer": BARBER_FOOTER,
       "lat": 33.4663, "lon": -86.8080, "directories": build(PPII, "PPII")},
      {"key": "cadence-place", "name": "Cadence Place", "address": "", "footer": "",
       "lat": 33.5186, "lon": -86.8104, "directories": build(CADENCE, "Cadence")},
    ]},
  ]
}
json.dump(data, open("directories.json", "w"), indent=2)
n_dir = sum(len(p["directories"]) for o in data["organizations"] for p in o["properties"])
n_ten = sum(len(d["tenants"]) for o in data["organizations"] for p in o["properties"] for d in p["directories"])
print(f"{n_dir} directories, {n_ten} tenants, {len(hw)} Yodeck rows matched")
for name, h in hw.items():
    flags = [k for k, bad in (("POWER UNDER-VOLTAGE", h["power_supply"] == "UNDER"), ("4K OUTPUT", h["resolution"] == "3840x2160")) if bad]
    if flags: print("  hardware flag:", name, "-", ", ".join(flags))
