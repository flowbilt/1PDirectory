// POST /api/viewer: keeps a visit to "See Your WayTuGo in Action" (DP-14, V1), the viewer waytugo.com embeds
// (public/viewer.html). Public: anyone using the viewer sends it, without signing in. It keeps only the visitor's
// choices, how long and how much they built, whether they started or sent a quote, and the page and utm_ words from
// the address; never an IP address or anything about the person. One database call (viewer_record,
// supabase/48-viewer.sql), which checks everything again and limits how many visits can arrive.
import { rpc } from "../lib/sb.mjs";
import { configProblem } from "../../public/viewer-sample.mjs";

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
  if (text.length > 8000) return say(413, { error: "Too large." });
  let b; try { b = JSON.parse(text); } catch { return say(400, { error: "Not JSON." }); }
  if (!b || !UUID_RE.test(String(b.id || ""))) return say(400, { error: "A visit has a code." });
  const problem = configProblem(b.config);
  if (problem) return say(400, { error: problem });
  const int = (v, max) => Math.min(max, Math.max(0, Math.round(Number(v) || 0)));
  const quote = b.quote === "started" || b.quote === "sent" ? b.quote : null;
  try {
    await rpc("viewer_record", { p_id: b.id, p_config: b.config, p_seconds: int(b.seconds, 7200), p_changes: int(b.changes, 10000), p_quote: quote, p_source: cleanSource(b.source) });
    return say(204);
  } catch (e) {
    return say(e.status === 400 || e.status === 409 ? 400 : 503, { error: "Not kept." });   // the visitor's page carries on either way
  }
};

export const config = { path: "/api/viewer" };
