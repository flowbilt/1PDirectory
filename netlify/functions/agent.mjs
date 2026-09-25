// POST /api/agent  — the Pi's agent checks in here every minute.
//   Headers: Authorization: Bearer <this Pi's own key>
//   Body:    {serial, model, hostname, version, health:{...}, screenshot?:"data:image/jpeg;base64,...", results?:[{id,status,result}]}
//   Reply:   {screen, commands:[{id,command}], screenshot_every}
//
// Enrollment: the first check-in from a serial sets that Pi's key (stored hashed). After that the same key is
// required; a different key is refused until a 1Point admin resets it in the console. Pis listed in the Yodeck
// report are pre-registered and matched to their screens by serial, so they attach themselves on first boot.
import { createHash } from "node:crypto";
import { json } from "../lib/common.mjs";
import { rpc } from "../lib/sb.mjs";

export const SERIAL_RE = /^[0-9a-f]{8,32}$/;
export const COMMANDS = ["reboot", "reload", "screenshot", "update_agent"];
const MAX_SHOT = 400_000; // ~300 KB JPEG
const sha = (s) => createHash("sha256").update(s).digest("hex");
/** Today's date in Central time, e.g. "2026-09-24": the daily summary's day. */
export const centralDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);

const clip = (v, n) => String(v ?? "").slice(0, n);

// Keep only the health fields we understand, as numbers/booleans/short strings.
function cleanHealth(h) {
  h = h && typeof h === "object" ? h : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    temp_c: num(h.temp_c), uptime_s: num(h.uptime_s), load: num(h.load),
    mem_used_pct: num(h.mem_used_pct), disk_used_pct: num(h.disk_used_pct),
    throttled: clip(h.throttled, 12), under_voltage_now: !!h.under_voltage_now, under_voltage_seen: !!h.under_voltage_seen,
    throttled_now: !!h.throttled_now, browser_running: h.browser_running !== false,
    ip: clip(h.ip, 45), os: clip(h.os, 80), display: clip(h.display, 40),
  };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Body must be valid JSON." }, 400); }
  const serial = String(body?.serial || "").toLowerCase();
  const key = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!SERIAL_RE.test(serial)) return json({ error: "Bad serial." }, 400);
  if (key.length < 24) return json({ error: "Missing device key." }, 401);

  const shot = body.screenshot;
  const goodShot = typeof shot === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(shot) && shot.length <= MAX_SHOT;
  const results = (Array.isArray(body.results) ? body.results.slice(0, 20) : [])
    .filter((r) => Number.isInteger(Number(r?.id)))
    .map((r) => ({ id: Number(r.id), status: r.status === "done" ? "done" : "failed", result: clip(r.result, 500) }));

  try {
    // Everything happens in one database call (supabase/05-tuning.sql): enrollment, health, the daily summary,
    // command results, expiring old commands and handing over new ones.
    const r = await rpc("agent_checkin", {
      p_serial: serial,
      p_key_hash: sha(key),
      p_info: { model: clip(body.model, 80), hostname: clip(body.hostname, 64), version: clip(body.version, 20) },
      p_health: cleanHealth(body.health),
      p_screenshot: goodShot ? shot : null,
      p_results: results,
    });
    if (r?.refused === "key") return json({ error: "This Pi's key doesn't match. A 1Point admin can reset it in the console." }, 401);
    if (r?.refused === "revoked") return json({ error: "This device has been switched off in the console." }, 403);
    return json({ screen: r?.screen || null, commands: (r?.commands || []).filter((c) => COMMANDS.includes(c.command)), screenshot_every: 300 });
  } catch (e) {
    return json({ error: e.message }, e.status && e.status < 500 ? e.status : 502);
  }
};

export const config = { path: "/api/agent" };
