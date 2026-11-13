// "See Your WayTuGo in Action" (DP-14, V1): the viewer's choices and the sample directory made from them.
// Shared by the viewer page (public/viewer.html), the function that keeps each visit (netlify/functions/viewer.mjs)
// and the console's Viewer tab, so a saved visit redraws exactly as the visitor saw it. Everything made here is
// invented demonstration content: no real tenants, people, phone numbers or places.

export const KINDS = { directory: "Building directory", touch: "Touch directory" };
export const MIN_TENANTS = 4, MAX_TENANTS = 60;
// V2 (DP-14): the slider goes to 20 (Scot: "lower the amount of tenants available on the slider to 20 ... They can ask
// for other configurations"); visits kept before V2 may say up to 60, and redraw as they were
export const SLIDER_MAX = 20;
export const LIMITS = { name: 60, subtitle: 60, suite: 12 };
// V2: the logo and the building photo: none, WayTuGo's placeholder, or the visitor's own (shown only in their browser:
// never sent or kept; a kept visit says only "own", and redraws with the placeholder)
export const PICTURE = ["off", "sample", "own"];
export const PLACEHOLDER = { logo: "/viewer-pics/your-logo.png", photo: "/viewer-pics/building.jpg" };

const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);

/** The viewer's choices, as kept: { v, kind, name, subtitle, tenants, shape, weather, qr, places, contacts, news }
 *  (V1b, DP-14: "news", sample headlines in the information box; older visits have no "news", which is off)
 *  V2 (DP-14), version 2: also { look, logo, photo, rows }: Dark or Light; the logo and building photo (off, the
 *  placeholder, or the visitor's own); and the tenant rows the visitor typed over ([{ name, suite }], one per row
 *  shown; blank keeps the sample's). Version 1 visits (before V2) keep their own sample list. */
export function normalizeConfig(c) {
  const x = c && typeof c === "object" ? c : {};
  const n = Math.round(Number(x.tenants));
  const v = x.v === 2 ? 2 : 1;   // no version: version 1 (every visit kept before V2 says 1; the viewer sends 2)
  const tenants = Number.isFinite(n) ? Math.min(v === 1 ? MAX_TENANTS : SLIDER_MAX, Math.max(MIN_TENANTS, n)) : 10;
  const rows = v === 2 && Array.isArray(x.rows) ? x.rows.slice(0, tenants).map((r) => ({ name: clean(r?.name, LIMITS.name), suite: clean(r?.suite, LIMITS.suite) })) : [];
  while (rows.length && !rows[rows.length - 1].name && !rows[rows.length - 1].suite) rows.pop();   // nothing typed at the end: not kept
  return {
    v,
    kind: KINDS[x.kind] ? x.kind : "directory",
    name: clean(x.name, LIMITS.name),
    subtitle: clean(x.subtitle, LIMITS.subtitle),
    tenants,                                               // V1b: 10 to start (Scot)
    shape: x.shape === "portrait" ? "portrait" : "landscape",
    weather: x.weather !== false,
    qr: x.qr === true,
    places: x.places === true,
    contacts: x.contacts !== false,
    news: x.news === true,
    ...(v === 2 ? { look: x.look === "light" ? "light" : "dark", logo: PICTURE.includes(x.logo) ? x.logo : "off", photo: PICTURE.includes(x.photo) ? x.photo : "off", rows } : {}),
  };
}

/** Problems with choices sent to be kept (the same rules as supabase/48-viewer.sql's viewer_config_problem) */
export function configProblem(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return "The choices are an object.";
  const keys = ["v", "kind", "name", "subtitle", "tenants", "shape", "weather", "qr", "places", "contacts", "news", "look", "logo", "photo", "rows"];
  for (const k of Object.keys(c)) if (!keys.includes(k)) return `"${k}" isn't one of the viewer's choices.`;
  if (c.v !== 1 && c.v !== 2) return "The choices are version 1 or 2.";
  if (!KINDS[c.kind]) return "The display is a building directory or a touch directory.";
  for (const k of ["name", "subtitle"]) if (typeof c[k] !== "string" || c[k].length > LIMITS[k]) return `The ${k} is text of up to ${LIMITS[k]} characters.`;
  if (!Number.isInteger(c.tenants) || c.tenants < MIN_TENANTS || c.tenants > MAX_TENANTS) return `The tenants are ${MIN_TENANTS} to ${MAX_TENANTS}.`;
  if (!["landscape", "portrait"].includes(c.shape)) return "The screen is landscape or portrait.";
  for (const k of ["weather", "qr", "places", "contacts"]) if (typeof c[k] !== "boolean") return `${k} is on or off.`;
  if (c.news !== undefined && typeof c.news !== "boolean") return "news is on or off.";
  // V2: version 2's choices
  if (c.v === 1 && ["look", "logo", "photo", "rows"].some((k) => k in c)) return "The look, logo, photo and rows are version 2's.";
  if (c.v === 2) {
    if (c.tenants > SLIDER_MAX) return `The tenants are ${MIN_TENANTS} to ${SLIDER_MAX}.`;
    if (!["dark", "light"].includes(c.look)) return "The look is Dark or Light.";
    for (const k of ["logo", "photo"]) if (!PICTURE.includes(c[k])) return `The ${k} is off, the sample or their own.`;
    if (!Array.isArray(c.rows) || c.rows.length > c.tenants) return "The rows are a list, one for each tenant at most.";
    for (const r of c.rows) {
      if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((k) => k !== "name" && k !== "suite")) return "Each row is a name and a suite.";
      if (typeof r.name !== "string" || r.name.length > LIMITS.name || typeof r.suite !== "string" || r.suite.length > LIMITS.suite) return `A row's name is up to ${LIMITS.name} characters and its suite up to ${LIMITS.suite}.`;
    }
  }
  return "";
}

