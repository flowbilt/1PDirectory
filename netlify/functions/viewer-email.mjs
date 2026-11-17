// /api/viewer-email (DP-15, V5b): the viewer's Email Me a Copy. Public, like /api/viewer: a visitor of "See Your
// WayTuGo in Action" asks for their preview picture by email.
//   GET                         {enabled}: whether 1Point has turned it on (the console's Viewer tab)
//   POST {visit, email, image, website}
//        image: the picture the visitor's browser made (a data: URL, PNG or JPEG, up to about 4.5 MB). It's emailed
//        once through the mail server the alert emails use (Pi setup -> Alert emails, or Netlify's SMTP_*), from the
//        console's Viewer emails settings (55-viewer-email.sql), and not kept; nor is the address (only a one-way
//        fingerprint, for "once an hour to the same address", for two days). "website" is a trap for robots: a person
//        never fills it in. Limits (viewer_email_claim): a visit kept in the last day, 3 a visit, 1 an hour to the
//        same address, the daily limit. Never added to a list, never a sales follow-up (Scot's brief).
import { createHash } from "node:crypto";
import { db, rpc } from "../lib/sb.mjs";
import { sendMail } from "../lib/smtp.mjs";
import { mailConfig } from "./alerts.mjs";
import { isRobot } from "../lib/viewer-device.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const EMAIL_RE = /^[^@\s<>"(),;:\\[\]]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const IMAGE_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+=*)$/;
const VIEWER_PAGE = "https://waytugo.com/waytugo-viewer";
const say = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The console's settings (off when there are none, or before 55 has run) */
export async function viewerEmailSettings() {
  try {
    const row = (await db("viewer_email_settings?select=enabled,from_name,from_address,reply_to,daily_limit,updated_at"))[0];
    return { enabled: false, from_name: "WayTuGo", from_address: null, reply_to: null, daily_limit: 50, updated_at: null, ...(row || {}) };
  } catch { return { enabled: false, from_name: "WayTuGo", from_address: null, reply_to: null, daily_limit: 50, updated_at: null, missing: true }; }
}

/** The address the email goes from: the console's, else the mail server's own */
export function senderOf(settings, cfg) {
  const server = String(cfg.from || "").match(/<([^>]+)>/)?.[1] || cfg.from || "";
  const address = settings.from_address || server;
  return { address, from: address ? `${settings.from_name || "WayTuGo"} <${address}>` : "" };
}

/** The email: the picture attached, the code, the viewer's address, and why they got it */
export function message({ code, name, kind }) {
  const what = kind === "menu" ? "menu board" : "directory";
  const subject = `Your WayTuGo ${what} preview${name ? `: ${name}` : ""}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1b2a2b">
<p>Here's the ${what} preview you made at waytugo.com${name ? ` for <strong>${esc(name)}</strong>` : ""}. The picture is attached.</p>
<p>It's a concept preview with sample content, not a photo of an installed display.</p>
${code ? `<p>Your configuration code is <strong>${esc(code)}</strong>. Mention it if you'd like a quote, and we'll know exactly what you built.</p>` : ""}
<p><a href="${VIEWER_PAGE}?utm_source=viewer_email&amp;utm_medium=email">Build another preview or request a quote</a></p>
<p style="color:#6b7a7b;font-size:13px">You're receiving this because you asked for a copy at waytugo.com. We haven't added your address to any list.<br>WayTuGo, produced by 1PointUSA</p></div>`;
  const text = `Here's the ${what} preview you made at waytugo.com${name ? ` for ${name}` : ""}. The picture is attached.\n\nIt's a concept preview with sample content, not a photo of an installed display.\n\n`
    + `${code ? `Your configuration code is ${code}. Mention it if you'd like a quote.\n\n` : ""}Build another preview or request a quote: ${VIEWER_PAGE}?utm_source=viewer_email&utm_medium=email\n\n`
    + "You're receiving this because you asked for a copy at waytugo.com. We haven't added your address to any list.\nWayTuGo, produced by 1PointUSA\n";
  return { subject, html, text };
}

