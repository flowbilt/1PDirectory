// A small stand-in for Supabase used only in tests: Auth (GoTrue) and REST (PostgREST) endpoints the app
// uses, with row-level security that mirrors supabase/01-schema.sql. Not a database; good enough to test the app.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

export const SERVICE_KEY = "test-service-key";
export const ANON_KEY = "test-anon-key";

export function createFake() {
  const T = { organizations: [], profiles: [], properties: [], directories: [], tenants: [], screens: [], audit_log: [], devices: [], device_commands: [], device_daily: [] };
  const SERVICE_ONLY = new Set(["devices", "device_commands", "device_daily"]); // row-level security on, no policies: server key only
  // Columns of screens signed-in users may read (supabase/06-trust.sql). hardware is server-only.
  const SCREEN_COLS = new Set(["id", "directory_id", "key", "name", "location_note", "orientation", "last_seen", "last_report", "identify_until", "created_at"]);
  const users = new Map(); // id -> {id,email,password,last_sign_in_at,invited_at,user_metadata}
  const tokens = new Map(); // token -> user id
  const outbox = [];
  const rpcCalls = []; // which database functions were called, for tests that count trips
  const restCalls = [];
  let clock = null;                                   // tests can fix "now" with setClock(date)
  const now = () => (clock ? new Date(clock) : new Date()).toISOString();

  // ── seed from the migration data ──
  function seed() {
    const data = JSON.parse(readFileSync(new URL("../migration/directories.json", import.meta.url)));
    for (const o of data.organizations) {
      const oid = randomUUID();
      T.organizations.push({ id: oid, name: o.name, kind: o.kind, notes: "", created_at: now() });
      for (const p of o.properties) {
        const pid = randomUUID();
        T.properties.push({ id: pid, org_id: oid, name: p.name, address: p.address || "", timezone: "America/Chicago", lat: p.lat, lon: p.lon, logo: "", logo_replaces_name: false, background: {}, managed_by: p.managed_by || {}, leased_by: p.leased_by || {}, footer: p.footer || "", created_at: now(), updated_at: now(), updated_by: null });
        for (const d of p.directories) {
          const did = randomUUID();
          T.directories.push({ id: did, property_id: pid, slug: d.slug, title: d.title, subtitle: d.subtitle, footer_override: null, news_enabled: true, rotate_seconds: 12, weather_enabled: true, created_at: now(), updated_at: now(), updated_by: null });
          d.tenants.forEach((t, i) => T.tenants.push({ id: randomUUID(), directory_id: did, sort: i * 10, name: t.name, suite: t.suite, arrow: t.arrow, note: t.note }));
          T.screens.push({ id: randomUUID(), directory_id: did, key: d.screen.key, name: d.screen.name, location_note: "", orientation: d.screen.orientation, hardware: d.screen.hardware, last_seen: null, last_report: {}, created_at: now() });
        }
      }
    }
    // A second customer, to prove Barber users can't see it.
    const other = randomUUID(), op = randomUUID(), od = randomUUID();
    T.organizations.push({ id: other, name: "Other Owner LLC", kind: "owner", notes: "", created_at: now() });
    T.properties.push({ id: op, org_id: other, name: "Other Tower", address: "", timezone: "America/Chicago", lat: 33.5, lon: -86.8, logo: "", logo_replaces_name: false, background: {}, managed_by: {}, leased_by: {}, footer: "", created_at: now(), updated_at: now() });
    T.directories.push({ id: od, property_id: op, slug: "other-tower", title: "Other Tower", subtitle: "", footer_override: null, news_enabled: true, rotate_seconds: 12, weather_enabled: true, created_at: now(), updated_at: now() });
    T.tenants.push({ id: randomUUID(), directory_id: od, sort: 0, name: "Secret Tenant Inc.", suite: "100", arrow: "", note: "" });
    T.screens.push({ id: randomUUID(), directory_id: od, key: "other-tower", name: "Other Tower Lobby", location_note: "", orientation: "landscape", hardware: {}, last_seen: null, last_report: {}, created_at: now() });

    for (const sc of T.screens) {
      const serial = String(sc.hardware?.serial || "").toLowerCase();
      if (/^[0-9a-f]{8,32}$/.test(serial)) T.devices.push({ ...defaults.devices(), serial, screen_id: sc.id, model: sc.hardware.model || "" });
    }
    const barber = T.organizations.find((o) => o.name === "Barber Companies").id;
    addUser("scot@1pointusa.com", "admin-pass", "platform_admin", null, "Scot");
    addUser("leighann@barber.test", "owner-pass", "org_admin", barber, "Leigh Ann");
    addUser("editor@barber.test", "editor-pass", "org_editor", barber, "Front Desk");
  }
  function addUser(email, password, role, org_id, full_name) {
    const id = randomUUID();
    users.set(id, { id, email, password, last_sign_in_at: null, invited_at: null, user_metadata: { full_name } });
    T.profiles.push({ user_id: id, email, full_name, role, org_id, created_at: now() });
    return id;
  }

  // ── access rules (mirror of 01-schema.sql) ──
  const profileOf = (uid) => T.profiles.find((p) => p.user_id === uid);
  const dirOrg = (did) => { const d = T.directories.find((x) => x.id === did); const p = d && T.properties.find((x) => x.id === d.property_id); return p?.org_id; };
  function canSee(table, row, who) {
    if (who.service) return true;
    if (SERVICE_ONLY.has(table)) return false;
    const me = who.profile; if (!me) return false;
    if (me.role === "platform_admin") return true;
    switch (table) {
      case "organizations": return row.id === me.org_id;
      case "profiles": return row.user_id === me.user_id || (me.role === "org_admin" && row.org_id === me.org_id);
      case "properties": return row.org_id === me.org_id;
      case "directories": return dirOrg(row.id) === me.org_id;
      case "tenants": return dirOrg(row.directory_id) === me.org_id;
      case "screens": return dirOrg(row.directory_id) === me.org_id;
      default: return false;
    }
  }
  function canWrite(table, op, row, who) {
    if (who.service) return true;
    if (SERVICE_ONLY.has(table)) return false;
    const me = who.profile; if (!me) return false;
    if (me.role === "platform_admin") return table !== "profiles" && table !== "audit_log";
    if (table === "tenants") return dirOrg(row.directory_id) === me.org_id;
    if (op === "update" && table === "properties") return row.org_id === me.org_id;
    if (op === "update" && table === "directories") return dirOrg(row.id) === me.org_id;
    return false;
  }

  // ── helpers ──
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS" };
  const out = (data, status = 200, extra = {}) => new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors, ...extra } });
  const err = (status, message) => out({ message, msg: message, error_description: message }, status);
  function whoFrom(req) {
    const apikey = req.headers.get("apikey");
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (apikey !== SERVICE_KEY && apikey !== ANON_KEY) return null;
    if (bearer === SERVICE_KEY || (apikey === SERVICE_KEY && !bearer)) return { service: true };
    const uid = tokens.get(bearer);
    if (uid) return { uid, profile: profileOf(uid) };
    return { anon: true };
  }
  function session(u) {
    const access = "at-" + randomUUID(), refresh = "rt-" + randomUUID();
    tokens.set(access, u.id); tokens.set(refresh, u.id);
    return { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "bearer", user: publicUser(u) };
  }
  const publicUser = (u) => ({ id: u.id, email: u.email, last_sign_in_at: u.last_sign_in_at, invited_at: u.invited_at, user_metadata: u.user_metadata });
  function mail(type, u, redirect) {
    const s = session(u);
    const link = `${redirect || "http://localhost/login.html"}#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&type=${type}`;
    outbox.push({ type, email: u.email, link });
  }

  function parseFilters(params) {
    const f = [];
    for (const [k, v] of params) {
      if (["select", "order", "limit", "offset", "on_conflict"].includes(k)) continue;
      const m = v.match(/^(not\.)?(eq|neq|in|is|ilike|lt|gt|lte|gte)\.(.*)$/s);
      if (!m) continue;
      const [, neg, op, raw] = m;
      let test;
      if (op === "eq") test = (x) => String(x) === raw;
      else if (op === "neq") test = (x) => String(x) !== raw;
      else if (op === "lt") test = (x) => x != null && String(x) < raw;
      else if (op === "gt") test = (x) => x != null && String(x) > raw;
      else if (op === "lte") test = (x) => x != null && String(x) <= raw;
      else if (op === "gte") test = (x) => x != null && String(x) >= raw;
      else if (op === "is") test = (x) => (raw === "null" ? x == null : String(x) === raw);
      else if (op === "ilike") { const re = new RegExp("^" + raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i"); test = (x) => re.test(String(x ?? "")); }
      else { const list = raw.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")); test = (x) => list.includes(String(x)); }
      f.push((row) => (neg ? !test(row[k]) : test(row[k])));
    }
    return f;
  }
  function order(rows, spec) {
    if (!spec) return rows;
    const keys = spec.split(",").map((s) => { const [c, dir] = s.split("."); return [c, dir === "desc" ? -1 : 1]; });
    return [...rows].sort((a, b) => { for (const [c, d] of keys) { if (a[c] < b[c]) return -d; if (a[c] > b[c]) return d; } return 0; });
  }
  const defaults = {
    organizations: () => ({ id: randomUUID(), kind: "owner", notes: "", created_at: now() }),
    properties: () => ({ id: randomUUID(), address: "", timezone: "America/Chicago", lat: null, lon: null, logo: "", logo_replaces_name: false, background: {}, managed_by: {}, leased_by: {}, footer: "", created_at: now(), updated_at: now() }),
    directories: () => ({ id: randomUUID(), subtitle: "", footer_override: null, news_enabled: true, rotate_seconds: 12, weather_enabled: true, created_at: now(), updated_at: now() }),
    tenants: () => ({ id: randomUUID(), sort: 0, suite: "", arrow: "", note: "" }),
    screens: () => ({ id: randomUUID(), directory_id: null, location_note: "", orientation: "auto", hardware: {}, last_seen: null, last_report: {}, created_at: now() }),
    profiles: () => ({ full_name: "", created_at: now() }),
    audit_log: () => ({ id: T.audit_log.length + 1, at: now(), detail: {} }),
    devices: () => ({ id: randomUUID(), screen_id: null, key_hash: null, enroll_until: null, status: "active", model: "", hostname: "", agent_version: "", last_seen: null, last_health: {}, screenshot: "", screenshot_at: null, alert_state: {}, created_at: now() }),
    device_daily: () => ({ id: (T.device_daily.at(-1)?.id || 0) + 1, checkins: 0, power_dips: 0, browser_down: 0, max_temp_c: null }),
    device_commands: () => ({ id: (T.device_commands.at(-1)?.id || 0) + 1, status: "pending", result: "", created_at: now(), sent_at: null, done_at: null }),
  };
  const touchDir = (did, uid) => { const d = T.directories.find((x) => x.id === did); if (d) { d.updated_at = now(); d.updated_by = uid || null; } };
  function checkRow(table, row) {
    if (table === "directories" && T.directories.some((d) => d.slug === row.slug && d.id !== row.id)) return "duplicate key value violates unique constraint \"directories_slug_key\"";
    if (table === "screens" && T.screens.some((s) => s.key === row.key && s.id !== row.id)) return "duplicate key value violates unique constraint \"screens_key_key\"";
    if (table === "tenants" && !String(row.name || "").trim()) return "new row violates check constraint \"tenants_name_check\"";
    return null;
  }

  async function rest(req, table, params) {
    restCalls.push(`${req.method} ${table}`);
    if (!(table in T)) return err(404, `relation "public.${table}" does not exist`);
    const who = whoFrom(req);
    if (!who) return err(401, "Invalid API key");
    const filters = parseFilters(params);
    const match = (r) => filters.every((f) => f(r));
    const prefer = req.headers.get("prefer") || "";
    const wantRows = prefer.includes("return=representation");

    // Column privileges: signed-in users get only SCREEN_COLS of screens, and "*" is refused as Postgres does
    const cols = (params.get("select") || "*").split(",").map((c) => c.trim());
    if (table === "screens" && !who.service) {
      const asked = req.method === "GET" || wantRows ? cols : [];
      if (asked.some((c) => !SCREEN_COLS.has(c))) return err(403, "permission denied for table screens");
    }
    const pick = (r) => (cols.includes("*") ? { ...r } : Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));

    if (req.method === "GET") {
      const rows = T[table].filter((r) => canSee(table, r, who) && match(r));
      return out(order(rows, params.get("order")).map(pick));
    }
    if (req.method === "POST") {
      let body = await req.json();
      const list = Array.isArray(body) ? body : [body];
      const upsert = prefer.includes("resolution=merge-duplicates");
      const result = [];
      for (const item of list) {
        const existing = upsert && item.id ? T[table].find((r) => r.id === item.id) : null;
        if (existing) {
          if (!canSee(table, existing, who) || !canWrite(table, "update", existing, who)) return err(403, `new row violates row-level security policy for table "${table}"`);
          const next = { ...existing, ...item };
          if (!canWrite(table, "update", next, who)) return err(403, `new row violates row-level security policy for table "${table}"`);
          const bad = checkRow(table, next); if (bad) return err(409, bad);
          Object.assign(existing, item); result.push({ ...existing });
          if (table === "tenants") touchDir(existing.directory_id, who.uid);
        } else {
          const row = { ...(defaults[table]?.() || {}), ...item };
          if (!canWrite(table, "insert", row, who)) return err(403, `new row violates row-level security policy for table "${table}"`);
          const bad = checkRow(table, row); if (bad) return err(409, bad);
          T[table].push(row); result.push({ ...row });
          if (table === "tenants") touchDir(row.directory_id, who.uid);
        }
      }
      return wantRows ? out(result, 201) : out(undefined, 201);
    }
    if (req.method === "PATCH") {
      const body = await req.json();
      const rows = T[table].filter((r) => canSee(table, r, who) && match(r));
      for (const r of rows) {
        if (!canWrite(table, "update", r, who)) return err(403, `permission denied for table ${table}`);
        if (!who.service && who.profile?.role !== "platform_admin") {
          if (table === "properties" && body.org_id && body.org_id !== r.org_id) return err(400, "Only 1Point admins can move a building to another owner");
          if (table === "directories" && ((body.slug && body.slug !== r.slug) || (body.property_id && body.property_id !== r.property_id))) return err(400, "Only 1Point admins can move or rename a directory");
        }
        const bad = checkRow(table, { ...r, ...body }); if (bad) return err(409, bad);
      }
      rows.forEach((r) => {
        Object.assign(r, body);
        if (table === "properties" || table === "directories") { r.updated_at = now(); r.updated_by = who.uid || null; }
        if (table === "tenants") touchDir(r.directory_id, who.uid);
      });
      return wantRows ? out(rows.map((r) => ({ ...r }))) : out(undefined, 204);
    }
    if (req.method === "DELETE") {
      const rows = T[table].filter((r) => canSee(table, r, who) && match(r));
      for (const r of rows) if (!canWrite(table, "delete", r, who)) return err(403, `permission denied for table ${table}`);
      T[table] = T[table].filter((r) => !rows.includes(r));
      if (table === "tenants") new Set(rows.map((r) => r.directory_id)).forEach((d) => touchDir(d, who.uid));
      if (table === "directories") { const ids = new Set(rows.map((r) => r.id)); T.tenants = T.tenants.filter((t) => !ids.has(t.directory_id)); T.screens.forEach((s) => { if (ids.has(s.directory_id)) s.directory_id = null; }); }
      return wantRows ? out(rows) : out(undefined, 204);
    }
    return err(405, "Method not allowed");
  }


  // ── database functions (mirror of supabase/05-tuning.sql, agent_checkin as replaced by 06-trust.sql) ──
  const centralDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
  // Mirror of device_credit (07-uptime.sql): {today, previous day} seconds for a check-in at `at` after one at `prev`
  function deviceCredit(prev, at) {
    const gap = prev ? (Date.parse(at) - Date.parse(prev)) / 1000 : 0;
    const total = gap > 0 && gap <= 180 ? Math.round(gap) : 0;
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]));
    const intoToday = Math.floor(p.hour * 3600 + p.minute * 60 + p.second + (Date.parse(at) % 1000) / 1000);
    return [Math.min(total, intoToday), total - Math.min(total, intoToday)];
  }
  const FUNCS = {
    agent_checkin({ p_serial, p_key_hash, p_info = {}, p_health = {}, p_screenshot = null, p_results = [] }) {
      const t = now();
      let dv = T.devices.find((d) => d.serial === p_serial);
      if (!dv) { dv = { ...defaults.devices(), serial: p_serial, key_hash: p_key_hash }; T.devices.push(dv); } // not registered: enrolls, waits under New devices
      if (dv.status === "revoked") return { refused: "revoked" };
      if (!dv.key_hash) {
        if (!dv.enroll_until || dv.enroll_until < t) return { refused: "enroll" };  // registered, no key: needs the window
        Object.assign(dv, { key_hash: p_key_hash, enroll_until: null });
      } else if (dv.key_hash !== p_key_hash) return { refused: "key" };
      const prevSeen = dv.last_seen;
      Object.assign(dv, { last_seen: t, last_health: p_health || {}, model: p_info?.model ?? "", hostname: p_info?.hostname ?? "", agent_version: p_info?.version ?? "" });
      if (p_screenshot != null && dv.screen_id) Object.assign(dv, { screenshot: p_screenshot, screenshot_at: t }); // none while unassigned
      const cred = deviceCredit(prevSeen, t);
      const day = centralDay(new Date(t)), h = p_health || {};
      const temp = typeof h.temp_c === "number" ? h.temp_c : null;
      const row = T.device_daily.find((r) => r.device_id === dv.id && r.day === day);
      if (row) Object.assign(row, { checkins: row.checkins + 1, online_s: (row.online_s ?? 0) + cred[0], power_dips: row.power_dips + (h.under_voltage_now === true ? 1 : 0),
        browser_down: row.browser_down + (h.browser_running === false ? 1 : 0),
        max_temp_c: row.max_temp_c == null ? temp : temp == null ? row.max_temp_c : Math.max(row.max_temp_c, temp), last_at: t });
      else T.device_daily.push({ ...defaults.device_daily(), device_id: dv.id, day, checkins: 1, online_s: cred[0], power_dips: h.under_voltage_now === true ? 1 : 0,
        browser_down: h.browser_running === false ? 1 : 0, max_temp_c: temp, first_at: t, last_at: t });
      if (cred[1] > 0) {
        const yday = centralDay(new Date(Date.parse(t) - cred[0] * 1000 - 1000));
        const y = T.device_daily.find((r) => r.device_id === dv.id && r.day === yday);
        if (y) y.online_s = (y.online_s ?? 0) + cred[1];
      }
      for (const r of p_results || []) {
        const c = T.device_commands.find((x) => x.id === Number(r.id) && x.device_id === dv.id && x.status === "sent");
        if (c) Object.assign(c, { status: r.status === "done" ? "done" : "failed", result: String(r.result ?? "").slice(0, 500), done_at: t });
      }
      const hourAgo = new Date(Date.parse(t) - 3600_000).toISOString();
      T.device_commands.filter((c) => c.device_id === dv.id && ["pending", "sent"].includes(c.status) && c.created_at < hourAgo).forEach((c) => { c.status = "expired"; });
      const pending = T.device_commands.filter((c) => c.device_id === dv.id && c.status === "pending").sort((a, b) => a.id - b.id);
      pending.forEach((c) => Object.assign(c, { status: "sent", sent_at: t }));
      const sc = T.screens.find((s) => s.id === dv.screen_id);
      return { screen: sc?.key ?? null, commands: pending.map((c) => ({ id: c.id, command: c.command })) };
    },
    screen_state({ p_key, p_device, p_etag, p_report }) {
      let s;
      if (p_device) {
        const dv = T.devices.find((d) => d.serial === p_device);
        s = dv && T.screens.find((x) => x.id === dv.screen_id);
        if (!s) return { new_device: true };
      } else {
        s = T.screens.find((x) => x.key === p_key);
        if (!s) return { missing: true };
      }
      if (p_report && (!s.last_seen || Date.parse(s.last_seen) < Date.now() - 4 * 60000)) Object.assign(s, { last_seen: now(), last_report: p_report });
      const d = s.directory_id ? T.directories.find((x) => x.id === s.directory_id) : null;
      const p = d ? T.properties.find((x) => x.id === d.property_id) : null;
      const etag = createHash("md5").update([s.key, s.name, s.orientation, s.directory_id || "-", s.identify_until || "-", d?.updated_at || "-", p?.updated_at || "-"].join("|")).digest("hex");
      if (etag === p_etag) return { etag, not_modified: true };
      const tenants = d ? order(T.tenants.filter((t) => t.directory_id === d.id), "sort,name").map(({ name, suite, arrow, note, sort }) => ({ name, suite, arrow, note, sort })) : [];
      return { etag, screen: { key: s.key, name: s.name, orientation: s.orientation, identify_until: s.identify_until ?? null }, dir: d ? { ...d } : null, prop: p ? { ...p } : null, tenants };
    },
  };
  async function rpc(req, name) {
    const who = whoFrom(req);
    if (!who) return err(401, "Invalid API key");
    if (!FUNCS[name]) return err(404, `Could not find the function public.${name}`);
    if (!who.service) return err(403, `permission denied for function ${name}`);
    if (req.method !== "POST") return err(405, "Method not allowed");
    rpcCalls.push(name);
    return out(FUNCS[name](await req.json()));
  }

  async function authApi(req, path, url) {
    const who = whoFrom(req);
    if (!who) return err(401, "Invalid API key");
    const body = ["POST", "PUT"].includes(req.method) ? await req.json().catch(() => ({})) : {};
    const redirect = url.searchParams.get("redirect_to");
    if (path === "/token") {
      const grant = url.searchParams.get("grant_type");
      if (grant === "password") {
        const u = [...users.values()].find((x) => x.email === String(body.email || "").toLowerCase());
        if (!u || u.password !== body.password) return err(400, "Invalid login credentials");
        u.last_sign_in_at = now();
        return out(session(u));
      }
      if (grant === "refresh_token") {
        const uid = tokens.get(body.refresh_token); const u = uid && users.get(uid);
        if (!u) return err(400, "Invalid Refresh Token");
        return out(session(u));
      }
      return err(400, "unsupported grant");
    }
    if (path === "/user") {
      const uid = who.uid; const u = uid && users.get(uid);
      if (!u) return err(401, "invalid JWT");
      if (req.method === "PUT") { if (body.password) { if (String(body.password).length < 6) return err(422, "Password should be at least 6 characters."); u.password = body.password; u.last_sign_in_at = u.last_sign_in_at || now(); } }
      return out(publicUser(u));
    }
    if (path === "/recover") {
      const u = [...users.values()].find((x) => x.email === String(body.email || "").toLowerCase());
      if (u) mail("recovery", u, redirect);
      return out({});
    }
    if (!who.service) return err(403, "User not allowed");
    if (path === "/invite") {
      const email = String(body.email || "").toLowerCase();
      let u = [...users.values()].find((x) => x.email === email);
      if (u && u.last_sign_in_at) return err(422, "A user with this email address has already been registered");
      if (!u) { u = { id: randomUUID(), email, password: null, last_sign_in_at: null, invited_at: now(), user_metadata: body.data || {} }; users.set(u.id, u); }
      mail("invite", u, redirect);
      return out(publicUser(u));
    }
    if (path === "/admin/users" && req.method === "GET") return out({ users: [...users.values()].map(publicUser) });
    const m = path.match(/^\/admin\/users\/([\w-]+)$/);
    if (m) {
      const u = users.get(m[1]); if (!u) return err(404, "User not found");
      if (req.method === "DELETE") { users.delete(u.id); T.profiles = T.profiles.filter((p) => p.user_id !== u.id); return out({}); }
      return out(publicUser(u));
    }
    return err(404, "not found");
  }

  async function handle(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/__outbox") return out(outbox);
    if (url.pathname.startsWith("/rest/v1/rpc/")) return rpc(req, url.pathname.slice(13));
    if (url.pathname.startsWith("/rest/v1/")) return rest(req, url.pathname.slice(9), url.searchParams);
    if (url.pathname.startsWith("/auth/v1")) return authApi(req, url.pathname.slice(8), url);
    return err(404, "not found");
  }

  seed();
  return { handle, T, users, outbox, addUser, rpcCalls, restCalls, deviceCredit, setClock: (d) => { clock = d ? new Date(d) : null; } };
}
