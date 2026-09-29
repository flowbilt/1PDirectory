// /api/alert-settings: who gets alert emails, and a test email (supabase/12-alerts.sql). 1Point only.
//   GET                                                            recipients, and how mail is sent (no passwords)
//   POST {action:"save", id?, email, name, offline, power, hot, enabled}
//   POST {action:"delete", id}
//   POST {action:"test", email?}   one test email now, to email or to every enabled recipient; {ok} or {ok:false, error}
// The mail server's sign-in stays in Netlify's environment variables (SMTP_*), never in the database.
import { json } from "../lib/common.mjs";
import { audit, caller, db, enc } from "../lib/sb.mjs";
import { deliver, senderInfo } from "./alerts.mjs";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const fail = (status, error) => Object.assign(new Error(error), { status });

export default async (req, context, { tlsOptions } = {}) => {
  try {
    const { user, profile } = await caller(req);
    if (profile.role !== "platform_admin") throw fail(403, "Only 1Point can manage alert emails.");
    if (req.method === "GET") {
      const recipients = await db("alert_recipients?select=id,email,name,offline,power,hot,enabled,updated_at&order=email.asc");
      return json({ recipients, sender: senderInfo() });
    }
    if (req.method !== "POST") throw fail(405, "Method not allowed.");
    const body = await req.json().catch(() => ({}));

    if (body.action === "save") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!EMAIL.test(email)) throw fail(400, "That doesn't look like an email address.");
      const row = { email, name: String(body.name || "").trim().slice(0, 80), offline: body.offline !== false, power: body.power !== false,
                    hot: body.hot !== false, enabled: body.enabled !== false, updated_at: new Date().toISOString(), updated_by: user.id };
      const clash = await db(`alert_recipients?email=eq.${enc(email)}&select=id`);
      if (clash.length && clash[0].id !== body.id) throw fail(409, "That address is already on the list.");
      if (body.id) await db(`alert_recipients?id=eq.${enc(body.id)}`, { method: "PATCH", prefer: "return=minimal", body: row });
      else await db("alert_recipients", { method: "POST", prefer: "return=minimal", body: row });
      await audit(user.id, body.id ? "edit alert recipient" : "add alert recipient", "alert_recipient", body.id || null, { email });
      return json({ ok: true });
    }
    if (body.action === "delete") {
      if (!body.id) throw fail(400, "id is required.");
      await db(`alert_recipients?id=eq.${enc(body.id)}`, { method: "DELETE", prefer: "return=minimal" });
      await audit(user.id, "remove alert recipient", "alert_recipient", body.id);
      return json({ ok: true });
    }
    if (body.action === "test") {
      let to;
      if (body.email) {
        to = [String(body.email).trim()];
        if (!EMAIL.test(to[0])) throw fail(400, "That doesn't look like an email address.");
      } else {
        to = (await db("alert_recipients?select=email&enabled=is.true")).map((r) => r.email);
        if (!to.length) to = senderInfo().fallbackTo;
      }
      const who = profile.full_name || profile.email || "1Point";
      try {
        await deliver([{ kind: "test", problem: false, text: `This is a test email from the Lobby Directory console, sent by ${who}. Alert emails come from here.` }],
          { to, subject: "Directory screens: test email", tlsOptions });
        await audit(user.id, "test alert email", "alert_recipient", null, { to });
        return json({ ok: true, to });
      } catch (e) {
        return json({ ok: false, to, error: `${e.via ? `${e.via}: ` : ""}${e.message}` });
      }
    }
    throw fail(400, "Unknown action.");
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
};

export const config = { path: "/api/alert-settings" };
