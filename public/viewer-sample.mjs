// "See Your WayTuGo in Action" (DP-14, V1): the viewer's choices and the sample directory made from them.
// Shared by the viewer page (public/viewer.html), the function that keeps each visit (netlify/functions/viewer.mjs)
// and the console's Viewer tab, so a saved visit redraws exactly as the visitor saw it. Everything made here is
// invented demonstration content: no real tenants, people, phone numbers or places.

export const KINDS = { directory: "Building directory", touch: "Touch directory" };
export const MIN_TENANTS = 4, MAX_TENANTS = 60;
export const LIMITS = { name: 60, subtitle: 60 };

const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);

/** The viewer's choices, as kept: { v, kind, name, subtitle, tenants, shape, weather, qr, places, contacts } */
export function normalizeConfig(c) {
  const x = c && typeof c === "object" ? c : {};
  const n = Math.round(Number(x.tenants));
  return {
    v: 1,
    kind: KINDS[x.kind] ? x.kind : "directory",
    name: clean(x.name, LIMITS.name),
    subtitle: clean(x.subtitle, LIMITS.subtitle),
    tenants: Number.isFinite(n) ? Math.min(MAX_TENANTS, Math.max(MIN_TENANTS, n)) : 12,
    shape: x.shape === "portrait" ? "portrait" : "landscape",
    weather: x.weather !== false,
    qr: x.qr === true,
    places: x.places === true,
    contacts: x.contacts !== false,
  };
}

/** Problems with choices sent to be kept (the same rules as supabase/48-viewer.sql's viewer_config_problem) */
export function configProblem(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return "The choices are an object.";
  const keys = ["v", "kind", "name", "subtitle", "tenants", "shape", "weather", "qr", "places", "contacts"];
  for (const k of Object.keys(c)) if (!keys.includes(k)) return `"${k}" isn't one of the viewer's choices.`;
  if (c.v !== 1) return "The choices are version 1.";
  if (!KINDS[c.kind]) return "The display is a building directory or a touch directory.";
  for (const k of ["name", "subtitle"]) if (typeof c[k] !== "string" || c[k].length > LIMITS[k]) return `The ${k} is text of up to ${LIMITS[k]} characters.`;
  if (!Number.isInteger(c.tenants) || c.tenants < MIN_TENANTS || c.tenants > MAX_TENANTS) return `The tenants are ${MIN_TENANTS} to ${MAX_TENANTS}.`;
  if (!["landscape", "portrait"].includes(c.shape)) return "The screen is landscape or portrait.";
  for (const k of ["weather", "qr", "places", "contacts"]) if (typeof c[k] !== "boolean") return `${k} is on or off.`;
  return "";
}

/** One line for an inquiry or the console, e.g. "Touch directory · Landmark Business Center · 12 tenants · portrait · weather, QR" */
export function summary(c) {
  c = normalizeConfig(c);
  const extras = [c.weather && "weather", c.qr && "QR", c.places && "places", c.contacts && "contacts"].filter(Boolean);
  return [KINDS[c.kind], c.name || "(no name)", `${c.tenants} tenants`, c.shape, extras.length ? extras.join(", ") : "no extras"].join(" · ");
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
function hash(s) { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.codePointAt(0), 16777619); return h >>> 0; }
function rand(seed) { let a = seed || 1; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** The invented tenants for these choices: names, suites by floor, and the arrow to each floor's lift lobby */
export function sampleTenants(c) {
  c = normalizeConfig(c);
  const r = rand(hash(`${c.name.toLowerCase()}|${c.tenants}`));
  const names = TENANTS.slice();
  for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
  const floors = Math.max(1, Math.ceil(c.tenants / 12)), dirs = ["right", "left", "up", "right", "left"];
  const out = names.slice(0, c.tenants).map((name, i) => {
    const floor = 1 + Math.floor((i * floors) / c.tenants), room = 100 * floor + 10 + ((i * 7) % 12) * 5;
    return { name, suite: String(room), dir: floor === 1 ? dirs[i % 2] : "up", note: "", people: [] };
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The directory screen's data for these choices (the shape edit.js sends the screen's preview) */
export function sampleDirectory(c, { togoUrl = "https://waytugo.com/" } = {}) {
  c = normalizeConfig(c);
  return {
    key: "viewer", orientation: c.shape, sample: true,
    propertyName: c.name || "Your Building Name", buildingLabel: c.subtitle,
    logo: "", logoReplacesName: false, companyLogo: "", logoSwap: false,
    tenants: sampleTenants(c),
    managedBy: c.contacts ? { name: "Your Property Manager", company: "Sample Property Management", phone: "(205) 555-0100" } : {},
    leasedBy: c.contacts ? { name: "Leasing Office", company: "Sample Realty Partners", phone: "(205) 555-0142" } : {},
    welcome: "Sample directory · names, suites and phone numbers are demonstration content",
    // Weather for 1Point's home (Birmingham, Alabama): real weather, so the sample looks alive
    weather: { enabled: c.weather, lat: 33.5186, lon: -86.8104 },
    timezone: "America/Chicago",
    news: { enabled: false, rotateSeconds: 12 },
    traffic: { map: false, times: false, lat: null, lon: null, mapsKey: "", destinations: [] },
    amenities: [],
    placeLists: c.places ? [{ heading: "Nearby", items: PLACES.map((p) => ({ ...p })) }] : [],
    togo: { enabled: c.qr, url: togoUrl, line: "Take this directory with you!" },
    poweredBy: true,
    touch: c.kind === "touch", screenInches: c.kind === "touch" ? 55 : null, touchIdle: 90, keyboard: false,
    background: {}, sizes: {}, assigned: true, updatedAt: null,
  };
}
