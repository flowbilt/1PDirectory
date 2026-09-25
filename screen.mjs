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

// Bump when toPayload's output changes shape, so every screen re-downloads once after the deploy.
const PAYLOAD_V = "p2";
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
    const m = tag.replace(/^W\//, "").match(new RegExp(`^"${PAYLOAD_V}-([0-9a-f]{32})"$`));
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
    tenants: (tenants || []).map((t) => ({ name: t.name, suite: t.suite, dir: t.arrow || "", note: t.note || "" })),
    managedBy: prop?.managed_by || {},
    leasedBy: prop?.leased_by || {},
    welcome: dir?.footer_override ?? prop?.footer ?? "",
    weather: { enabled: dir ? dir.weather_enabled !== false && prop?.lat != null : false, lat: prop?.lat ?? null, lon: prop?.lon ?? null },
    timezone: prop?.timezone || "America/Chicago",
    news: { enabled: dir ? dir.news_enabled !== false : false, rotateSeconds: dir?.rotate_seconds || 12 },
    background: prop?.background || {},
    assigned: !!dir,
    identifyUntil: screen.identify_until || null,
    updatedAt: updated,
  };
}

export const NEW_DEVICE = (device) => ({ key: null, device, assigned: false, newDevice: true, orientation: "auto", propertyName: "New display", buildingLabel: "", tenants: [], managedBy: {}, leasedBy: {}, welcome: "", weather: { enabled: false }, news: { enabled: false }, background: {}, logo: "", timezone: "America/Chicago" });

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
    const etag = `"${PAYLOAD_V}-${r.etag}"`;
    if (r.not_modified) return new Response(null, { status: 304, headers: { ...HEADERS, ETag: etag } });
    return send(toPayload(r.screen, r.dir, r.prop, r.tenants), 200, etag);
  } catch (e) {
    return send({ error: e.message }, e.status && e.status < 500 ? e.status : 502);
  }
};

export const config = { path: "/api/screen" };
