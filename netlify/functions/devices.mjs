// /api/devices — the console's view of the Pis.
//   GET                          devices the caller may see, with health and recent commands
//   GET ?screenshot=<device id>  the latest screenshot (JPEG)
//   POST {action:"command", device_id, command}       reboot | reload | screenshot | update_agent
//   POST {action:"identify", screen_id}               flash the screen's name on the TV for 90 seconds
//   POST {action:"assign", device_id, screen_id|null} which screen this Pi drives (1Point only)
//   POST {action:"reset_key" | "revoke" | "activate", device_id}  (1Point only)
// 1Point admins can do everything. Owner users see their own screens' devices and can reload, screenshot and identify.
import { json } from "../lib/common.mjs";
import { audit, caller, db, enc } from "../lib/sb.mjs";
import { COMMANDS } from "./agent.mjs";

const OWNER_COMMANDS = ["reload", "screenshot"];
const fail = (status, error) => Object.assign(new Error(error), { status });

// Screens (id -> {key, name, org}) the caller may see
async function visibleScreens(profile) {
  const [screens, dirs, props] = await Promise.all([
    db("screens?select=id,key,name,directory_id"),
    db("directories?select=id,property_id"),
    db("properties?select=id,org_id"),
  ]);
  const orgOfDir = Object.fromEntries(dirs.map((d) => [d.id, props.find((p) => p.id === d.property_id)?.org_id]));
  const out = new Map();
  for (const s of screens) {
    const org = orgOfDir[s.directory_id] || null;
    if (profile.role === "platform_admin" || (org && org === profile.org_id)) out.set(s.id, { ...s, org });
  }
  return out;
}

async function loadDevice(id, profile, screens) {
  if (!id) throw fail(400, "device_id is required.");
  const [d] = await db(`devices?id=eq.${enc(id)}&select=id,serial,screen_id,status`);
  if (!d) throw fail(404, "No such device.");
  if (profile.role !== "platform_admin" && !screens.has(d.screen_id)) throw fail(404, "No such device.");
  return d;
}

export default async (req) => {
  try {
    const { user, profile } = await caller(req);
    const admin = profile.role === "platform_admin";
    const url = new URL(req.url);
    const screens = await visibleScreens(profile);

    if (req.method === "GET" && url.searchParams.get("screenshot")) {
      const d = await loadDevice(url.searchParams.get("screenshot"), profile, screens);
      const [row] = await db(`devices?id=eq.${d.id}&select=screenshot,screenshot_at`);
      const m = (row?.screenshot || "").match(/^data:image\/jpeg;base64,(.+)$/);
      if (!m) return json({ error: "No screenshot yet." }, 404);
      return new Response(Buffer.from(m[1], "base64"), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" } });
    }

    if (req.method === "GET") {
      const devices = await db("devices?select=id,serial,screen_id,status,model,hostname,agent_version,last_seen,last_health,screenshot_at,key_hash,created_at&order=serial.asc");
      const mine = devices.filter((d) => admin || screens.has(d.screen_id));
      const ids = mine.map((d) => d.id);
      const cmds = ids.length ? await db(`device_commands?device_id=in.(${ids.join(",")})&select=id,device_id,command,status,result,created_at,done_at&order=id.desc`) : [];
      return json({
        devices: mine.map(({ key_hash, ...d }) => ({
          ...d, enrolled: !!key_hash,
          screen_key: screens.get(d.screen_id)?.key || null,
          commands: cmds.filter((c) => c.device_id === d.id).slice(0, 5),
        })),
      });
    }

    if (req.method !== "POST") throw fail(405, "Method not allowed.");
    const body = await req.json().catch(() => ({}));

    if (body.action === "identify") {
      if (!screens.has(body.screen_id)) throw fail(404, "No such screen.");
      await db(`screens?id=eq.${enc(body.screen_id)}`, { method: "PATCH", prefer: "return=minimal", body: { identify_until: new Date(Date.now() + 90_000).toISOString() } });
      await audit(user.id, "identify", "screen", body.screen_id);
      return json({ ok: true });
    }

    const d = await loadDevice(body.device_id, profile, screens);

    if (body.action === "command") {
      if (!COMMANDS.includes(body.command)) throw fail(400, "Unknown command.");
      if (!admin && !OWNER_COMMANDS.includes(body.command)) throw fail(403, "Only 1Point can do that.");
      await db("device_commands", { method: "POST", prefer: "return=minimal", body: { device_id: d.id, command: body.command, created_by: user.id } });
      await audit(user.id, `device ${body.command}`, "device", d.id, { serial: d.serial });
      return json({ ok: true, queued: body.command });
    }

    if (!admin) throw fail(403, "Only 1Point can do that.");

    if (body.action === "assign") {
      const sid = body.screen_id || null;
      if (sid && !screens.has(sid)) throw fail(404, "No such screen.");
      if (sid) await db(`devices?screen_id=eq.${enc(sid)}&id=neq.${d.id}`, { method: "PATCH", prefer: "return=minimal", body: { screen_id: null } }); // one Pi per screen
      await db(`devices?id=eq.${d.id}`, { method: "PATCH", prefer: "return=minimal", body: { screen_id: sid } });
      await audit(user.id, "assign device", "device", d.id, { serial: d.serial, screen_id: sid });
      return json({ ok: true });
    }
    if (["reset_key", "revoke", "activate"].includes(body.action)) {
      const patch = body.action === "reset_key" ? { key_hash: null } : { status: body.action === "revoke" ? "revoked" : "active" };
      await db(`devices?id=eq.${d.id}`, { method: "PATCH", prefer: "return=minimal", body: patch });
      await audit(user.id, body.action.replace("_", " "), "device", d.id, { serial: d.serial });
      return json({ ok: true });
    }
    throw fail(400, "Unknown action.");
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
};

export const config = { path: "/api/devices" };
