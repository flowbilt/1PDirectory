// /api/devices — the console's view of the Pis. 1Point only: Pi health is a 1Point service tool,
// and owner users never see it (the server refuses them, not just the console).
//   GET                          all devices, with health and recent commands
//   GET ?summary=1               fleet health: uptime today / 7 / 30 days, power dips, peak temperature
//   GET ?screenshot=<device id>  the latest screenshot (JPEG)
//   GET ?hardware=<screen id>    the screen's hardware record (serial, MACs, Yodeck snapshot); signed-in users
//                                can't read that column directly (supabase/06-trust.sql)
//   POST {action:"command", device_id, command}       reboot | reload | screenshot | update_agent | update_pi | wifi_scan
//   POST {action:"command", device_id, command:"wifi_join", ssid, psk, hidden}   join one network (agent 1.6.0+). The
//                                password goes to the Pi once and is then cleared (supabase/13-tech.sql); it's never listed
//   POST {action:"command", device_id, command:"wifi_join", ssid, saved:true}   join a saved network: the server supplies
//                                its password, so the phone never has it (supabase/14-saved-wifi.sql)
//   POST {action:"command", device_id, command:"wifi_join", ssid, psk, hidden, save:true}   the same, and keep the
//                                network for other Pis once this Pi reports the join worked (the technician page's
//                                "Save for other screens"): the database does it at that check-in, so the phone can be
//                                locked or the page closed meanwhile (supabase/20-save-wifi.sql); never put on cards
//   POST {action:"save_network", device_id, ssid, psk, hidden}   the same save, made by the phone after the result
//                                (technician pages from before DP-05 round 6, still open on a phone; kept for them)
//   POST {action:"remove", device_id}                 delete an unassigned Pi's record (New devices); a Pi that's still
//                                running enrolls again at its next check-in
//   POST {action:"layout", screen_id, orientation, restart}  set a screen's layout; restart its Pi so it turns now
//   POST {action:"identify", screen_id}               flash the screen's name on the TV for 90 seconds
//   POST {action:"assign", device_id, screen_id|null} which screen this Pi drives (1Point only)
//   POST {action:"open_enrollment" | "close_enrollment", device_id}  a Pi with no key accepts one only while open
//   POST {action:"reset_key" | "revoke" | "activate", device_id}  reset_key also opens the enrollment window
import { json } from "../lib/common.mjs";
import { audit, caller, db, enc, rpc } from "../lib/sb.mjs";
import { COMMANDS, WIFI_AGENT, REMOTE_AGENT, agentAtLeast, centralDay } from "./agent.mjs";

const ONLINE_MIN = 15;
export const ENROLL_HOURS = 24;
const enrollUntil = () => new Date(Date.now() + ENROLL_HOURS * 3600_000).toISOString();
const fail = (status, error) => Object.assign(new Error(error), { status });
export const LAYOUTS = ["auto", "portrait", "portrait-flipped", "landscape", "landscape-flipped"];

