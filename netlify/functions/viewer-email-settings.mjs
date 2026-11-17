// /api/viewer-email-settings (DP-15, V5b): the console's Viewer → Viewer emails (55-viewer-email.sql). 1Point only.
//   GET                     the settings, and the mail server they go through (no passwords)
//   POST {action:"save", enabled, from_name, from_address, reply_to, daily_limit}
//        from_address empty: the mail server's own (Pi setup → Alert emails). Kept in the database, so nothing is
//        edited in Netlify. With Gmail, the From address must be the Gmail account itself or a "Send mail as" address
//        set up in Gmail; Gmail puts the account's own address on anything else.
//   POST {action:"test", email}   a test copy now (a small sample picture), to that address
import { json } from "../lib/common.mjs";
import { audit, caller, db } from "../lib/sb.mjs";
import { senderInfo, mailConfig } from "./alerts.mjs";
import { viewerEmailSettings, sendCopy, senderOf, EMAIL_RE } from "./viewer-email.mjs";

const fail = (status, error) => Object.assign(new Error(error), { status });
// a small sample picture for the test email (WayTuGo's dark teal, 2 × 2)
const SAMPLE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGPgU1DkU1BkgFAACGYBPZUHEw8AAAAASUVORK5CYII=", "base64");

async function info() {
  const settings = await viewerEmailSettings(), sender = await senderInfo();
  let from = "";
  try { from = senderOf(settings, await mailConfig()).from; } catch { /* shown as not set */ }
  return { settings, sender, from, gmail: /(^|\.)gmail\.com$|googlemail\.com$/i.test(sender.host || "") };
}

export default async (req, context, { tlsOptions } = {}) => {
  try {
    const { user, profile } = await caller(req);
    if (profile.role !== "platform_admin") throw fail(403, "Only 1Point can manage viewer emails.");
    if (req.method === "GET") return json(await info());
    if (req.method !== "POST") throw fail(405, "Method not allowed.");
    const body = await req.json().catch(() => ({}));
    if (body.action === "save") {
      const addr = (v, what) => {
        const a = String(v ?? "").trim();
        if (!a) return null;
        if (a.length > 254 || !EMAIL_RE.test(a)) throw fail(400, `The ${what} doesn't look like an email address.`);
        return a;
      };
      const limit = body.daily_limit === "" || body.daily_limit == null ? 50 : Number(body.daily_limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw fail(400, "The daily limit is a number from 1 to 500.");
      const row = { id: true, enabled: body.enabled === true, from_name: String(body.from_name ?? "").replace(/[<>"\r\n]/g, "").trim().slice(0, 80) || "WayTuGo",
        from_address: addr(body.from_address, "From address"), reply_to: addr(body.reply_to, "Reply-to address"), daily_limit: limit,
        updated_at: new Date().toISOString(), updated_by: user.id };
      await db("viewer_email_settings?on_conflict=id", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: row });
      await audit(user.id, "set viewer emails", "viewer_email_settings", null, { enabled: row.enabled, from_name: row.from_name, from_address: row.from_address, reply_to: row.reply_to, daily_limit: limit });
      return json({ ok: true, ...(await info()) });
    }
    if (body.action === "test") {
      const to = String(body.email || "").trim();
      if (!EMAIL_RE.test(to)) throw fail(400, "That doesn't look like an email address.");
      try {
        await sendCopy({ to, image: SAMPLE, imageType: "image/png", fileName: "waytugo-test.png", code: "TEST0000", name: "Test copy", kind: "directory", settings: await viewerEmailSettings(), tlsOptions });
        await audit(user.id, "test viewer email", "viewer_email_settings", null, { to });
        return json({ ok: true, to });
      } catch (e) { return json({ ok: false, to, error: e.message }); }
    }
    throw fail(400, "Unknown action.");
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
};

export const config = { path: "/api/viewer-email-settings" };