/** Sends through the configured mail server (or Resend), with the picture attached; throws with the reason */
export async function sendCopy({ to, image, imageType, fileName, code, name, kind, settings, tlsOptions }) {
  const cfg = await mailConfig({ withPassword: true });
  if (!cfg.source) throw new Error("No mail server is set up yet: add one under Pi setup → Alert emails.");
  const { from } = senderOf(settings, cfg);
  if (!from) throw new Error("No from address: set one in the console (Viewer → Viewer emails, or Pi setup → Alert emails).");
  const { subject, html, text } = message({ code, name, kind });
  const replyTo = settings.reply_to || undefined;
  if (cfg.source === "console" || cfg.source === "netlify") {
    return sendMail({ host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: cfg.pass, from, to: [to], replyTo, subject, html, text,
      attachments: [{ name: fileName, type: imageType, data: image }], tlsOptions, timeoutMs: 20000 });
  }
  if (cfg.source === "resend") {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}), attachments: [{ filename: fileName, content: image.toString("base64") }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`Resend: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return true;
  }
  throw new Error("No mail server is set up yet: add one under Pi setup → Alert emails.");
}

const fingerprint = (email) => createHash("sha256").update(`${process.env.SETTINGS_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "waytugo"}|viewer-email|${email.toLowerCase()}`).digest("hex");
const WHY = {
  visit: [400, "This preview has expired. Reload the page and try again."],
  "visit-limit": [429, "That's the most copies for one preview (3)."],
  "address-limit": [429, "A copy went to that address in the last hour. Please check your inbox (and spam folder)."],
  "daily-limit": [429, "We can't send more copies today. Please use Download Image instead."],
  bad: [400, "That doesn't look like an email address."],
};

export default async (req, context, { tlsOptions } = {}) => {
  if (req.method === "GET") return say(200, { enabled: (await viewerEmailSettings()).enabled });
  if (req.method !== "POST") return say(405, { error: "GET or POST." });
  const text = await req.text();
  if (text.length > 6_200_000) return say(413, { error: "The picture is too large to email. Please use Download Image instead." });
  let b; try { b = JSON.parse(text); } catch { return say(400, { error: "Not JSON." }); }
  if (isRobot(req.headers.get("user-agent"))) return say(400, { error: "Not sent." });
  if (b?.website) return say(200, { ok: true });   // the robots' trap: they're told it went
  const email = String(b?.email || "").trim();
  if (email.length > 254 || !EMAIL_RE.test(email)) return say(400, { error: "That doesn't look like an email address." });
  if (!UUID_RE.test(String(b?.visit || ""))) return say(400, { error: "This preview has expired. Reload the page and try again." });
  const m = IMAGE_RE.exec(String(b?.image || ""));
  if (!m) return say(400, { error: "The picture didn't come through. Please try again." });
  const image = Buffer.from(m[2], "base64");
  if (image.length > 4_600_000) return say(413, { error: "The picture is too large to email. Please use Download Image instead." });
  const settings = await viewerEmailSettings();
  if (!settings.enabled) return say(403, { error: "Email isn't available right now. Please use Download Image instead." });
  let why;
  try { why = await rpc("viewer_email_claim", { p_visit: b.visit, p_hash: fingerprint(email), p_limit: settings.daily_limit }); }
  catch { return say(503, { error: "Couldn't send just now. Please try again in a minute." }); }
  if (why) { const [status, error] = WHY[why] || [400, "Not sent."]; return say(status, { error }); }
  const kind = b.kind === "menu" ? "menu" : "directory";
  const name = String(b.name || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 80);
  const code = /^[0-9A-F]{8}$/.test(String(b.code || "")) ? b.code : String(b.visit).slice(0, 8).toUpperCase();
  const fileName = String(b.fileName || "").match(/^waytugo-[a-z0-9-]{1,60}\.(png|jpg)$/) ? b.fileName : `waytugo-preview.${m[1] === "png" ? "png" : "jpg"}`;
  try {
    await sendCopy({ to: email, image, imageType: `image/${m[1]}`, fileName, code, name, kind, settings, tlsOptions });
    return say(200, { ok: true });
  } catch (e) {
    console.log("viewer email failed:", e.message);
    await rpc("viewer_email_release", { p_visit: b.visit, p_hash: fingerprint(email) }).catch(() => {});   // so they can try again
    return say(503, { error: "Couldn't send just now. Please try again in a minute, or use Download Image." });
  }
};

export const config = { path: "/api/viewer-email" };
