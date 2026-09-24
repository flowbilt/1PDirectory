// GET /api/screen?key=ppi-2s  -> everything one lobby screen needs, in one response.
// Older screens use ?site=landmark-center; that works too.
// Pis set up with the agent use ?device=<serial>: the screen is whatever the console has assigned that Pi to.
// Public (screens don't sign in), read with the service key, and limited to display content.
import { createHash } from "node:crypto";
import { SITE_RE } from "../lib/common.mjs";
import { db, enc } from "../lib/sb.mjs";

const reply = (req, obj, status = 200) => {
  const body = JSON.stringify(obj);
  const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", ETag: etag };
  if (status === 200 && (req.headers.get("if-none-match") || "").split(/\s*,\s*/).includes(etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { status, headers });
};

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

export default async (req) => {
  const url = new URL(req.url);
  const device = (url.searchParams.get("device") || "").trim().toLowerCase();
  let key = (url.searchParams.get("key") || url.searchParams.get("screen") || url.searchParams.get("site") || "").trim().toLowerCase();
  if (device && !/^[0-9a-f]{8,32}$/.test(device)) return reply(req, { error: "Bad device serial." }, 400);
  if (!device && !SITE_RE.test(key)) return reply(req, { error: "Screen address may use lowercase letters, numbers and dashes only." }, 400);

  try {
    if (device) {
      const [d] = await db(`devices?serial=eq.${enc(device)}&select=screen_id`);
      const [s] = d?.screen_id ? await db(`screens?id=eq.${enc(d.screen_id)}&select=key`) : [];
      if (!s) return reply(req, { key: null, device, assigned: false, newDevice: true, orientation: "auto", propertyName: "New display", buildingLabel: "", tenants: [], managedBy: {}, leasedBy: {}, welcome: "", weather: { enabled: false }, news: { enabled: false }, background: {}, logo: "", timezone: "America/Chicago" });
      key = s.key;
    }
    const [screen] = await db(`screens?key=eq.${enc(key)}&select=key,name,orientation,directory_id,identify_until`);
    if (!screen) return reply(req, { error: `No screen named "${key}".` }, 404);
    if (!screen.directory_id) return reply(req, toPayload(screen, null, null, []));

    const [dir] = await db(`directories?id=eq.${enc(screen.directory_id)}&select=*`);
    if (!dir) return reply(req, toPayload(screen, null, null, []));
    const [[prop], tenants] = await Promise.all([
      db(`properties?id=eq.${enc(dir.property_id)}&select=*`),
      db(`tenants?directory_id=eq.${enc(dir.id)}&select=name,suite,arrow,note,sort&order=sort.asc,name.asc`),
    ]);
    return reply(req, toPayload(screen, dir, prop, tenants));
  } catch (e) {
    return reply(req, { error: e.message }, e.status && e.status < 500 ? e.status : 502);
  }
};

export const config = { path: "/api/screen" };
