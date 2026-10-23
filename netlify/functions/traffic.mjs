// GET /api/traffic?device=<serial>  (or ?key=<screen>)  -> live travel times from the screen's building to its
// destinations, from Google's Routes API with traffic (DP-08 round 11).
//
// Google's terms (Maps Platform Terms 3.2.3(b)) allow no shared cache, so nothing here is stored or shared: each
// screen asks for itself and gets Google's answer straight through. The one database call (traffic_claim,
// supabase/23-info-panel.sql) decides whether this screen may ask now: its directory has travel times on, its
// building has destinations, it's a weekday from 6 a.m. to 7 p.m. at the building, and this screen hasn't asked in
// the last 25 minutes (the display asks every 30). That keeps three screens with three destinations inside Google's
// free monthly amount; a daily cap in Google Cloud is the backstop.
//
// GOOGLE_ROUTES_KEY (Netlify only, never in the database or the page): a key restricted to the Routes API.
import { SITE_RE, json } from "../lib/common.mjs";
import { rpc } from "../lib/sb.mjs";

const ROUTES_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const FIELDS = "originIndex,destinationIndex,duration,staticDuration,distanceMeters,condition,status";

const seconds = (s) => { const m = String(s || "").match(/^(\d+(?:\.\d+)?)s$/); return m ? Number(m[1]) : null; };

/** Google's waypoint for the building (its map point if set, else its address) or a destination's address. */
const waypoint = (w) => (w.lat != null && w.lon != null
  ? { waypoint: { location: { latLng: { latitude: Number(w.lat), longitude: Number(w.lon) } } } }
  : { waypoint: { address: String(w.address || "") } });

/** Google's answer -> what the screen shows: minutes now, minutes without traffic, miles. */
export function toTimes(destinations, elements) {
  return destinations.map((d, i) => {
    const e = (Array.isArray(elements) ? elements : []).find((x) => x.destinationIndex === i || (i === 0 && x.destinationIndex == null));
    const ok = e && !e.status?.code && (!e.condition || e.condition === "ROUTE_EXISTS") && seconds(e.duration) != null;
    return {
      label: String(d.label || d.address || "").slice(0, 60),
      minutes: ok ? Math.max(1, Math.round(seconds(e.duration) / 60)) : null,
      usualMinutes: ok && seconds(e.staticDuration) != null ? Math.max(1, Math.round(seconds(e.staticDuration) / 60)) : null,
      miles: ok && e.distanceMeters != null ? Math.round(e.distanceMeters / 160.934) / 10 : null,
    };
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const device = (url.searchParams.get("device") || "").trim().toLowerCase();
  const key = (url.searchParams.get("key") || url.searchParams.get("screen") || "").trim().toLowerCase();
  if (device && !/^[0-9a-f]{8,32}$/.test(device)) return json({ error: "Bad device serial." }, 400);
  if (!device && !SITE_RE.test(key)) return json({ error: "Bad screen address." }, 400);

  const apiKey = process.env.GOOGLE_ROUTES_KEY;
  if (!apiKey) return json({ off: "not set up" });              // before any database call

  let claim;
  try {
    claim = await rpc("traffic_claim", { p_key: device ? null : key, p_device: device || null });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
  if (claim?.off) return json({ off: claim.off });
  if (claim?.wait) return json({ wait: claim.wait });

  const destinations = (claim.destinations || []).filter((d) => d && (d.address || d.label)).slice(0, 3);
  try {
    const res = await fetch(ROUTES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELDS },
      body: JSON.stringify({
        origins: [waypoint(claim.origin || {})],
        destinations: destinations.map((d) => waypoint({ address: d.address || d.label })),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
      }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const why = body?.error?.message || body?.[0]?.error?.message || `Google answered ${res.status}`;
      return json({ error: `Travel times unavailable: ${why}` }, 502);
    }
    return json({ times: toTimes(destinations, body), at: new Date().toISOString(), source: "Google Maps" });
  } catch (e) {
    return json({ error: `Travel times unavailable: ${e.message}` }, 502);
  }
};

export const config = { path: "/api/traffic" };
