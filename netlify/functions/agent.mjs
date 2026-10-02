// POST /api/agent  — the Pi's agent checks in here every minute.
//   Headers: Authorization: Bearer <this Pi's own key>
//   Body:    {serial, model, hostname, version, health:{...}, screenshot?:"data:image/jpeg;base64,...", results?:[{id,status,result}]}
//   Reply:   {screen, commands:[{id,command,payload?}], screenshot_every}
//
// Enrollment (supabase/06-trust.sql): a Pi's key is stored hashed, and after that the same key is required.
// A registered Pi with no key yet (pre-registered from the Yodeck report, or after Reset device key) accepts its
// first key only while 1Point has opened its enrollment window in the console. A Pi that isn't registered at all
// enrolls on first contact and waits under New devices; no screenshot is kept for it until it's assigned.
import { createHash } from "node:crypto";
import { json } from "../lib/common.mjs";
import { rpc } from "../lib/sb.mjs";

export const SERIAL_RE = /^[0-9a-f]{8,32}$/;
export const COMMANDS = ["reboot", "reload", "screenshot", "update_agent", "update_pi", "wifi_scan", "wifi_join", "remote_on", "remote_off"];
/** The first agent that knows remote_on and remote_off (supabase/16-remote.sql). */
export const REMOTE_AGENT = "1.8.0";
/** The first agent that knows wifi_scan and wifi_join (supabase/13-tech.sql). Older Pis need Update agent first. */
export const WIFI_AGENT = "1.6.0";
/** "1.10.0" >= "1.6.0", compared number by number; "" or junk is older than anything. */
export const agentAtLeast = (have, want) => {
  const a = String(have || "").split(/[.-]/).map(Number), b = want.split(".").map(Number);
  if (!a.length || Number.isNaN(a[0])) return false;
  for (let i = 0; i < b.length; i++) { const x = Number.isFinite(a[i]) ? a[i] : 0; if (x !== b[i]) return x > b[i]; }
  return true;
};
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
    // The TV's power state over HDMI-CEC (agent 1.5.0): on, standby, not-answering, or no-cec (no CEC on this Pi)
    tv: ["on", "standby", "not-answering", "no-cec"].includes(h.tv) ? h.tv : null,
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
    .map((r) => ({ id: Number(r.id), status: r.status === "done" ? "done" : "failed", result: clip(r.result, 4000) }));   // the database keeps 500 (4,000 for a Wi-Fi scan)

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
    if (r?.refused === "enroll") return json({ error: "This Pi isn't enrolled yet. 1Point opens its enrollment window in the console (Pi → Open enrollment)." }, 403);
    if (r?.refused === "revoked") return json({ error: "This device has been switched off in the console." }, 403);
    // A command's payload (a Wi-Fi join's network and password) goes to the Pi as it came from the database,
    // which cleared it in the same call (supabase/13-tech.sql)
    const commands = (r?.commands || []).filter((c) => COMMANDS.includes(c.command))
      .map((c) => (c.payload ? { id: c.id, command: c.command, payload: c.payload } : { id: c.id, command: c.command }));
    return json({ screen: r?.screen || null, commands, screenshot_every: 300 });
  } catch (e) {
    return json({ error: e.message }, e.status && e.status < 500 ? e.status : 502);
  }
};

export const config = { path: "/api/agent" };
