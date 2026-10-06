// Runs every 10 minutes (Netlify scheduled function). Emails 1Point when a Pi:
//   goes offline (no check-in for 15 minutes) and when it comes back,
//   reports under-voltage (a weak power supply), or runs hot (80°C and up).
// Each problem is emailed once when it starts and once when it clears, never every 10 minutes.
// A Pi's alert state is saved only after the email has actually gone out. So a failed send is retried on the
// next run, and problems that already exist are emailed once when the email settings are first added.
// Needs ALERT_EMAIL_TO (comma-separated) and ALERT_EMAIL_FROM, and a way to send: the company mail server
// (SMTP_HOST, SMTP_PORT 465 or 587, SMTP_USER, SMTP_PASS, e.g. Rackspace) or, if that isn't set, RESEND_API_KEY.
// Without them it only logs.
import { sendMail } from "../lib/smtp.mjs";
import { db, enc, rpc } from "../lib/sb.mjs";

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
  const lines = [], changed = [];
  for (const d of devices) {
    const was = d.alert_state || {};
    const is = evaluate(d, now);
    const s = screens.find((x) => x.id === d.screen_id);
    const name = s ? `${s.name}${s.location_note ? ` (${s.location_note})` : ""}` : d.serial;
    let differs = false;
    for (const k of Object.keys(LABEL)) {
      if (!!was[k] !== is[k]) {
        differs = true;
        const extra = k === "hot" && is.hot ? ` at ${d.last_health.temp_c}°C` : k === "offline" && is.offline ? `; last check-in ${new Date(d.last_seen).toLocaleString("en-US", { timeZone: "America/Chicago" })}` : "";
        lines.push({ kind: k, problem: is[k], text: `${name} ${LABEL[k][is[k] ? 0 : 1]}${extra}.` });
      }
    }
    if (differs) changed.push({ id: d.id, state: { ...is, at: new Date(now).toISOString() } });
  }
  if (!lines.length) return { lines, sent: false };
  // Who gets what: the recipients set in the console (Pi setup → Alert emails), each only the kinds they chose,
  // one email per group of recipients who get the same lines; none set there → ALERT_EMAIL_TO gets everything.
  const recipients = await db("alert_recipients?select=email,offline,power,hot&enabled=is.true").catch(() => []);
  let sent = false;
  try {
    if (!recipients.length) sent = (await send(lines)) === true;
    else {
      const groups = new Map();
      for (const r of recipients) {
        const mine = lines.filter((l) => r[l.kind]);
        if (!mine.length) continue;
        const key = mine.map((l) => lines.indexOf(l)).join(",");
        groups.set(key, { lines: mine, to: [...(groups.get(key)?.to || []), r.email] });
      }
      sent = true;                                     // nobody wants these lines: nothing to retry
      for (const g of groups.values()) if ((await send(g.lines, { to: g.to })) !== true) sent = false;
    }
  } catch (e) { console.log("alert email failed:", e.message); }
  if (!sent) return { lines, sent };           // nothing saved: the same lines come round again next run
  for (const c of changed) await db(`devices?id=eq.${enc(c.id)}`, { method: "PATCH", prefer: "return=minimal", body: { alert_state: c.state } });
  return { lines, sent };
}

/** How alert email is sent, for the console (no passwords): {via: "mail server" | "Resend" | null, server, from, fallbackTo}. */
export function senderInfo() {
  const { RESEND_API_KEY, ALERT_EMAIL_TO, ALERT_EMAIL_FROM, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  const via = SMTP_HOST && SMTP_USER && SMTP_PASS ? "mail server" : RESEND_API_KEY ? "Resend" : null;
  return { via, server: via === "mail server" ? `${SMTP_HOST}:${Number(SMTP_PORT) || 587}` : via === "Resend" ? "api.resend.com" : null,
           from: ALERT_EMAIL_FROM || null, fallbackTo: (ALERT_EMAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean) };
}

/** Returns true only when the mail server (or Resend) accepted the email. to: recipients (default ALERT_EMAIL_TO). */
export async function sendEmail(lines, opts = {}) {
  try { return await deliver(lines, opts); }
  catch (e) { if (!e.quiet) console.log(`alert email failed${e.via ? ` (${e.via})` : ""}:`, e.message); return false; }
}

/** Sends, or throws with the reason (the console's "Send test email" shows it). */
export async function deliver(lines, { to: toList, tlsOptions, subject: subjectOverride } = {}) {
  const { RESEND_API_KEY: key, ALERT_EMAIL_FROM: from, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  const smtp = SMTP_HOST && SMTP_USER && SMTP_PASS;
  const recipientsIn = toList?.length ? toList : senderInfo().fallbackTo;
  if (!smtp && !key) { console.log("alerts (email not configured):", lines.map((l) => l.text)); throw Object.assign(new Error("No mail server is set up in Netlify (SMTP_HOST, SMTP_USER, SMTP_PASS)."), { quiet: true }); }
  if (!from) throw new Error("ALERT_EMAIL_FROM isn't set in Netlify.");
  if (!recipientsIn.length) throw new Error("Nobody to send to: add a recipient under Alert emails.");
  const problems = lines.filter((l) => l.problem).length;
  const subject = subjectOverride || (problems ? `Directory screens: ${problems} problem${problems === 1 ? "" : "s"}` : "Directory screens: back to normal");
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const html = `<p>${lines.map((l) => `${l.problem ? "⚠️" : "✅"} ${esc(l.text)}`).join("<br>")}</p><p><a href="${process.env.URL || ""}/console.html">Open the console</a></p>`;
  const recipients = recipientsIn;
  if (smtp) {
    try { return await sendMail({ host: SMTP_HOST, port: Number(SMTP_PORT) || 587, user: SMTP_USER, pass: SMTP_PASS, from, to: recipients, subject, html, tlsOptions }); }
    catch (e) { throw Object.assign(e, { via: "mail server" }); }
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: recipients, subject, html }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${(await r.text()).slice(0, 200)}`), { via: "Resend" });
  return true;
}

export default async () => {
  try { await runAlerts(); } catch (e) { console.log("alert check failed:", e.message); }
  // Keep 400 days of daily health history and 90 days of Pi actions (each Pi's latest five always stay):
  // 17-hardening.sql. Checked each run; deletes nothing most of the time.
  try { await rpc("trim_device_history", {}); } catch (e) { console.log("history trim failed:", e.message); }
};

export const config = { schedule: "*/10 * * * *" };
