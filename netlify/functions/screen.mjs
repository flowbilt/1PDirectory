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

// Bump when toPayload's output changes shape, so every screen re-downloads once after the deploy. The live display
// version is part of the tag too (TAG), so a display deploy also gives every screen a fresh answer.
const PAYLOAD_V = "p7";
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

/** The screen's check-in details, if the display sent them. */
function report(req) {
  const size = (req.headers.get("x-screen-size") || "").match(/^(\d{1,5})x(\d{1,5})$/);
  if (!size) return null;
  return {
    w: Math.min(20000, Number(size[1])), h: Math.min(20000, Number(size[2])),
    version: (req.headers.get("x-display-version") || "").slice(0, 20),
    agent: (req.headers.get("user-agent") || "").slice(0, 160),
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
    sizes: screen.sizes || {},                             // this screen's sizes, % of standard (supabase/18-sizes.sql)
    display: DISPLAY_VERSION,                              // the live display code; an older screen reloads itself
    assigned: !!dir,
    identifyUntil: screen.identify_until || null,
    updatedAt: updated,
  };
}

export const NEW_DEVICE = (device) => ({ key: null, device, assigned: false, newDevice: true, orientation: "auto", propertyName: "New display", buildingLabel: "", tenants: [], managedBy: {}, leasedBy: {}, welcome: "", weather: { enabled: false }, news: { enabled: false }, background: {}, traffic: { map: false, times: false, destinations: [] }, amenities: [], placeLists: [], togo: { enabled: false, url: "", line: "" }, poweredBy: true, touch: false, screenInches: null, sizes: {}, display: DISPLAY_VERSION, logo: "", timezone: "America/Chicago" });

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
    return send(toPayload(r.screen, r.dir, r.prop, r.tenants), 200, etag);
  } catch (e) {
    return send({ error: e.message }, e.status && e.status < 500 ? e.status : 502);
  }
};

export const config = { path: "/api/screen" };