/** One line for an inquiry or the console, e.g. "Touch directory · Landmark Business Center · 12 tenants · portrait · weather, QR" */
export function summary(c) {
  c = normalizeConfig(c);
  const extras = [c.weather && "weather", c.news && "news", c.qr && "QR", c.places && "places", c.contacts && "contacts"].filter(Boolean);
  const typed = (c.rows || []).filter((r) => r.name || r.suite).length;
  const pics = [c.logo === "own" ? "own logo" : c.logo === "sample" && "logo", c.photo === "own" ? "own photo" : c.photo === "sample" && "photo"].filter(Boolean);
  return [KINDS[c.kind], c.name || "(no name)", `${c.tenants} tenants${typed ? ` (${typed} typed in)` : ""}`, c.shape, c.look === "light" ? "Light" : c.v === 2 ? "Dark" : "",
    pics.length ? pics.join(", ") : "", extras.length ? extras.join(", ") : "no extras"].filter(Boolean).join(" · ");
}

// Invented businesses (none is meant to be a real company); shuffled by the building's name so each visitor's list
// looks different but the same choices always give the same list
const TENANTS = [
  "Riverbend Dental", "Summit Ridge Insurance", "Oakline Financial Group", "Clearwater Physical Therapy", "Harbor Point Law",
  "Brightpath Learning Center", "Meridian Title Co.", "Cedar & Stone Architects", "Northgate Family Medicine", "Bluebird Pediatrics",
  "Ironwood Engineering", "Copper Kettle Catering", "Fieldstone Realty", "Lakeside Vision Care", "Granite Peak Consulting",
  "Willow Creek Counseling", "Beacon Hill Accounting", "Silver Maple Wealth", "Trailhead Chiropractic", "Keystone Staffing",
  "Redbud Hearing Center", "Magnolia Dermatology", "Pinecrest Orthodontics", "Bright Harbor Tutoring", "Stonebridge Mortgage",
  "Evergreen Wellness", "Sterling Court Reporters", "Crossroads Travel", "Foxglove Interiors", "Hollow Oak Studios",
  "Kingfisher Logistics", "Lantern Media Group", "Maple Row Pharmacy", "Northstar IT Services", "Orchard Lane Optometry",
  "Parkview Allergy & Asthma", "Quarry Street Dental Lab", "Rosewood Hair Studio", "Saltmarsh Marketing", "Thistle & Pine Florist",
  "Union Square Tax Service", "Valley Forge Benefits", "Westbrook Sleep Clinic", "Yellowhammer Print Shop", "Amberly Speech Therapy",
  "Briar Patch Daycare", "Coastal Plains Surveying", "Driftwood Yoga", "Elm Street Notary", "Fairhaven Endodontics",
  "Glenwood Urgent Care", "Highland Payroll", "Juniper Health Partners", "Kestrel Security Consulting", "Larkspur Women's Health",
  "Millbrook Credit Union", "Nightingale Home Health", "Old Mill Bookkeeping", "Pebble Creek Podiatry", "Ridgeway Insurance Agency",
];
const PLACES = [
  { name: "Corner Bakery & Coffee", line: "Espresso, pastries and lunch", distance: "1 min walk" },
  { name: "Main Street Deli", line: "Sandwiches and salads to go", distance: "3 min walk" },
  { name: "Riverside Bank ATM", line: "In the lobby, by the elevators", distance: "Lobby" },
  { name: "Greenway Fitness", line: "Day passes for visitors", distance: "5 min walk" },
];
// The information box's sample stories (V1c, Scot: "Headlines like, 'Doc Find Donuts Boost Metabolism' and 'Monkey Runs
// Amok in Banana Factory'"): silly on purpose, so nobody takes them for news. A real screen shows live headlines.
// Each may have a picture in public/viewer-pics/ (see viewer-pics/README.md); a story whose picture isn't there yet
// shows as text.
const HEADLINES = [
  { title: "Docs Find Donuts Boost Metabolism", pic: "donuts" },
  { title: "Monkey Runs Amok in Banana Factory", pic: "monkey" },
  { title: "Goat Hockey Takes the City by Storm", pic: "goat" },
  { title: "Squirrel Befriends Pumpkin", pic: "squirrel" },
  { title: "Lab Irradiates Socks to End the Lost-Sock Crisis", pic: "socks" },
  { title: "Mystery Office Plants Take Over Third Floor", pic: "office-plant" },
];
// Events and places nearby, for Places and promotions (V1c, Scot: "An event could be 'Monster Trikes at Crambone Arena'")
const EVENTS = [
  { name: "Monster Trikes at Crambone Arena", line: "Big wheels, bigger noise. Tickets at the door", distance: "Saturday 7 pm", pic: "monster-trikes" },
  { name: "Downtown Chili Cook-Off", line: "Forty pots, one champion, free tasting", distance: "Sunday noon", pic: "chili" },
  { name: "Dog Day in the Park", line: "Contests, treat vendors, adoptions and family fun", distance: "Saturday 10 am", pic: "dog" },
];
// The pictures that have been added to public/viewer-pics/ (each <key>.jpg, at least 300 px wide)
export const PICS = ["donuts", "monkey", "goat", "squirrel", "socks", "office-plant", "monster-trikes", "chili", "dog"];
const pic = (k) => (PICS.includes(k) ? `/viewer-pics/${k}.jpg` : "");
// People at a tenant, for the touch directory's cards (V1c: "add a few employees per tenant so the touch doesn't just
// show the same thing as the company line"); invented names, 555 numbers and .example addresses
const FIRST = ["Avery", "Jordan", "Morgan", "Taylor", "Casey", "Riley", "Quinn", "Parker", "Reese", "Hayden", "Dana", "Jamie", "Logan", "Skyler", "Rowan", "Emerson", "Blake", "Cameron", "Drew", "Elliot"];
const LAST = ["Whitfield", "Calloway", "Brannon", "Pruitt", "Holloway", "McAdory", "Lindsey", "Garrison", "Tolbert", "Ashford", "Kimbrough", "Rutledge", "Hargrove", "Pickens", "Dunaway", "Crenshaw", "Bledsoe", "Fairley", "Stallings", "Yarbrough"];
const TITLES = ["Owner", "Office Manager", "Partner", "Director", "Associate", "Front Desk", "Practice Manager", "Account Executive", "Operations Lead", "Client Services"];
function hash(s) { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.codePointAt(0), 16777619); return h >>> 0; }
function rand(seed) { let a = seed || 1; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** The invented tenants for these choices: names, suites by floor, and the arrow to each floor's lift lobby */
export function sampleTenants(c) {
  c = normalizeConfig(c);
  if (c.v === 2) return sampleRows(c).map((t) => ({ name: t.name, suite: t.suite, dir: t.dir, note: "", people: t.people }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const withPeople = c.kind === "touch";
  const r = rand(hash(`${c.name.toLowerCase()}|${c.tenants}`));
  const names = TENANTS.slice();
  for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
  const floors = Math.max(1, Math.ceil(c.tenants / 12)), dirs = ["right", "left", "up", "right", "left"];
  const out = names.slice(0, c.tenants).map((name, i) => {
    const floor = 1 + Math.floor((i * floors) / c.tenants), room = 100 * floor + 10 + ((i * 7) % 12) * 5;
    const people = [];
    if (withPeople) {
      const n = 2 + Math.floor(r() * 3), domain = name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "").slice(0, 24);
      for (let k = 0; k < n; k++) {
        const first = FIRST[Math.floor(r() * FIRST.length)], last = LAST[Math.floor(r() * LAST.length)];
        people.push({ first, last, title: k === 0 ? TITLES[Math.floor(r() * 4)] : TITLES[4 + Math.floor(r() * 6)],
          phone: `(205) 555-${String(1000 + Math.floor(r() * 8999)).slice(0, 4)}`, email: `${first[0].toLowerCase()}${last.toLowerCase()}@${domain}.example`, suite: "" });
      }
    }
    return { name, suite: String(room), dir: floor === 1 ? dirs[i % 2] : "up", note: "", people };
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** V2: the rows as the viewer lists them, in order: the sample's name and suite for each (the same ones whatever the
 *  building's name or the slider, so a row doesn't change under the visitor), with what they typed over them, and the
 *  sample's people on a touch directory (a typed-in company's people are invented too) */
export function sampleRows(c) {
  c = normalizeConfig(c);
  const r = rand(hash("waytugo-viewer-2"));
  const names = TENANTS.slice();
  for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
  const dirs = ["right", "left"];
  return names.slice(0, c.tenants).map((sample, i) => {
    const floor = 1 + Math.floor(i / 7), room = String(100 * floor + 10 + (i % 7) * 10);
    const typed = c.rows[i] || { name: "", suite: "" }, name = typed.name || sample;
    const people = [];
    if (c.kind === "touch") {
      const pr = rand(hash(`${i}|${name.toLowerCase()}`)), n = 2 + Math.floor(pr() * 3), domain = name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "").slice(0, 24) || "company";
      for (let k = 0; k < n; k++) {
        const first = FIRST[Math.floor(pr() * FIRST.length)], last = LAST[Math.floor(pr() * LAST.length)];
        people.push({ first, last, title: k === 0 ? TITLES[Math.floor(pr() * 4)] : TITLES[4 + Math.floor(pr() * 6)],
          phone: `(205) 555-${String(1000 + Math.floor(pr() * 8999)).slice(0, 4)}`, email: `${first[0].toLowerCase()}${last.toLowerCase()}@${domain}.example`, suite: "" });
      }
    }
    return { sample, sampleSuite: room, name, suite: typed.suite || room, dir: floor === 1 ? dirs[i % 2] : "up", people };
  });
}

/** The directory screen's data for these choices (the shape edit.js sends the screen's preview) */
export function sampleDirectory(c, { togoUrl = "https://waytugo.com/", ownLogo = "", ownPhoto = "" } = {}) {
  c = normalizeConfig(c);
  // V2: the visitor's own pictures come from their browser (ownLogo, ownPhoto); without them, the placeholders
  const logo = c.logo === "own" && ownLogo ? ownLogo : c.logo && c.logo !== "off" ? PLACEHOLDER.logo : "";
  const photo = c.photo === "own" && ownPhoto ? ownPhoto : c.photo && c.photo !== "off" ? PLACEHOLDER.photo : "";
  return {
    key: "viewer", orientation: c.shape, sample: true,
    propertyName: c.name || "Your Building Name", buildingLabel: c.subtitle,
    logo, logoReplacesName: false, companyLogo: "", logoSwap: false,
    tenants: sampleTenants(c),
    managedBy: c.contacts ? { name: "Your Property Manager", company: "Sample Property Management", phone: "(205) 555-0100" } : {},
    leasedBy: c.contacts ? { name: "Leasing Office", company: "Sample Realty Partners", phone: "(205) 555-0142" } : {},
    welcome: "Sample directory · names, suites and phone numbers are demonstration content",
    // Weather for 1Point's home (Birmingham, Alabama): real weather, so the sample looks alive
    weather: { enabled: c.weather, lat: 33.5186, lon: -86.8104 },
    timezone: "America/Chicago",
    // V1b: sample headlines when news is on. Ticked, news or places keeps its box (Scot: "Viewer keeps it"): a real
    // landscape screen gives the box up when the names would be clearly bigger without it
    news: { enabled: c.news, rotateSeconds: 8, items: c.news ? HEADLINES.map((h) => ({ title: h.title, source: "Sample news", published: null, image: pic(h.pic) })) : [] },
    keepInfo: c.news || c.places,
    traffic: { map: false, times: false, lat: null, lon: null, mapsKey: "", destinations: [] },
    amenities: [],
    placeLists: c.places ? [
      { heading: "Events", items: EVENTS.map(({ pic: k, ...e }) => ({ ...e, image: pic(k) })) },
      { heading: "Nearby", items: PLACES.map((p) => ({ ...p })) },
    ] : [],
    togo: { enabled: c.qr, url: togoUrl, line: "Take this directory with you!" },
    poweredBy: true,
    touch: c.kind === "touch", screenInches: c.kind === "touch" ? 55 : null, touchIdle: 90, keyboard: false,
    // V2: the building photo behind the directory, as a building's editor sets it up (a quarter showing through)
    background: photo ? { enabled: true, image: photo, visibility: 25, size: 100, position: 50, offset: 0 } : {},
    look: c.look === "light" ? "light" : "dark", lookWhen: null,   // V2: a real screen can follow sunrise and sunset
    sizes: {}, assigned: true, updatedAt: null,
  };
}
