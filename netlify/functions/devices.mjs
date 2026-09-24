// /api/devices — the console's view of the Pis. 1Point only: Pi health is a 1Point service tool,
// and owner users never see it (the server refuses them, not just the console).
//   GET                          all devices, with health and recent commands
//   GET ?summary=1               fleet health: uptime today / 7 / 30 days, power dips, peak temperature
//   GET ?screenshot=<device id>  the latest screenshot (JPEG)
//   POST {action:"command", device_id, command}       reboot | reload | screenshot | update_agent
//   POST {action:"identify", screen_id}               flash the screen's name on the TV for 90 seconds
//   POST {action:"assign", device_id, screen_id|null} which screen this Pi drives (1Point only)
//   POST {action:"reset_key" | "revoke" | "activate", device_id}  (1Point only)
import { json } from "../lib/common.mjs";
import { audit, caller, db, enc } from "../lib/sb.mjs";
import { COMMANDS, centralDay } from "./agent.mjs";

const ONLINE_MIN = 15;
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
    if (profile.role !== "platform_admin") throw fail(403, "Only 1Point can see device health.");
    const admin = true;
    const url = new URL(req.url);
    const screens = await visibleScreens(profile);

    if (req.method === "GET" && url.searchParams.get("screenshot")) {
      const d = await loadDevice(url.searchParams.get("screenshot"), profile, screens);
      const [row] = await db(`devices?id=eq.${d.id}&select=screenshot,screenshot_at`);
      const m = (row?.screenshot || "").match(/^data:image\/jpeg;base64,(.+)$/);
      if (!m) return json({ error: "No screenshot yet." }, 404);
      return new Response(Buffer.from(m[1], "base64"), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" } });
    }

    if (req.method === "GET" && url.searchParams.get("summary")) return json(await summary());

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
      await db("device_commands", { method: "POST", prefer: "return=minimal", body: { device_id: d.id, command: body.command, created_by: user.id } });
      await audit(user.id, `device ${body.command}`, "device", d.id, { serial: d.serial });
      return json({ ok: true, queued: body.command });
    }

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

// ── Fleet health summary ──
// Uptime = check-ins / minutes the Pi should have been checking in (one a minute), counted from its first day
// of history so a newly installed Pi isn't marked down for days before it existed.
const DAY_MS = 86400_000;
const shiftDay = (day, n) => new Date(Date.parse(day + "T12:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);

export function computeSummary({ devices, daily, screens, dirs, props, orgs, now = Date.now() }) {
  const today = centralDay(new Date(now));
  // minutes elapsed today in Central time
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const minutesToday = Math.max(1, Number(parts.hour) * 60 + Number(parts.minute));
  // minutes into its Central day at which a timestamp falls (for a Pi's very first day)
  const minuteOfDay = (iso) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return Number(p.hour) * 60 + Number(p.minute);
  };
  const range = (n) => Array.from({ length: n }, (_, i) => shiftDay(today, -i));
  const pct = (x) => (x === null ? null : Math.round(x * 1000) / 10);

  const rows = devices.map((d) => {
    const mine = daily.filter((r) => r.device_id === d.id);
    const firstRow = [...mine].sort((a, b) => a.day.localeCompare(b.day))[0];
    const firstDay = firstRow?.day || null;
    // On its first day a Pi is only expected from its first check-in, not from midnight
    const dayMinutes = (day) => {
      const full = day === today ? minutesToday : 1440;
      if (day !== firstDay || !firstRow?.first_at) return full;
      return Math.max(1, full - minuteOfDay(firstRow.first_at));
    };
    const stat = (n) => {
      const days = range(n).filter((day) => firstDay && day >= firstDay);
      if (!days.length) return { uptime: null, dips: 0, browserDown: 0, maxTemp: null };
      const expected = days.reduce((m, day) => m + dayMinutes(day), 0);
      const inRange = mine.filter((r) => days.includes(r.day));
      const checkins = inRange.reduce((m, r) => m + r.checkins, 0);
      const temps = inRange.map((r) => r.max_temp_c).filter((t) => typeof t === "number");
      return {
        uptime: pct(Math.min(1, checkins / expected)),
        dips: inRange.reduce((m, r) => m + r.power_dips, 0),
        browserDown: inRange.reduce((m, r) => m + r.browser_down, 0),
        maxTemp: temps.length ? Math.max(...temps) : null,
      };
    };
    const s = screens.find((x) => x.id === d.screen_id);
    const dir = s && dirs.find((x) => x.id === s.directory_id);
    const prop = dir && props.find((x) => x.id === dir.property_id);
    const org = prop && orgs.find((x) => x.id === prop.org_id);
    const h = d.last_health || {};
    const online = !!d.last_seen && now - Date.parse(d.last_seen) <= ONLINE_MIN * 60000;
    const d1 = stat(1), d7 = stat(7), d30 = stat(30);
    const problems = [
      !online && d.last_seen ? "offline" : null,
      h.under_voltage_now ? "power low now" : d7.dips ? "power dips this week" : null,
      typeof h.temp_c === "number" && h.temp_c >= 80 ? "hot" : null,
      online && h.browser_running === false ? "browser not running" : null,
      d.status === "revoked" ? "switched off" : null,
    ].filter(Boolean);
    return {
      id: d.id, serial: d.serial, status: d.status, online, last_seen: d.last_seen,
      screen: s ? { id: s.id, name: s.name, key: s.key } : null,
      building: prop?.name || null, account: org?.name || null, org_id: org?.id || null,
      temp_now: typeof h.temp_c === "number" ? h.temp_c : null, power_now: !!h.under_voltage_now,
      browser_running: h.browser_running !== false, ip: h.ip || null, agent_version: d.agent_version || null, model: d.model || null,
      uptime: { d1: d1.uptime, d7: d7.uptime, d30: d30.uptime },
      dips: { d7: d7.dips, d30: d30.dips }, max_temp_7d: d7.maxTemp, browser_down_7d: d7.browserDown,
      history_from: firstDay, problems,
    };
  });
  const measured = rows.filter((r) => r.uptime.d30 !== null);
  return {
    generated_at: new Date(now).toISOString(),
    fleet: {
      devices: rows.length,
      online: rows.filter((r) => r.online).length,
      offline: rows.filter((r) => !r.online && r.last_seen).length,
      never: rows.filter((r) => !r.last_seen).length,
      with_problems: rows.filter((r) => r.problems.length).length,
      uptime_30d: measured.length ? pct(measured.reduce((m, r) => m + r.uptime.d30, 0) / measured.length / 100) : null,
    },
    devices: rows,
  };
}

async function summary() {
  const since = shiftDay(centralDay(), -29);
  const [devices, daily, screens, dirs, props, orgs] = await Promise.all([
    db("devices?select=id,serial,screen_id,status,model,agent_version,last_seen,last_health&order=serial.asc"),
    db(`device_daily?day=gte.${since}&select=device_id,day,checkins,power_dips,browser_down,max_temp_c,first_at`),
    db("screens?select=id,name,key,directory_id"),
    db("directories?select=id,property_id"),
    db("properties?select=id,name,org_id"),
    db("organizations?select=id,name"),
  ]);
  return computeSummary({ devices, daily, screens, dirs, props, orgs });
}
