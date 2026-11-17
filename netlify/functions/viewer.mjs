// POST /api/viewer: keeps a visit to "See Your WayTuGo in Action" (DP-14, V1), the viewer waytugo.com embeds
// (public/viewer.html). Public: anyone using the viewer sends it, without signing in. It keeps only the visitor's
// choices, how long and how much they built, whether they started or sent a quote, and the page and utm_ words from
// the address; never an IP address or anything about the person. One database call (viewer_record,
// supabase/48-viewer.sql, as 54 has it), which checks everything again and limits how many visits can arrive.
//
// V5 (DP-15): a visit is kept from the moment the page loads (no choices yet: "config": null), with what happened
// ("events", counts), the choices each time the full-screen view opened ("snapshot"), how long the viewer took to start
// ("init_ms"), sends that failed ("failures") and the waytugo.com page load that opened it ("load"). The device and
// browser are worked out here as categories (netlify/lib/viewer-device.mjs); the browser's description isn't kept.
// Crawlers aren't kept at all.
import { rpc } from "../lib/sb.mjs";
import { configProblem, eventsProblem } from "../../public/viewer-sample.mjs";
import { deviceOf, browserOf, isRobot } from "../lib/viewer-device.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_KEYS = ["page", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
const say = (status, body) => new Response(body ? JSON.stringify(body) : null, { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** The page and the ad's utm_ words, trimmed; anything else dropped */
export function cleanSource(s) {
  const out = {};
  if (!s || typeof s !== "object") return out;
  for (const k of SOURCE_KEYS) {
    const v = typeof s[k] === "string" ? s[k].replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) : "";
    if (v) out[k] = v;
  }
  return out;
}

export default async (req) => {
  if (req.method !== "POST") return say(405, { error: "POST only." });
  const text = await req.text();
  if (text.length > 20000) return say(413, { error: "Too large." });   // V5: the choices and one snapshot
  let b; try { b = JSON.parse(text); } catch { return say(400, { error: "Not JSON." }); }
  if (!b || !UUID_RE.test(String(b.id || ""))) return say(400, { error: "A visit has a code." });
  const ua = req.headers.get("user-agent") || "";
  if (isRobot(ua)) return say(204);   // V5: crawlers and link previews aren't visitors
  // V5: no choices yet means the page has loaded but not drawn anything
  const config = b.config === null || b.config === undefined ? null : b.config;
  const problem = (config && configProblem(config)) || (b.snapshot != null && configProblem(b.snapshot)) || eventsProblem(b.events);
  if (problem) return say(400, { error: problem });
  if (config === null && !b.events) return say(400, { error: "A visit has its choices or its events." });
  if (b.load != null && !UUID_RE.test(String(b.load))) return say(400, { error: "A page load has a code." });
  const int = (v, max) => Math.min(max, Math.max(0, Math.round(Number(v) || 0)));
  const quote = b.quote === "started" || b.quote === "sent" ? b.quote : null;
  try {
    await rpc("viewer_record", { p_id: b.id, p_config: config, p_seconds: int(b.seconds, 7200), p_changes: int(b.changes, 10000), p_quote: quote, p_source: cleanSource(b.source),
      p_events: b.events || null, p_snapshot: b.snapshot || null, p_device: deviceOf(ua), p_browser: browserOf(ua),
      p_init_ms: b.init_ms == null ? null : int(b.init_ms, 600000), p_failures: int(b.failures, 10000), p_load: b.load || null });
    return say(204);
  } catch (e) {
    return say(e.status === 400 || e.status === 409 ? 400 : 503, { error: "Not kept." });   // the visitor's page carries on either way (and counts it)
  }
};

export const config = { path: "/api/viewer" };
