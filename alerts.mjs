// Runs every 10 minutes (Netlify scheduled function). Emails 1Point when a Pi:
//   goes offline (no check-in for 15 minutes) and when it comes back,
//   reports under-voltage (a weak power supply), or runs hot (80°C and up).
// Each problem is emailed once when it starts and once when it clears, never every 10 minutes.
// A Pi's alert state is saved only after the email has actually gone out. So a failed send is retried on the
// next run, and problems that already exist are emailed once when the email settings are first added.
// How it sends (mailConfig): the mail server set in the console (Pi setup → Alert emails; 19-mail.sql, password
// encrypted with SETTINGS_KEY) wins; otherwise Netlify's SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and
// ALERT_EMAIL_FROM; otherwise RESEND_API_KEY. Recipients: the console's list, or ALERT_EMAIL_TO. Without any, it logs.
import { sendMail } from "../lib/smtp.mjs";
import { open, settingsKey } from "../lib/secret.mjs";
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

/** The console's mail server row (19-mail.sql), or null. Never sent anywhere as is: it holds the sealed password. */
export async function savedMail() {
  try { return (await db("mail_settings?select=host,port,secure,username,password_enc,from_address,from_name,updated_at"))[0] || null; }
  catch { return null; }                              // before 19-mail.sql has run: Netlify's settings, as before
}

/**
 * The settings in force. source: "console" | "netlify" | "resend" | null. The password only with withPassword
 * (sending); it throws if the console's saved password can't be opened, so a test email says why.
 */
export async function mailConfig({ withPassword = false } = {}) {
  const { RESEND_API_KEY, ALERT_EMAIL_TO, ALERT_EMAIL_FROM, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  const fallbackTo = (ALERT_EMAIL_TO || "").split(",").map((x) => x.trim()).filter(Boolean);
  const row = await savedMail();
  if (row) {
    const from = row.from_name ? `${row.from_name} <${row.from_address}>` : row.from_address;
    return { source: "console", host: row.host, port: row.port, secure: row.secure, user: row.username, from, fromAddress: row.from_address,
             fromName: row.from_name, updatedAt: row.updated_at, fallbackTo, ...(withPassword ? { pass: open(row.password_enc) } : {}) };
  }
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    const port = Number(SMTP_PORT) || 587;
    return { source: "netlify", host: SMTP_HOST, port, secure: port === 465, user: SMTP_USER, from: ALERT_EMAIL_FROM || null, fallbackTo,
             ...(withPassword ? { pass: SMTP_PASS } : {}) };
  }
  if (RESEND_API_KEY) return { source: "resend", from: ALERT_EMAIL_FROM || null, fallbackTo };
  return { source: null, from: ALERT_EMAIL_FROM || null, fallbackTo };
}

/** How alert email is sent, for the console: never a password. */
export async function senderInfo() {
  const c = await mailConfig();
  return {
    via: c.source === "resend" ? "Resend" : c.source ? "mail server" : null, source: c.source,
    server: c.host ? `${c.host}:${c.port}` : c.source === "resend" ? "api.resend.com" : null,
    host: c.host || "", port: c.port || null, secure: c.secure ?? true, user: c.source === "console" ? c.user : "",
    fromAddress: c.source === "console" ? c.fromAddress : "", fromName: c.source === "console" ? c.fromName : "",
    from: c.from, fallbackTo: c.fallbackTo, updatedAt: c.updatedAt || null,
    keySet: !!settingsKey(), netlifyServer: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
  };
}

/** Returns true only when the mail server (or Resend) accepted the email. to: recipients (default ALERT_EMAIL_TO). */
export async function sendEmail(lines, opts = {}) {
  try { return await deliver(lines, opts); }
  catch (e) { if (!e.quiet) console.log(`alert email failed${e.via ? ` (${e.via})` : ""}:`, e.message); return false; }
}

/** Sends, or throws with the reason (the console's "Send test email" shows it). */
export async function deliver(lines, { to: toList, tlsOptions, subject: subjectOverride } = {}) {
  let cfg;
  try { cfg = await mailConfig({ withPassword: true }); }
  catch (e) { throw Object.assign(e, { via: "mail server" }); }
  const key = process.env.RESEND_API_KEY, from = cfg.from, smtp = cfg.source === "console" || cfg.source === "netlify";
  const recipientsIn = toList?.length ? toList : cfg.fallbackTo;
  if (!smtp && !key) { console.log("alerts (email not configured):", lines.map((l) => l.text)); throw Object.assign(new Error("No mail server is set up yet: add one under Pi setup → Alert emails."), { quiet: true }); }
  if (!from) throw new Error("No from address: add one under Pi setup → Alert emails (or ALERT_EMAIL_FROM in Netlify).");
  if (!recipientsIn.length) throw new Error("Nobody to send to: add a recipient under Alert emails.");
  const problems = lines.filter((l) => l.problem).length;
  const subject = subjectOverride || (problems ? `Directory screens: ${problems} problem${problems === 1 ? "" : "s"}` : "Directory screens: back to normal");
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const html = `<p>${lines.map((l) => `${l.problem ? "⚠️" : "✅"} ${esc(l.text)}`).join("<br>")}</p><p><a href="${process.env.URL || ""}/console.html">Open the console</a></p>`;
  const recipients = recipientsIn;
  if (smtp) {
    try { return await sendMail({ host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: cfg.pass, from, to: recipients, subject, html, tlsOptions }); }
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