/** A Wi-Fi join's network, checked the way the Pi and NetworkManager will need it. Throws a 400 otherwise. */
export function wifiPayload(body) {
  const ssid = typeof body.ssid === "string" ? body.ssid : "";
  const psk = typeof body.psk === "string" ? body.psk : "";
  if (!ssid || Buffer.byteLength(ssid) > 32 || /[\u0000-\u001f\u007f]/.test(ssid)) throw fail(400, "Choose a network (a name of 1 to 32 characters).");
  if (psk && (psk.length < 8 || psk.length > 63 || /[^\x20-\x7e]/.test(psk))) throw fail(400, "A Wi-Fi password is 8 to 63 characters. Leave it empty for an open network.");
  return { ssid, psk, hidden: body.hidden === true };
}

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
  const [d] = await db(`devices?id=eq.${enc(id)}&select=id,serial,screen_id,status,key_hash,agent_version`);
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

    if (req.method === "GET" && url.searchParams.get("hardware")) {
      const sid = url.searchParams.get("hardware");
      if (!screens.has(sid)) throw fail(404, "No such screen.");
      const [row] = await db(`screens?id=eq.${enc(sid)}&select=hardware`);
      return json({ hardware: row?.hardware || {} });
    }

    if (req.method === "GET" && url.searchParams.get("summary")) return json(await summary());

    if (req.method === "GET") {
      const devices = await db("devices?select=id,serial,screen_id,status,model,hostname,agent_version,last_seen,last_health,screenshot_at,key_hash,enroll_until,refused_at,refused_why,created_at&order=serial.asc");
      const mine = devices.filter((d) => admin || screens.has(d.screen_id));
      const ids = mine.map((d) => d.id);
      // Each Pi's latest five actions, one row per Pi (17-hardening.sql), not every action ever sent
      const recent = ids.length ? await rpc("recent_device_commands", { p_device_ids: ids, p_per: 5 }) : [];
      const cmds = new Map(recent.map((r) => [r.device_id, r.commands || []]));
      return json({
        devices: mine.map(({ key_hash, ...d }) => ({
          ...d, enrolled: !!key_hash,
          screen_key: screens.get(d.screen_id)?.key || null,
          commands: cmds.get(d.id) || [],
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

    // The screen's layout, and (restart) a reboot for its Pi so the picture turns now rather than at its next start
    if (body.action === "layout") {
      if (!screens.has(body.screen_id)) throw fail(404, "No such screen.");
      if (!LAYOUTS.includes(body.orientation)) throw fail(400, "Unknown layout.");
      await db(`screens?id=eq.${enc(body.screen_id)}`, { method: "PATCH", prefer: "return=minimal", body: { orientation: body.orientation } });
      let restarted = false;
      if (body.restart) {
        const [pi] = await db(`devices?screen_id=eq.${enc(body.screen_id)}&select=id,key_hash`);
        if (pi?.key_hash) {
          await db("device_commands", { method: "POST", prefer: "return=minimal", body: { device_id: pi.id, command: "reboot", created_by: user.id } });
          restarted = true;
        }
      }
      await audit(user.id, "layout", "screen", body.screen_id, { orientation: body.orientation, restarted });
      return json({ ok: true, restarted });
    }

    const d = await loadDevice(body.device_id, profile, screens);

    if (body.action === "command") {
      if (!COMMANDS.includes(body.command)) throw fail(400, "Unknown command.");
      if (!d.key_hash) throw fail(409, "This Pi hasn't enrolled yet, so there's nothing to receive that. Open its enrollment window first.");
      const wifi = body.command.startsWith("wifi_");
      if (wifi && !agentAtLeast(d.agent_version, WIFI_AGENT)) throw fail(409, `This Pi's agent (${d.agent_version || "unknown"}) can't do Wi-Fi from here yet. The office can run Update agent on it first (${WIFI_AGENT} or newer).`);
      if (body.command.startsWith("remote_") && !agentAtLeast(d.agent_version, REMOTE_AGENT)) throw fail(409, `This Pi's agent (${d.agent_version || "unknown"}) can't do remote support yet. Run Update agent on it first (${REMOTE_AGENT} or newer).`);
      let payload = null;
      if (body.command === "wifi_join" && body.saved === true) {
        const ssid = typeof body.ssid === "string" ? body.ssid : "";
        const [net] = await db(`wifi_networks?ssid=eq.${enc(ssid)}&select=ssid,psk,hidden&order=updated_at.desc&limit=1`);
        if (!net) throw fail(404, `${ssid || "That network"} isn't saved. Type its password instead.`);
        payload = { ssid: net.ssid, psk: net.psk || "", hidden: !!net.hidden };
      } else if (body.command === "wifi_join") payload = wifiPayload(body);
      // Save for other screens: a second copy that the handover to the Pi doesn't clear, kept until the Pi's result
      // and saved by the database only if the join worked (20-save-wifi.sql). A saved network is already saved.
      const save = body.command === "wifi_join" && body.save === true && body.saved !== true ? payload : null;
      const [row] = await db("device_commands?select=id", { method: "POST", prefer: "return=representation",
        body: { device_id: d.id, command: body.command, created_by: user.id, ...(payload ? { payload } : {}), ...(save ? { save } : {}) } });
      // The audit log names the network, never its password
      await audit(user.id, `device ${body.command}`, "device", d.id, { serial: d.serial, ...(payload ? { ssid: payload.ssid } : {}), ...(save ? { save: true } : {}) });
      return json({ ok: true, queued: body.command, id: row?.id ?? null });
    }

    // Keep a network this Pi has just joined, for other Pis. Only after the Pi reported the join worked, so a
    // mistyped password is never saved. The password comes from the phone that typed it for that join.
    // Since DP-05 round 6 the technician page sends save:true with the join instead and the database saves it; this
    // stays for a page loaded before that deploy and still open on a phone.
    if (body.action === "save_network") {
      const net = wifiPayload(body);
      const since = new Date(Date.now() - 15 * 60_000).toISOString();
      const joined = await db(`device_commands?device_id=eq.${d.id}&command=eq.wifi_join&status=eq.done&done_at=gte.${enc(since)}&select=result`);
      if (!joined.some((c) => String(c.result).startsWith(`Joined ${net.ssid};`)))
        throw fail(409, `This Pi hasn't joined ${net.ssid} in the last 15 minutes, so it wasn't saved. Join it first.`);
      const [have] = await db(`wifi_networks?ssid=eq.${enc(net.ssid)}&select=id&order=updated_at.desc&limit=1`);
      const stamp = { updated_at: new Date().toISOString(), updated_by: user.id };
      if (have) {
        // Already saved (from the field or the office): the password that just worked replaces the old one
        await db(`wifi_networks?id=eq.${have.id}`, { method: "PATCH", prefer: "return=minimal", body: { psk: net.psk, hidden: net.hidden, ...stamp } });
      } else {
        const [s] = await db(`screens?id=eq.${enc(d.screen_id || "")}&select=directory_id`);
        const [dir] = s ? await db(`directories?id=eq.${enc(s.directory_id || "")}&select=property_id`) : [];
        const [prop] = dir ? await db(`properties?id=eq.${enc(dir.property_id)}&select=name`) : [];
        await db("wifi_networks", { method: "POST", prefer: "return=minimal", body: { label: prop?.name || "", ...net, on_cards: false, ...stamp } });
      }
      await audit(user.id, have ? "update wifi from field" : "save wifi from field", "wifi_network", have?.id || null, { ssid: net.ssid, serial: d.serial });
      return json({ ok: true, updated: !!have });
    }

    if (body.action === "assign") {
      const sid = body.screen_id || null;
      if (sid && !screens.has(sid)) throw fail(404, "No such screen.");
      if (sid) await db(`devices?screen_id=eq.${enc(sid)}&id=neq.${d.id}`, { method: "PATCH", prefer: "return=minimal", body: { screen_id: null } }); // one Pi per screen
      // An unassigned Pi keeps no screenshot (supabase/06-trust.sql), so an old one doesn't linger either
      await db(`devices?id=eq.${d.id}`, { method: "PATCH", prefer: "return=minimal", body: sid ? { screen_id: sid } : { screen_id: null, screenshot: "", screenshot_at: null } });
      await audit(user.id, "assign device", "device", d.id, { serial: d.serial, screen_id: sid });
      return json({ ok: true });
    }
    // A Pi added before it was meant to be (a test Pi, a stray): its record, commands and history go (cascade)
    if (body.action === "remove") {
      if (d.screen_id) throw fail(409, "This Pi is assigned to a screen. Unassign it first (Pi, More).");
      await db(`devices?id=eq.${d.id}`, { method: "DELETE", prefer: "return=minimal" });
      await audit(user.id, "remove device", "device", d.id, { serial: d.serial });
      return json({ ok: true });
    }
    if (body.action === "open_enrollment" || body.action === "close_enrollment") {
      if (body.action === "open_enrollment" && d.key_hash) throw fail(409, "This Pi is already enrolled. Use Reset device key to enroll it again.");
      const until = body.action === "open_enrollment" ? enrollUntil() : null;
      await db(`devices?id=eq.${d.id}`, { method: "PATCH", prefer: "return=minimal", body: { enroll_until: until } });
      await audit(user.id, body.action.replace("_", " "), "device", d.id, { serial: d.serial, until });
      return json({ ok: true, enroll_until: until });
    }
    if (["reset_key", "revoke", "activate"].includes(body.action)) {
      const patch = body.action === "reset_key" ? { key_hash: null, enroll_until: enrollUntil() } : { status: body.action === "revoke" ? "revoked" : "active" };
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
// Uptime = time credited as up / time the Pi should have been up, counted from its first check-in so a newly
// installed Pi isn't marked down for days before it existed. Each check-in credits the time since the previous
// one, up to 3 minutes (supabase/07-uptime.sql), so small timing jitter never shows as downtime. Rows from before
// round 2 have no online_s and count a minute per check-in, as uptime was counted then.
export const upSeconds = (r) => (r.online_s === null || r.online_s === undefined ? r.checkins * 60 : r.online_s);
const DAY_MS = 86400_000;
const shiftDay = (day, n) => new Date(Date.parse(day + "T12:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);

// Each Pi's 30-day totals from its daily rows: the same numbers health_window (17-hardening.sql) returns from the
// database, one row per Pi. Used by tests and the local test server; the live site asks the database.
export function windowsFromDaily(daily, today) {
  const from = (n) => shiftDay(today, -(n - 1));
  const out = new Map();
  for (const r of [...daily].filter((x) => x.day >= from(30)).sort((a, b) => a.day.localeCompare(b.day))) {
    const w = out.get(r.device_id) || out.set(r.device_id, { device_id: r.device_id, first_day: r.day, first_at: r.first_at || null,
      up_s_1: 0, up_s_7: 0, up_s_30: 0, dips_7: 0, dips_30: 0, browser_down_7: 0, max_temp_7: null }).get(r.device_id);
    const up = upSeconds(r);
    w.up_s_30 += up; w.dips_30 += r.power_dips || 0;
    if (r.day >= from(7)) {
      w.up_s_7 += up; w.dips_7 += r.power_dips || 0; w.browser_down_7 += r.browser_down || 0;
      if (typeof r.max_temp_c === "number") w.max_temp_7 = w.max_temp_7 === null ? r.max_temp_c : Math.max(w.max_temp_7, r.max_temp_c);
    }
    if (r.day >= today) w.up_s_1 += up;
  }
  return [...out.values()];
}

export function computeSummary({ devices, windows, daily, screens, dirs, props, orgs, now = Date.now() }) {
  const today = centralDay(new Date(now));
  const byDevice = new Map((windows || windowsFromDaily(daily || [], today)).map((w) => [w.device_id, w]));
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
    const w = byDevice.get(d.id);
    const firstDay = w?.first_day || null;
    // On its first day a Pi is only expected from its first check-in, not from midnight
    const dayMinutes = (day) => {
      const full = day === today ? minutesToday : 1440;
      if (day !== firstDay || !w?.first_at) return full;
      return Math.max(1, full - minuteOfDay(w.first_at));
    };
    const stat = (n) => {
      const days = range(n).filter((day) => firstDay && day >= firstDay);
      if (!days.length) return { uptime: null, dips: 0, browserDown: 0, maxTemp: null };
      const expected = days.reduce((m, day) => m + dayMinutes(day), 0);
      const upMinutes = Number(w[`up_s_${n}`] || 0) / 60;
      return {
        uptime: pct(Math.min(1, upMinutes / expected)),
        dips: Number(w[`dips_${n}`] || 0),
        browserDown: n === 7 ? Number(w.browser_down_7 || 0) : 0,
        maxTemp: n === 7 && typeof w.max_temp_7 === "number" ? w.max_temp_7 : null,
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
      // A display marked as having no HDMI-CEC (21-no-cec.sql) can't be switched on or asked, so its TV state isn't a problem
      s?.no_cec ? null : online && h.tv === "standby" ? "TV off" : online && h.tv === "not-answering" ? "TV not answering" : null,
    ].filter(Boolean);
    return {
      id: d.id, serial: d.serial, status: d.status, online, last_seen: d.last_seen,
      screen: s ? { id: s.id, name: s.name, key: s.key, no_cec: !!s.no_cec } : null,
      building: prop?.name || null, account: org?.name || null, org_id: org?.id || null,
      temp_now: typeof h.temp_c === "number" ? h.temp_c : null, power_now: !!h.under_voltage_now,
      browser_running: h.browser_running !== false, tv: h.tv || null, no_cec: !!s?.no_cec, ip: h.ip || null, agent_version: d.agent_version || null, model: d.model || null,
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
  // 30-day totals come back one row per Pi (17-hardening.sql): Supabase returns at most 1,000 rows a request, and
  // 30 daily rows per Pi would pass that at about 33 Pis
  const [devices, windows, screens, dirs, props, orgs] = await Promise.all([
    db("devices?select=id,serial,screen_id,status,model,agent_version,last_seen,last_health&order=serial.asc"),
    rpc("health_window", { p_today: centralDay() }),
    db("screens?select=id,name,key,directory_id,no_cec"),
    db("directories?select=id,property_id"),
    db("properties?select=id,name,org_id"),
    db("organizations?select=id,name"),
  ]);
  return computeSummary({ devices, windows, screens, dirs, props, orgs });
}
