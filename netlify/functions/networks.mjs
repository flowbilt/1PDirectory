// /api/networks: the Wi-Fi networks every prepared card carries, and the codes that let a bench Pi download
// them (supabase/08-networks.sql). 1Point only, except "prepare", which the bench Pi calls with its code.
//   GET                                                   the networks, without passwords
//   POST {action:"save", id?, label, ssid, psk?, hidden}   add, or edit (psk left out = keep the saved one)
//   POST {action:"delete", id}
//   POST {action:"code"}                                  a one-hour, single-use prepare code, shown once
//   POST {action:"prepare", code}                         (no sign-in) the bench Pi: every network, with passwords
import { createHash, randomInt } from "node:crypto";
import { json } from "../lib/common.mjs";
import { audit, caller, db, enc } from "../lib/sb.mjs";

export const CODE_MINUTES = 60;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";            // no 0/O or 1/I, so it reads off a screen
const sha = (s) => createHash("sha256").update(s).digest("hex");
const fail = (status, error) => Object.assign(new Error(error), { status });
/** "abcd efgh", "ABCD-EFGH" and "abcdefgh" are the same code. */
export const normalCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function newCode() {
  const c = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

function clean(body) {
  const ssid = String(body.ssid ?? "").trim();
  const label = String(body.label ?? "").trim().slice(0, 80);
  if (!ssid || Buffer.byteLength(ssid) > 32) throw fail(400, "The network name must be 1 to 32 characters.");
  const out = { label, ssid, hidden: !!body.hidden };
  if (body.psk !== undefined && body.psk !== null) {
    const psk = String(body.psk);
    if (psk !== "" && (psk.length < 8 || psk.length > 63)) throw fail(400, "A Wi-Fi password is 8 to 63 characters (leave it empty for an open network).");
    out.psk = psk;
  }
  return out;
}

export default async (req) => {
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      // The bench Pi: no sign-in, just the code 1Point read off the console
      if (body.action === "prepare") {
        const code = normalCode(body.code);
        if (code.length !== 8) throw fail(400, "That doesn't look like a prepare code.");
        const now = new Date().toISOString();
        const [row] = await db(`prepare_codes?code_hash=eq.${sha(code)}&select=id,expires_at,used_at`);
        if (!row || row.used_at || row.expires_at < now) throw fail(403, "That prepare code isn't valid. Codes last an hour and work once; get a new one in the console (Pi setup).");
        // Mark it used first, only if nobody else just did, so a code works exactly once
        const used = await db(`prepare_codes?id=eq.${row.id}&used_at=is.null`, { method: "PATCH", prefer: "return=representation", body: { used_at: now } });
        if (!used?.length) throw fail(403, "That prepare code has already been used.");
        const networks = await db("wifi_networks?select=label,ssid,psk,hidden&order=sort.asc,label.asc,ssid.asc");
        await audit(null, "prepare card", "prepare_code", null, { networks: networks.length });
        return json({ networks });
      }
      const { user, profile } = await caller(req);
      if (profile.role !== "platform_admin") throw fail(403, "Only 1Point can manage Pi setup.");

      if (body.action === "code") {
        const code = newCode();
        const expires_at = new Date(Date.now() + CODE_MINUTES * 60_000).toISOString();
        await db("prepare_codes", { method: "POST", prefer: "return=minimal", body: { code_hash: sha(normalCode(code)), expires_at, created_by: user.id } });
        await audit(user.id, "prepare code", "prepare_code", null, { expires_at });
        return json({ code, expires_at });
      }
      if (body.action === "save") {
        const row = clean(body);
        if (body.id) {
          await db(`wifi_networks?id=eq.${enc(body.id)}`, { method: "PATCH", prefer: "return=minimal", body: { ...row, updated_at: new Date().toISOString(), updated_by: user.id } });
        } else {
          if (row.psk === undefined) row.psk = "";
          await db("wifi_networks", { method: "POST", prefer: "return=minimal", body: { ...row, updated_by: user.id } });
        }
        await audit(user.id, body.id ? "edit wifi" : "add wifi", "wifi_network", body.id || null, { ssid: row.ssid, label: row.label, password_changed: row.psk !== undefined });
        return json({ ok: true });
      }
      if (body.action === "delete") {
        if (!body.id) throw fail(400, "id is required.");
        await db(`wifi_networks?id=eq.${enc(body.id)}`, { method: "DELETE", prefer: "return=minimal" });
        await audit(user.id, "remove wifi", "wifi_network", body.id);
        return json({ ok: true });
      }
      throw fail(400, "Unknown action.");
    }
    if (req.method !== "GET") throw fail(405, "Method not allowed.");
    const { profile } = await caller(req);
    if (profile.role !== "platform_admin") throw fail(403, "Only 1Point can manage Pi setup.");
    const rows = await db("wifi_networks?select=id,label,ssid,psk,hidden,updated_at&order=sort.asc,label.asc,ssid.asc");
    // Passwords never leave the server here; the console only learns whether one is saved
    return json({ networks: rows.map(({ psk, ...r }) => ({ ...r, has_password: !!psk })) });
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
};

export const config = { path: "/api/networks" };
