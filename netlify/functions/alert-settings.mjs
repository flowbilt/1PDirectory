// /api/alert-settings: who gets alert emails, and a test email (supabase/12-alerts.sql). 1Point only.
//   GET                                                            recipients, and how mail is sent (no passwords)
//   POST {action:"save", id?, email, name, offline, power, hot, enabled}
//   POST {action:"delete", id}
//   POST {action:"test", email?}   one test email now, to email or to every enabled recipient; {ok} or {ok:false, error}
//   POST {action:"mail-save", host, port, secure, user, password?, from_address, from_name}
//        the mail server's sign-in (19-mail.sql). The password is write-only: sealed with SETTINGS_KEY (Netlify only)
//        before it's stored, never sent back; left empty, the saved one is kept. Wins over Netlify's SMTP_* variables.
//   POST {action:"mail-clear"}     forget the console's mail server: Netlify's SMTP_* variables are used again
import { json } from "../lib/common.mjs";
import { audit, caller, db, enc } from "../lib/sb.mjs";
import { seal } from "../lib/secret.mjs";
import { deliver, savedMail, senderInfo } from "./alerts.mjs";

const HOST = /^[A-Za-z0-9.-]{1,253}$/;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const fail = (status, error) => Object.assign(new Error(error), { status });

export default async (req, context, { tlsOptions } = {}) => {
  try {
    const { user, profile } = await caller(req);
    if (profile.role !== "platform_admin") throw fail(403, "Only 1Point can manage alert emails.");
    if (req.method === "GET") {
      const recipients = await db("alert_recipients?select=id,email,name,offline,power,hot,enabled,updated_at&order=email.asc");
      return json({ recipients, sender: await senderInfo() });
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
    if (body.action === "mail-save") {
      const host = String(body.host || "").trim().toLowerCase();
      if (!HOST.test(host)) throw fail(400, "Enter the mail server's name, e.g. secure.emailsrvr.com.");
      const secure = body.secure !== false;
      const port = body.port === "" || body.port == null ? (secure ? 465 : 587) : Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail(400, "The port is a number, usually 465 (ticked) or 587.");
      const username = String(body.user || "").trim();
      if (!username || username.length > 254) throw fail(400, "Enter the sign-in name (usually the full email address).");
      const fromAddress = String(body.from_address || "").trim();
      if (!EMAIL.test(fromAddress) || /[<>]/.test(fromAddress)) throw fail(400, "The from address doesn't look like an email address.");
      const fromName = String(body.from_name || "").replace(/[<>"\r\n]/g, "").trim().slice(0, 80);
      const password = String(body.password ?? "");
      const existing = await savedMail();
      if (!password && !existing) throw fail(400, "Enter the mail server's password.");
      const row = { id: true, host, port, secure, username, from_address: fromAddress, from_name: fromName,
                    password_enc: password ? seal(password) : existing.password_enc, updated_at: new Date().toISOString(), updated_by: user.id };
      await db("mail_settings?on_conflict=id", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: row });
      await audit(user.id, "set alert mail server", "mail_settings", null, { host, port, secure, user: username, from: fromAddress, password_changed: !!password });
      return json({ ok: true, sender: await senderInfo() });
    }
    if (body.action === "mail-clear") {
      await db("mail_settings?id=eq.true", { method: "DELETE", prefer: "return=minimal" });
      await audit(user.id, "remove alert mail server", "mail_settings", null);
      return json({ ok: true, sender: await senderInfo() });
    }
    if (body.action === "test") {
      let to;
      if (body.email) {
        to = [String(body.email).trim()];
        if (!EMAIL.test(to[0])) throw fail(400, "That doesn't look like an email address.");
      } else {
        to = (await db("alert_recipients?select=email&enabled=is.true")).map((r) => r.email);
        if (!to.length) to = (await senderInfo()).fallbackTo;
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
