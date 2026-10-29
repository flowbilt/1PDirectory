// GET /api/screen?key=ppi-2s  -> everything one lobby screen needs, in one response.
// Older screens use ?site=landmark-center; that works too.
// Pis set up with the agent use ?device=<serial>: the screen is whatever the console has assigned that Pi to.
// Public (screens don't sign in), read with the service key, and limited to display content.
//
// The check is one database call (screen_state, supabase/05-tuning.sql). It also records the screen's
// check-in when the display sends X-Screen-Size (this replaced the separate heartbeat call), and returns the
// full directory only when something changed. Otherwise the answer is 304 and nothing is re-sent.
import { createHash } from "node:crypto";
import { SITE_RE } from "../lib/common.mjs";
import { rpc } from "../lib/sb.mjs";
import { DISPLAY_VERSION } from "../lib/version.mjs";
import { boardProblem } from "../../public/menu-format.mjs";

// Bump when toPayload's output changes shape, so every screen re-downloads once after the deploy. The live display
// version is part of the tag too (TAG), so a display deploy also gives every screen a fresh answer.
const PAYLOAD_V = "p8";
const TAG = `${PAYLOAD_V}-${DISPLAY_VERSION.replace(/[^0-9.]/g, "")}`;
const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" };

const send = (obj, status = 200, etag) => new Response(JSON.stringify(obj), { status, headers: { ...HEADERS, ...(etag ? { ETag: etag } : {}) } });

/** For answers that don't come from the database version (new devices): tag by content. */
const sendHashed = (req, obj) => {
  const body = JSON.stringify(obj);
  const etag = `"h-${createHash("sha1").update(body).digest("base64url")}"`;
  if ((req.headers.get("if-none-match") || "").split(/\s*,\s*/).includes(etag)) return new Response(null, { status: 304, headers: { ...HEADERS, ETag: etag } });
  return new Response(body, { headers: { ...HEADERS, ETag: etag } });
};

