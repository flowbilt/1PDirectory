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
import { db, enc } from "../lib/sb.mjs";

export const SERIAL_RE = /^[0-9a-f]{8,32}$/;
export const COMMANDS = ["reboot", "reload", "screenshot", "update_agent"];
const MAX_SHOT = 400_000; // ~300 KB JPEG
const sha = (s) => createHash("sha256").update(s).digest("hex");
/** Today's date in Central time, e.g. "2026-09-24": the daily summary's day. */
export const centralDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);

/** Adds this check-in to the Pi's summary for the day. Never blocks the check-in itself. */
export async function recordDaily(deviceId, health, nowIso) {
  try {
    const day = centralDay(new Date(nowIso));
    const [row] = await db(`device_daily?device_id=eq.${deviceId}&day=eq.${day}&select=id,checkins,power_dips,browser_down,max_temp_c`);
    const temp = typeof health.temp_c === "number" ? health.temp_c : null;
    if (row) {
      await db(`device_daily?id=eq.${row.id}`, { method: "PATCH", prefer: "return=minimal", body: {
        checkins: row.checkins + 1,
        power_dips: row.power_dips + (health.under_voltage_now ? 1 : 0),
        browser_down: row.browser_down + (health.browser_running === false ? 1 : 0),
        max_temp_c: temp === null ? row.max_temp_c : Math.max(row.max_temp_c ?? temp, temp),
        last_at: nowIso,
      } });
    } else {
      await db("device_daily", { method: "POST", prefer: "return=minimal", body: {
        device_id: deviceId, day, checkins: 1, power_dips: health.under_voltage_now ? 1 : 0,
        browser_down: health.browser_running === false ? 1 : 0, max_temp_c: temp, first_at: nowIso, last_at: nowIso,
      } });
    }
  } catch (e) {
    console.log("daily summary not recorded:", e.message);
  }
}
const clip = (v, n) => String(v ?? "").slice(0, n);

// Keep only the health fields we understand, as numbers/booleans/short strings.
function cleanHealth(h = {}) {
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

  try {
    let [dev] = await db(`devices?serial=eq.${enc(serial)}&select=id,screen_id,key_hash,status`);
    if (!dev) {
      [dev] = await db("devices", { method: "POST", prefer: "return=representation", body: { serial, key_hash: sha(key) } });
    } else if (!dev.key_hash) {
      await db(`devices?id=eq.${dev.id}`, { method: "PATCH", prefer: "return=minimal", body: { key_hash: sha(key) } });
    } else if (dev.key_hash !== sha(key)) {
      return json({ error: "This Pi's key doesn't match. A 1Point admin can reset it in the console." }, 401);
    }
    if (dev.status === "revoked") return json({ error: "This device has been switched off in the console." }, 403);

    const now = new Date().toISOString();
    const patch = {
      last_seen: now,
      last_health: cleanHealth(body.health),
      model: clip(body.model, 80), hostname: clip(body.hostname, 64), agent_version: clip(body.version, 20),
    };
    const shot = body.screenshot;
    if (typeof shot === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(shot) && shot.length <= MAX_SHOT) {
      patch.screenshot = shot; patch.screenshot_at = now;
    }
    await db(`devices?id=eq.${dev.id}`, { method: "PATCH", prefer: "return=minimal", body: patch });
    await recordDaily(dev.id, patch.last_health, now);

    // Results of commands this Pi ran
    for (const r of Array.isArray(body.results) ? body.results.slice(0, 20) : []) {
      const id = Number(r?.id);
      if (!Number.isInteger(id)) continue;
      await db(`device_commands?id=eq.${id}&device_id=eq.${dev.id}&status=eq.sent`, {
        method: "PATCH", prefer: "return=minimal",
        body: { status: r.status === "done" ? "done" : "failed", result: clip(r.result, 500), done_at: now },
      });
    }

    // Anything queued over an hour ago is dropped rather than run late (a surprise reboot at 3 p.m. helps no one).
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    await db(`device_commands?device_id=eq.${dev.id}&status=in.(pending,sent)&created_at=lt.${enc(hourAgo)}`, {
      method: "PATCH", prefer: "return=minimal", body: { status: "expired" },
    });
    const pending = await db(`device_commands?device_id=eq.${dev.id}&status=eq.pending&select=id,command&order=id.asc`);
    if (pending.length) {
      await db(`device_commands?id=in.(${pending.map((c) => c.id).join(",")})`, { method: "PATCH", prefer: "return=minimal", body: { status: "sent", sent_at: now } });
    }

    let screen = null;
    if (dev.screen_id) [screen] = await db(`screens?id=eq.${dev.screen_id}&select=key`);
    return json({ screen: screen?.key || null, commands: pending.filter((c) => COMMANDS.includes(c.command)), screenshot_every: 300 });
  } catch (e) {
    return json({ error: e.message }, e.status && e.status < 500 ? e.status : 502);
  }
};

export const config = { path: "/api/agent" };
