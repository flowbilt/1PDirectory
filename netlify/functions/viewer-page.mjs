// POST /api/viewer-page (DP-15, V5): waytugo.com's /waytugo-viewer page says it has loaded, before the viewer itself
// loads (the site builder's script; see claude/waytugo-viewer-v5-handoff.md). Kept: a code the page made (it also hands
// it to the viewer as ?load=, so the console can match a page load to its visit), when, the page and utm_ words, and
// the device and browser as categories. A page load with no visit is someone who left before the viewer started, or a
// viewer that failed to load. Sent with navigator.sendBeacon as plain text (no preflight); never an IP address or the
// browser's description. One database call (viewer_page_record, supabase/54-viewer-events.sql).
import { rpc } from "../lib/sb.mjs";
import { cleanSource } from "./viewer.mjs";
import { deviceOf, browserOf, isRobot } from "../lib/viewer-device.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// the same sites that may frame the viewer (netlify.toml)
const ALLOWED = [/^https:\/\/(www\.)?waytugo\.com$/, /^https:\/\/(www\.)?1pointusa\.com$/, /^https:\/\/[a-z0-9-]+(--[a-z0-9-]+)?\.netlify\.app$/, /^http:\/\/localhost(:\d+)?$/];

export default async (req) => {
  const origin = req.headers.get("origin") || "";
  const okOrigin = !origin || ALLOWED.some((re) => re.test(origin));
  const headers = { "Cache-Control": "no-store", ...(origin && okOrigin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}) };
  const say = (status) => new Response(null, { status, headers });
  if (req.method === "OPTIONS") return say(204);
  if (req.method !== "POST") return say(405);
  if (!okOrigin) return say(403);
  const text = await req.text();
  if (text.length > 2000) return say(413);
  let b; try { b = JSON.parse(text); } catch { return say(400); }
  if (!b || !UUID_RE.test(String(b.id || ""))) return say(400);
  const ua = req.headers.get("user-agent") || "";
  if (isRobot(ua)) return say(204);
  try {
    await rpc("viewer_page_record", { p_id: b.id, p_source: cleanSource(b.source), p_device: deviceOf(ua), p_browser: browserOf(ua) });
    return say(204);
  } catch (e) {
    return say(e.status === 400 ? 400 : 503);
  }
};

export const config = { path: "/api/viewer-page" };