/** The version the screen already has, from If-None-Match, if it's one of ours. */
function knownVersion(req) {
  for (const tag of (req.headers.get("if-none-match") || "").split(/\s*,\s*/)) {
    const m = tag.replace(/^W\//, "").match(new RegExp(`^"${TAG.replace(/\./g, "\\.")}-([0-9a-f]{32})"$`));
    if (m) return m[1];
  }
  return null;
}

/** The drive times' status a screen reports (round 15c), kept to known values. Never Google's minutes or labels: its
 *  terms forbid keeping them, so only whether they show, how many, when Google answered, or why not. */
const TRAFFIC_OFF = new Set(["switched off", "no destinations", "no building location", "hours", "not set up", "no such screen"]);
export function trafficStatus(raw) {
  let t; try { t = JSON.parse(String(raw || "").slice(0, 400)); } catch { return null; }
  if (!t || typeof t !== "object") return null;
  const int = (v) => Math.min(3, Math.max(0, Math.round(Number(v)) || 0));
  const shown = t.shown === true;
  if (t.s === "ok") { const at = Date.parse(t.at); return { s: "ok", n: int(t.n), of: int(t.of), at: Number.isFinite(at) ? new Date(at).toISOString() : null, shown }; }
  if (t.s === "off") return { s: "off", why: TRAFFIC_OFF.has(t.why) ? t.why : "switched off", shown };
  if (t.s === "wait") return { s: "wait", shown };
  if (t.s === "error") return { s: "error", why: String(t.why || "").replace(/[^\w .,:;'()/-]/g, "").slice(0, 120), shown };
  return null;
}

/** E2d (DP-13): how a layout screen drew its board, as it reports with its check-in: how long the draw took, the frame
 *  rate while its pictures turned, the look, whether the chalk grain is on (or was dropped for speed), and any blocks
 *  whose text didn't fit. Kept to known values for the Pi panel. */
export function boardStatus(raw) {
  let b; try { b = JSON.parse(String(raw || "").slice(0, 1200)); } catch { return null; }
  if (!b || typeof b !== "object") return null;
  const n = (v, hi) => (Number.isFinite(Number(v)) && v !== null ? Math.min(hi, Math.max(0, Math.round(Number(v)))) : null);
  return { ms: n(b.ms, 600000), fps: n(b.fps, 240), slow: n(b.slow, 100000) ?? 0, look: ["house", "chalkboard"].includes(b.look) ? b.look : "house",
    grain: ["on", "dropped", "none"].includes(b.grain) ? b.grain : "none",
    overflow: (Array.isArray(b.overflow) ? b.overflow : []).filter((x) => typeof x === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(x)).slice(0, 10),
    shrunk: n(b.shrunk, 60) ?? 0 };
}

/** The screen's check-in details, if the display sent them. */
function report(req) {
  const size = (req.headers.get("x-screen-size") || "").match(/^(\d{1,5})x(\d{1,5})$/);
  if (!size) return null;
  const traffic = trafficStatus(req.headers.get("x-traffic"));
  const board = boardStatus(req.headers.get("x-board"));
  return {
    w: Math.min(20000, Number(size[1])), h: Math.min(20000, Number(size[2])),
    version: (req.headers.get("x-display-version") || "").slice(0, 20),
    agent: (req.headers.get("user-agent") || "").slice(0, 160),
    ...(traffic ? { traffic } : {}),
    ...(board ? { board } : {}),
  };
}

/** A building's amenities and destinations, tidied for the screen (supabase/23-info-panel.sql). */
const text = (v, n) => String(v ?? "").trim().slice(0, n);
export const cleanAmenities = (list) => (Array.isArray(list) ? list : []).slice(0, 20)
  .map((a) => ({ name: text(a?.name, 60), distance: text(a?.distance, 30), line: text(a?.line, 120) })).filter((a) => a.name);
export const cleanDestinations = (list) => (Array.isArray(list) ? list : []).slice(0, 3)
  .map((d) => ({ label: text(d?.label || d?.address, 60), address: text(d?.address, 200) })).filter((d) => d.label);

/** The building's place lists (supabase/24-directory-to-go.sql): up to 5 lists of 12, each with a heading; a picture
 *  only as a small data URL. An empty list is dropped, so it never shows. Falls back to round 11's amenities. */
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
export function cleanPlaceLists(lists, amenities) {
  const src = Array.isArray(lists) && lists.length ? lists : (Array.isArray(amenities) && amenities.length ? [{ heading: "Nearby", items: amenities }] : []);
  return src.slice(0, 5).map((l) => ({
    heading: text(l?.heading, 40) || "Nearby",
    items: (Array.isArray(l?.items) ? l.items : []).slice(0, 12).map((a) => ({
      name: text(a?.name, 60), distance: text(a?.distance, 30), line: text(a?.line, 120),
      link: text(a?.link, 200),   // round 18: an address or web link, a QR code on the place's card (touch screens)
      qrline: text(a?.qrline, 80),   // round 18b: the line beside that QR code (blank: "Take it with you…")
      image: typeof a?.image === "string" && a.image.length <= 160000 && IMAGE_RE.test(a.image) ? a.image : "",
    })).filter((a) => a.name),
  })).filter((l) => l.items.length);
}

/** A tenant's people (supabase/26-people.sql). The database sends them only to touch screens, only with the owner's
 *  switches on, and only the details the owner shows; this just tidies and caps them. */
export const cleanPeople = (list) => (Array.isArray(list) ? list : []).slice(0, 200)
  .map((x) => ({ first: text(x?.first, 60), last: text(x?.last, 60), title: text(x?.title, 80), phone: text(x?.phone, 40),
    email: text(x?.email, 120), suite: text(x?.suite, 16) })).filter((x) => x.first || x.last);

/** Directory to Go: the QR code's link (TOGO_BASE + the directory's code; waytugo.com forwards /d/ here). */
export function togoFor(dir) {
  const base = (process.env.TOGO_BASE || "https://waytugo.com/d/").replace(/\/*$/, "/");
  const on = !!(dir?.togo_enabled && dir?.togo_code);
  return { enabled: on, url: on ? base + dir.togo_code : "", line: text(dir?.togo_line, 80) || "Take this directory with you!" };
}

/** The information panel's traffic parts. The map needs GOOGLE_MAPS_KEY (a browser key, public by design and
 *  locked to the site's address in Google Cloud) and the building's map point; travel times need destinations. */
export function trafficFor(dir, prop) {
  const mapsKey = process.env.GOOGLE_MAPS_KEY || "";
  const hasPoint = prop?.lat != null && prop?.lon != null;
  const map = !!(dir?.map_enabled && mapsKey && hasPoint);
  const destinations = cleanDestinations(prop?.destinations).map((d) => d.label);
  return { map, times: !!(dir?.times_enabled && destinations.length), lat: prop?.lat ?? null, lon: prop?.lon ?? null,
    mapsKey: map ? mapsKey : "", destinations };
}

/** Turns database rows into the shape the display draws. Also used by the editor preview (same fields). */
export function toPayload(screen, dir, prop, tenants) {
  const updated = [dir?.updated_at, prop?.updated_at].filter(Boolean).sort().pop() || null;
  return {
    key: screen.key,
    screenName: screen.name,
    orientation: screen.orientation || "auto",
    propertyName: dir ? dir.title : screen.name,
    buildingLabel: dir ? (dir.subtitle || prop?.address || "") : "",
    logo: prop?.logo || "",
    logoReplacesName: !!(prop?.logo && prop?.logo_replaces_name),
    companyLogo: prop?.company_logo || "",                 // the owner's or manager's logo (supabase/15-logos.sql)
    logoSwap: !!prop?.logo_swap,                           // true: company logo on top, building logo at the bottom
    // people: only ever filled on a touch screen (26-people.sql); the touch directory (round 15) draws them
    tenants: (tenants || []).map((t) => ({ name: t.name, suite: t.suite, dir: t.arrow || "", note: t.note || "", people: cleanPeople(t.people) })),
    managedBy: prop?.managed_by || {},
    leasedBy: prop?.leased_by || {},
    welcome: dir?.footer_override ?? prop?.footer ?? "",
    weather: { enabled: dir ? dir.weather_enabled !== false && prop?.lat != null : false, lat: prop?.lat ?? null, lon: prop?.lon ?? null },
    timezone: prop?.timezone || "America/Chicago",
    news: { enabled: dir ? dir.news_enabled !== false : false, rotateSeconds: dir?.rotate_seconds || 12 },
    background: prop?.background || {},
    traffic: trafficFor(dir, prop),                        // live map and travel times (supabase/23-info-panel.sql)
    amenities: dir?.amenities_enabled ? cleanAmenities(prop?.amenities) : [],   // for displays before 2.11.0
    placeLists: dir?.amenities_enabled ? cleanPlaceLists(prop?.place_lists, prop?.amenities) : [],
    togo: togoFor(dir),
    poweredBy: !screen.hide_powered_by,                    // "Powered by WayTuGo"; 1Point can hide it per screen
    touch: !!screen.touch,                                 // a touch screen (round 13; the touch directory comes later)
    screenInches: Number.isFinite(Number(screen.screen_inches)) && screen.screen_inches !== null ? Number(screen.screen_inches) : null,
    // The touch directory (round 15; supabase/28-touch-directory.sql): seconds with no touch before it goes back to
    // the whole list (1Point, per screen), and the customer's accessible keyboard switch (per directory)
    touchIdle: Math.min(300, Math.max(15, Math.round(Number(screen.touch_idle_s)) || 45)),
    keyboard: !!dir?.touch_keyboard,
    sizes: screen.sizes || {},                             // this screen's sizes, % of standard (supabase/18-sizes.sql)
    display: DISPLAY_VERSION,                              // the live display code; an older screen reloads itself
    assigned: !!dir,
    identifyUntil: screen.identify_until || null,
    updatedAt: updated,
  };
}

/** E2a (DP-12; supabase/32-menus.sql): a layout's menu as screens and phones get it: each list's kind, room and switches,
 *  and its entries without the hidden ones (kept in the console; never sent out). null with no menu. */
export function cleanLists(m) {
  if (!m || typeof m !== "object" || !Array.isArray(m.spec?.lists)) return null;
  const lists = m.spec.lists.filter((l) => l && /^[a-z0-9][a-z0-9-]{0,39}$/.test(l.key) && ["items", "text", "hours"].includes(l.kind))
    .map((l) => ({ key: l.key, kind: l.kind, room: Math.min(60, Math.max(1, Number(l.room) || 1)), groupPrice: !!l.groupPrice, note: !!l.note, schedule: !!l.schedule }));
  const content = { lists: {} };
  for (const l of lists) {
    const c = m.content?.lists?.[l.key];
    if (!c || typeof c !== "object") continue;
    content.lists[l.key] = { ...(typeof c.price === "string" ? { price: c.price.slice(0, 24) } : {}), ...(typeof c.note === "string" ? { note: c.note.slice(0, 80) } : {}),
      entries: (Array.isArray(c.entries) ? c.entries : []).filter((e) => e && typeof e === "object" && !e.hidden).slice(0, 60) };
  }
  return { id: m.id || null, spec: { lists }, content };
}

/** E2d (DP-13): a board's look and options as saved with its menu (content.boards[layout id]), kept to the presets
 *  (menu-format.mjs boardProblem); anything else is dropped, so the board draws its layout's own defaults. */
export function cleanBoard(m, layoutId) {
  const b = m?.content?.boards?.[layoutId];
  if (!layoutId || !b || typeof b !== "object" || boardProblem(b)) return null;
  return b;
}

/** A layout's pictures (E1b; supabase/30-layout-images.sql): key -> { url, w, h }, served from the site's own /img/. */
export function cleanImages(images) {
  const out = {};
  for (const [k, v] of Object.entries(images && typeof images === "object" ? images : {})) {
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(k) || !/^[0-9a-f-]{36}\/[a-z0-9-]{1,80}\.(webp|jpg|png)$/.test(String(v?.path || ""))) continue;
    out[k] = { url: `/img/${v.path}`, w: Number(v.w) || 0, h: Number(v.h) || 0 };
  }
  return out;
}

/** A screen that shows a layout (DP-11, round E1a; supabase/29-layout-engine.sql): the layout's published version, and
 *  from the screen's building only what a layout uses (time zone, weather point, name and address). */
/** E1c: the phone menu's address for a layout's code (waytugo.com forwards /m/* to this site). */
export function menuFor(code) {
  const base = (process.env.MENU_BASE || "https://waytugo.com/m/").replace(/\/*$/, "/");
  return /^[A-HJKMNP-Z2-9]{6}$/.test(String(code || "")) ? { url: base + code } : { url: "" };
}

export function toLayoutPayload(screen, layout, prop, images) {
  return {
    kind: "layout",
    key: screen.key,
    screenName: screen.name,
    orientation: screen.orientation || "auto",
    layout: { id: layout?.id || null, name: layout?.name || "", version: layout?.version ?? null, doc: layout?.doc || null },
    // E1b: the pictures it uses, key -> where the site serves it (/img/, a pass-through to the storage bucket) and its size
    images: cleanImages(images),
    // E1c: "Take this menu with you", for a QR block: MENU_BASE (default waytugo.com/m/, which forwards here) + the code
    menu: menuFor(layout?.menu_code),
    // E2a: the lists its blocks show (one set of lists for every board on this menu, and the phone menu)
    lists: cleanLists(layout?.lists),
    // E2d: the look and options chosen for this board in the menu editor (null: the layout's own)
    look: cleanBoard(layout?.lists, layout?.id),
    propertyName: prop?.name || "",
    address: prop?.address || "",
    timezone: prop?.timezone || "America/Chicago",
    weather: { enabled: prop?.lat != null && prop?.lon != null, lat: prop?.lat ?? null, lon: prop?.lon ?? null },
    poweredBy: !screen.hide_powered_by,                    // "Powered by WayTuGo"; 1Point can hide it per screen
    touch: !!screen.touch,
    screenInches: Number.isFinite(Number(screen.screen_inches)) && screen.screen_inches !== null ? Number(screen.screen_inches) : null,
    touchIdle: Math.min(300, Math.max(15, Math.round(Number(screen.touch_idle_s)) || 45)),
    display: DISPLAY_VERSION,
    assigned: true,
    identifyUntil: screen.identify_until || null,
  };
}

export const NEW_DEVICE = (device) => ({ key: null, device, assigned: false, newDevice: true, orientation: "auto", propertyName: "New display", buildingLabel: "", tenants: [], managedBy: {}, leasedBy: {}, welcome: "", weather: { enabled: false }, news: { enabled: false }, background: {}, traffic: { map: false, times: false, destinations: [] }, amenities: [], placeLists: [], togo: { enabled: false, url: "", line: "" }, poweredBy: true, touch: false, screenInches: null, touchIdle: 45, keyboard: false, sizes: {}, display: DISPLAY_VERSION, logo: "", timezone: "America/Chicago" });

export default async (req) => {
  const url = new URL(req.url);
  const device = (url.searchParams.get("device") || "").trim().toLowerCase();
  const key = (url.searchParams.get("key") || url.searchParams.get("screen") || url.searchParams.get("site") || "").trim().toLowerCase();
  if (device && !/^[0-9a-f]{8,32}$/.test(device)) return send({ error: "Bad device serial." }, 400);
  if (!device && !SITE_RE.test(key)) return send({ error: "Screen address may use lowercase letters, numbers and dashes only." }, 400);

  try {
    const r = await rpc("screen_state", { p_key: device ? null : key, p_device: device || null, p_etag: knownVersion(req), p_report: report(req) });
    if (r?.new_device) return sendHashed(req, NEW_DEVICE(device));
    if (r?.missing) return send({ error: `No screen named "${key}".` }, 404);
    const etag = `"${TAG}-${r.etag}"`;
    if (r.not_modified) return new Response(null, { status: 304, headers: { ...HEADERS, ETag: etag } });
    if (r.kind === "layout") return send(toLayoutPayload(r.screen, { ...r.layout, lists: r.lists }, r.prop, r.images), 200, etag);
    return send(toPayload(r.screen, r.dir, r.prop, r.tenants), 200, etag);
  } catch (e) {
    return send({ error: e.message }, e.status && e.status < 500 ? e.status : 502);
  }
};

export const config = { path: "/api/screen" };
