// Runs every 10 minutes (Netlify scheduled function). Emails 1Point when a Pi:
//   goes offline (no check-in for 15 minutes) and when it comes back,
//   reports under-voltage (a weak power supply), or runs hot (80°C and up).
// Each problem is emailed once when it starts and once when it clears, never every 10 minutes.
// Needs: RESEND_API_KEY, ALERT_EMAIL_TO (comma-separated), ALERT_EMAIL_FROM. Without them it only records state.
import { db, enc } from "../lib/sb.mjs";

const OFFLINE_MIN = 15;
const HOT_C = 80;

export function evaluate(device, now = Date.now()) {
  const h = device.last_health || {};
  const seen = device.last_seen ? Date.parse(device.last_seen) : 0;
  return {
    offline: !!seen && now - seen > OFFLINE_MIN * 60000,
    power: !!h.under_voltage_now,
    hot: typeof h.temp_c === "number" && h.temp_c >= HOT_C,
  };
}

const LABEL = {
  offline: ["went offline", "is back online"],
  power: ["reports under-voltage (replace the power supply)", "power is normal again"],
  hot: ["is running hot", "has cooled down"],
};

export async function runAlerts({ send = sendEmail, now = Date.now() } = {}) {
  const [devices, screens] = await Promise.all([
    db("devices?select=id,serial,screen_id,last_seen,last_health,alert_state&status=eq.active&screen_id=not.is.null"),
    db("screens?select=id,name,key,location_note"),
  ]);
  const lines = [];
  for (const d of devices) {
    const was = d.alert_state || {};
    const is = evaluate(d, now);
    const s = screens.find((x) => x.id === d.screen_id);
    const name = s ? `${s.name}${s.location_note ? ` (${s.location_note})` : ""}` : d.serial;
    let changed = false;
    for (const k of Object.keys(LABEL)) {
      if (!!was[k] !== is[k]) {
        changed = true;
        const extra = k === "hot" && is.hot ? ` at ${d.last_health.temp_c}°C` : k === "offline" && is.offline ? `; last check-in ${new Date(d.last_seen).toLocaleString("en-US", { timeZone: "America/Chicago" })}` : "";
        lines.push({ problem: is[k], text: `${name} ${LABEL[k][is[k] ? 0 : 1]}${extra}.` });
      }
    }
    if (changed) await db(`devices?id=eq.${enc(d.id)}`, { method: "PATCH", prefer: "return=minimal", body: { alert_state: { ...is, at: new Date(now).toISOString() } } });
  }
  if (lines.length) await send(lines);
  return lines;
}

async function sendEmail(lines) {
  const { RESEND_API_KEY: key, ALERT_EMAIL_TO: to, ALERT_EMAIL_FROM: from } = process.env;
  if (!key || !to || !from) { console.log("alerts (email not configured):", lines.map((l) => l.text)); return; }
  const problems = lines.filter((l) => l.problem).length;
  const subject = problems ? `Directory screens: ${problems} problem${problems === 1 ? "" : "s"}` : "Directory screens: back to normal";
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const html = `<p>${lines.map((l) => `${l.problem ? "⚠️" : "✅"} ${esc(l.text)}`).join("<br>")}</p><p><a href="${process.env.URL || ""}/console.html">Open the console</a></p>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: to.split(",").map((s) => s.trim()).filter(Boolean), subject, html }),
  });
  if (!r.ok) console.log("alert email failed:", r.status, await r.text());
}

export default async () => {
  try { await runAlerts(); } catch (e) { console.log("alert check failed:", e.message); }
  // Keep 400 days of daily health history (checked each run; deletes nothing most of the time)
  try {
    const cutoff = new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10);
    await db(`device_daily?day=lt.${cutoff}`, { method: "DELETE", prefer: "return=minimal" });
  } catch (e) { console.log("history trim failed:", e.message); }
};

export const config = { schedule: "*/10 * * * *" };
