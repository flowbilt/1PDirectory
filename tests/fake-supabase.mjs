// A small stand-in for Supabase used only in tests: Auth (GoTrue) and REST (PostgREST) endpoints the app
// uses, with row-level security that mirrors supabase/01-schema.sql. Not a database; good enough to test the app.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkMenuSpec, checkMenuContent } from "../public/menu-format.mjs";

// Per-screen size ranges, % of standard: 18-sizes.sql (title, logo, brand, welcome) and 22-widget-sizes.sql (news,
// clock, weather, contacts). A test checks the SQL, the display and the editor all say the same.
export const SIZE_RANGES = { title: [50, 120], logo: [60, 200], brand: [60, 250], welcome: [80, 160],
  news: [70, 150], clock: [70, 150], weather: [70, 150], contacts: [70, 150], qr: [70, 150] };   // qr: 24-directory-to-go.sql

export const SERVICE_KEY = "test-service-key";
export const ANON_KEY = "test-anon-key";

// Directory to Go codes, as 24-directory-to-go.sql makes them: 6 characters, no 0/O/1/I/L
const CODE_ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 6 }, () => CODE_ALPHA[Math.floor(Math.random() * CODE_ALPHA.length)]).join("");

export function createFake() {
  const T = { organizations: [], profiles: [], properties: [], directories: [], tenants: [], screens: [], audit_log: [], devices: [], device_commands: [], device_daily: [], wifi_networks: [], prepare_codes: [], alert_recipients: [], mail_settings: [], togo_scans: [], companies: [], people: [], layouts: [], layout_versions: [], layout_images: [], menu_scans: [], menus: [], menu_revisions: [], sample_links: [] };
  const storage = new Map();   // bucket/path -> { bytes, mime, cacheControl } (E1b)
  const SERVICE_ONLY = new Set(["togo_scans", "devices", "device_commands", "device_daily", "wifi_networks", "prepare_codes", "alert_recipients", "mail_settings", "menu_scans"]); // row-level security on, no policies: server key only
  // Columns of screens signed-in users may read (supabase/06-trust.sql, plus sizes from 18 and no_cec from 21). hardware is server-only.
  const SCREEN_COLS = new Set(["id", "directory_id", "key", "name", "location_note", "orientation", "last_seen", "last_report", "identify_until", "created_at", "sizes", "no_cec", "hide_powered_by", "touch", "screen_inches", "touch_idle_s", "layout_id", "property_id"]);
  const users = new Map(); // id -> {id,email,password,last_sign_in_at,invited_at,user_metadata}
  const tokens = new Map(); // token -> user id
  const outbox = [];
  const rpcCalls = []; // which database functions were called, for tests that count trips
  const restCalls = [];
  let clock = null;                                   // tests can fix "now" with setClock(date)
  // Postgres stamps each change with its own transaction's time (microseconds), so two changes never share one; the real
  // clock here counts milliseconds, so keep it strictly increasing (round 16: two quick changes sometimes shared a stamp,
  // and a test that expects the second to give a screen a new version failed about once in twenty runs)
  let lastMs = 0;
  const now = () => {
    if (clock) return new Date(clock).toISOString();
    lastMs = Math.max(Date.now(), lastMs + 1);
    return new Date(lastMs).toISOString();
  };

  // ── seed from the migration data ──
  function seed() {
    const data = JSON.parse(readFileSync(new URL("../migration/directories.json", import.meta.url)));
    for (const o of data.organizations) {
      const oid = randomUUID();
      T.organizations.push({ id: oid, name: o.name, kind: o.kind, notes: "", created_at: now() });
      for (const p of o.properties) {
        const pid = randomUUID();
        T.properties.push({ id: pid, org_id: oid, name: p.name, address: p.address || "", timezone: "America/Chicago", lat: p.lat, lon: p.lon, logo: "", logo_replaces_name: false, company_logo: "", logo_swap: false, background: {}, destinations: [], amenities: [], place_lists: [], managed_by: p.managed_by || {}, leased_by: p.leased_by || {}, footer: p.footer || "", created_at: now(), updated_at: now(), updated_by: null });
        for (const d of p.directories) {
          const did = randomUUID();
          T.directories.push({ id: did, property_id: pid, slug: d.slug, title: d.title, subtitle: d.subtitle, footer_override: null, news_enabled: true, rotate_seconds: 12, weather_enabled: true, map_enabled: false, times_enabled: false, amenities_enabled: false, togo_enabled: false, togo_line: "", togo_code: newCode(), touch_keyboard: false, created_at: now(), updated_at: now(), updated_by: null });
          d.tenants.forEach((t, i) => T.tenants.push({ id: randomUUID(), directory_id: did, sort: i * 10, name: t.name, suite: t.suite, arrow: t.arrow, note: t.note }));
          T.screens.push({ id: randomUUID(), directory_id: did, key: d.screen.key, name: d.screen.name, location_note: "", orientation: d.screen.orientation, hardware: d.screen.hardware, last_seen: null, last_report: {}, sizes: {}, no_cec: false, traffic_at: null, hide_powered_by: false, touch: false, screen_inches: null, touch_idle_s: 45, created_at: now() });
        }
      }
    }
    // A second customer, to prove Barber users can't see it.
    const other = randomUUID(), op = randomUUID(), od = randomUUID();
    T.organizations.push({ id: other, name: "Other Owner LLC", kind: "owner", notes: "", created_at: now() });
    T.properties.push({ id: op, org_id: other, name: "Other Tower", address: "", timezone: "America/Chicago", lat: 33.5, lon: -86.8, logo: "", logo_replaces_name: false, company_logo: "", logo_swap: false, background: {}, destinations: [], amenities: [], place_lists: [], managed_by: {}, leased_by: {}, footer: "", created_at: now(), updated_at: now() });
    T.directories.push({ id: od, property_id: op, slug: "other-tower", title: "Other Tower", subtitle: "", footer_override: null, news_enabled: true, rotate_seconds: 12, weather_enabled: true, map_enabled: false, times_enabled: false, amenities_enabled: false, togo_enabled: false, togo_line: "", togo_code: newCode(), touch_keyboard: false, created_at: now(), updated_at: now() });
    T.tenants.push({ id: randomUUID(), directory_id: od, sort: 0, name: "Secret Tenant Inc.", suite: "100", arrow: "", note: "" });
    T.screens.push({ id: randomUUID(), directory_id: od, key: "other-tower", name: "Other Tower Lobby", location_note: "", orientation: "landscape", hardware: {}, last_seen: null, last_report: {}, sizes: {}, no_cec: false, traffic_at: null, hide_powered_by: false, touch: false, screen_inches: null, touch_idle_s: 45, created_at: now() });

    for (const t of T.tenants) linkTenant(t, null);              // 26-people.sql gives existing tenants their companies
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
  const companyOrg = (cid) => { const c = T.companies.find((x) => x.id === cid); return T.properties.find((x) => x.id === c?.property_id)?.org_id; };
  const propOrg = (pid) => T.properties.find((x) => x.id === pid)?.org_id;
  const layoutOrg = (lid) => T.layouts.find((x) => x.id === lid)?.org_id;
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
      case "screens": return dirOrg(row.directory_id) === me.org_id || (!!row.property_id && propOrg(row.property_id) === me.org_id);   // 29
      case "layouts": return row.org_id === me.org_id;                   // 29-layout-engine.sql
      case "layout_versions": return layoutOrg(row.layout_id) === me.org_id;
      case "layout_images": return row.org_id === me.org_id;            // 30-layout-images.sql
      case "menus": return row.org_id === me.org_id;                     // 32-menus.sql
      case "menu_revisions": return T.menus.find((m) => m.id === row.menu_id)?.org_id === me.org_id;
      case "companies": return companyOrg(row.id) === me.org_id;
      case "people": return companyOrg(row.company_id) === me.org_id;
      default: return false;
    }
  }
  function canWrite(table, op, row, who) {
    if (who.service) return true;
    if (SERVICE_ONLY.has(table)) return false;
    const me = who.profile; if (!me) return false;
    if (me.role === "platform_admin") return table !== "profiles" && table !== "audit_log" && table !== "layout_versions"   // versions: the site only
      && table !== "menu_revisions"                                       // 32: revisions only through menu_save
      && !(table === "layout_images" && op !== "update");                // pictures: added and removed by the site only (30)
    if (table === "tenants") return dirOrg(row.directory_id) === me.org_id;
    if (table === "people") return companyOrg(row.company_id) === me.org_id;            // 26-people.sql
    if (op === "update" && table === "companies") return companyOrg(row.id) === me.org_id; // no insert: the tenant list makes them
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
      const m = v.match(/^(not\.)?(eq|neq|in|is|ilike|like|lt|gt|lte|gte)\.(.*)$/s);
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
      else if (op === "like") { const re = new RegExp("^" + raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"); test = (x) => re.test(String(x ?? "")); }
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
    organizations: () => ({ id: randomUUID(), kind: "owner", notes: "", picture_room: 100, created_at: now() }),
    properties: () => ({ id: randomUUID(), address: "", timezone: "America/Chicago", lat: null, lon: null, logo: "", logo_replaces_name: false, company_logo: "", logo_swap: false, background: {}, destinations: [], amenities: [], place_lists: [], managed_by: {}, leased_by: {}, footer: "", created_at: now(), updated_at: now() }),
    directories: () => ({ id: randomUUID(), subtitle: "", footer_override: null, news_enabled: true, rotate_seconds: 12, weather_enabled: true, map_enabled: false, times_enabled: false, amenities_enabled: false, togo_enabled: false, togo_line: "", togo_code: newCode(), touch_keyboard: false, created_at: now(), updated_at: now() }),
    tenants: () => ({ id: randomUUID(), sort: 0, suite: "", arrow: "", note: "", company_id: null }),
    companies: () => ({ id: randomUUID(), show_people: false, show_title: true, show_phone: false, show_email: false, created_at: now(), updated_at: now() }),
    people: () => ({ id: randomUUID(), sort: 0, first_name: "", last_name: "", title: "", phone: "", email: "", suite: "", show: true, created_at: now(), updated_at: now() }),
    layout_images: () => ({ id: randomUUID(), name: "", created_at: now(), created_by: null }),
    menus: () => ({ id: randomUUID(), customer_edit: true, spec: { lists: [] }, content: { lists: {} }, rev: 0, created_at: now(), updated_at: now(), updated_by: null }),
    sample_links: () => ({ days: 30, property_id: null, turned_off_at: null, opens: 0, last_open_at: null }),
    layouts: () => ({ id: randomUUID(), menu_id: null, menu_code: newCode(), family: "menu", draft: {}, published_version: null, published_at: null, created_at: now(), updated_at: now(), updated_by: null }),
    screens: () => ({ id: randomUUID(), directory_id: null, layout_id: null, property_id: null, location_note: "", orientation: "auto", hardware: {}, last_seen: null, last_report: {}, sizes: {}, no_cec: false, traffic_at: null, hide_powered_by: false, touch: false, screen_inches: null, touch_idle_s: 45, created_at: now() }),
    profiles: () => ({ full_name: "", created_at: now() }),
    audit_log: () => ({ id: T.audit_log.length + 1, at: now(), detail: {} }),
    devices: () => ({ id: randomUUID(), screen_id: null, key_hash: null, enroll_until: null, refused_at: null, refused_why: null, status: "active", model: "", hostname: "", agent_version: "", last_seen: null, last_health: {}, screenshot: "", screenshot_at: null, alert_state: {}, created_at: now() }),
    device_daily: () => ({ id: (T.device_daily.at(-1)?.id || 0) + 1, checkins: 0, power_dips: 0, browser_down: 0, max_temp_c: null }),
    alert_recipients: () => ({ id: randomUUID(), name: "", offline: true, power: true, hot: true, enabled: true, updated_at: now(), updated_by: null }),
    wifi_networks: () => ({ id: randomUUID(), label: "", psk: "", hidden: false, on_cards: true, sort: 0, updated_at: now(), updated_by: null }),
    prepare_codes: () => ({ id: (T.prepare_codes.at(-1)?.id || 0) + 1, used_at: null, created_at: now() }),
    device_commands: () => ({ id: (T.device_commands.at(-1)?.id || 0) + 1, status: "pending", result: "", payload: null, save: null, created_at: now(), sent_at: null, done_at: null }),
  };
  const touchDir = (did, uid) => { const d = T.directories.find((x) => x.id === did); if (d) { d.updated_at = now(); d.updated_by = uid || null; } };
  // Mirror of 26-people.sql: a tenant finds (or makes) its building's company by name; a rename of a company's only
  // listing to a free name renames the company; people and switch changes mark every directory listing the company
  const companyKey = (n) => String(n ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const touchCompany = (cid, uid) => new Set(T.tenants.filter((t) => t.company_id === cid).map((t) => t.directory_id)).forEach((d) => touchDir(d, uid));
  function linkTenant(row, old) {
    const prop = T.directories.find((d) => d.id === row.directory_id)?.property_id;
    if (!prop) return;
    const key = companyKey(row.name);
    if (old && old.company_id && old.directory_id === row.directory_id && companyKey(old.name) !== key
        && !T.tenants.some((t) => t.company_id === old.company_id && t.id !== old.id)
        && !T.companies.some((c) => c.property_id === prop && companyKey(c.name) === key)) {
      const c = T.companies.find((x) => x.id === old.company_id); c.name = String(row.name).trim(); c.updated_at = now();
      row.company_id = old.company_id; return;
    }
    let c = T.companies.find((x) => x.property_id === prop && companyKey(x.name) === key);
    if (!c) { c = { ...defaults.companies(), property_id: prop, name: String(row.name).trim() }; T.companies.push(c); }
    row.company_id = c.id;
  }
  const shapeOf = (o) => (o === "portrait" || o === "portrait-flipped" ? "portrait" : "landscape");
  const LABEL = { auto: "Automatic", portrait: "Portrait", "portrait-flipped": "Portrait (turned the other way)", landscape: "Landscape", "landscape-flipped": "Landscape (upside down)" };
  /** guard_screen_layout and the one-content check (29-layout-engine.sql), in its words */
  function layoutRule(row, before) {
    if (row.directory_id && row.layout_id) return "new row for relation \"screens\" violates check constraint \"screens_one_content\"";
    if (!row.layout_id) return null;
    const l = T.layouts.find((x) => x.id === row.layout_id);
    if (!l) return "insert or update on table \"screens\" violates foreign key constraint \"screens_layout_id_fkey\"";
    if (l.published_version == null && (!before || before.layout_id !== row.layout_id)) return `The layout "${l.name}" hasn't been published yet. Publish it on the Layouts tab first.`;
    if (!row.property_id) return "Choose the building this screen is in. A layout takes its time zone, weather and address from the screen's building.";
    if (propOrg(row.property_id) !== l.org_id) return `That building belongs to a different account from the layout "${l.name}". Choose one of the layout's account's buildings.`;
    if (shapeOf(row.orientation) !== l.orientation) {
      const other = shapeOf(row.orientation);
      return `The layout "${l.name}" is ${l.orientation}, and this screen's Orientation is ${LABEL[row.orientation] || "Automatic"}. Change the screen's Orientation to ${l.orientation === "portrait" ? "Portrait" : "Landscape"} first, or choose a ${other} layout.`;
    }
    return null;
  }
  /** guard_menu (32-menus.sql): the lists, a list a published layout shows, then the content, in plain words */
  function menuRule(row, before) {
    const sp = checkMenuSpec(row.spec);
    if (sp.errors.length) return sp.errors[0].msg;
    if (before && before.org_id !== row.org_id) return "A menu stays with its account.";
    if (before) {
      const keys = new Set((row.spec.lists || []).map((l) => l.key));
      for (const old of before.spec?.lists || []) {
        if (keys.has(old.key)) continue;
        const l = T.layouts.find((x) => x.menu_id === row.id && x.published_version != null
          && (T.layout_versions.find((v) => v.layout_id === x.id && v.version === x.published_version)?.doc?.blocks || []).some((b) => b.content?.list === old.key));
        if (l) return `The list "${old.key}" is shown by the layout "${l.name}". Take it off that layout (and publish) first.`;
      }
    }
    const pics = new Set(T.layout_images.filter((i) => i.org_id === row.org_id).map((i) => i.key));
    const c = checkMenuContent(sp.spec, row.content, { images: pics });
    return c.errors.length ? `${c.errors[0].where}: ${c.errors[0].msg}` : null;
  }
  function checkRow(table, row, before) {
    if (table === "organizations" && row.kind !== undefined && !["owner", "manager", "templates", "samples"].includes(row.kind)) return "new row violates check constraint \"organizations_kind_check\"";   // 36
    if (table === "sample_links") {   // 36-templates.sql
      if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(String(row.slug || "").toLowerCase())) return "new row violates check constraint \"sample_links_slug_check\"";
      if (![30, 60, 90].includes(Number(row.days))) return "new row violates check constraint \"sample_links_days_check\"";
      const l = T.layouts.find((x) => x.id === row.layout_id);
      if (!before) {
        if (!l) return "No such board.";
        if (l.published_version == null) return `Publish the board "${l.name}" first, so the sample has something to show.`;
        if (T.sample_links.some((x) => x.slug === String(row.slug).toLowerCase())) return "duplicate key value violates unique constraint \"sample_links_pkey\"";
      } else if (row.slug !== before.slug || row.layout_id !== before.layout_id) return "A sample link keeps its name and its board. Make a new link instead.";
      if (row.property_id && propOrg(row.property_id) !== l?.org_id) return "Choose a building in the board's own account.";
    }
    if (table === "menus") { const bad = menuRule(row, before); if (bad) return bad; }
    if (table === "layouts" && row.menu_id && T.menus.find((m) => m.id === row.menu_id)?.org_id !== row.org_id) return `That menu belongs to a different account from the layout "${row.name}".`;
    if (table === "screens") { const bad = layoutRule(row, before); if (bad) return bad; }
    if (table === "layout_images" && !before && T.layout_images.some((x) => x.org_id === row.org_id && x.key === row.key)) return "duplicate key value violates unique constraint \"layout_images_org_id_key_key\"";
    if (table === "layout_images" && !before) {   // 34-customer-pictures.sql: the room per account
      const have = T.layout_images.filter((x) => x.org_id === row.org_id).length, room = T.organizations.find((o) => o.id === row.org_id)?.picture_room ?? 100;
      if (have >= room) return `This account has ${have} pictures, the most it holds. Remove ones you no longer use, or ask WayTuGo for more room.`;
    }
    if (table === "organizations" && row.picture_room !== undefined && !(Number.isInteger(row.picture_room) && row.picture_room >= 0 && row.picture_room <= 10000)) return "new row violates check constraint \"organizations_picture_room_range\"";
    if (table === "layout_images" && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(String(row.key || ""))) return "new row violates check constraint \"layout_images_key_check\"";
    if (table === "layouts" && before && (row.orientation !== before.orientation || row.org_id !== before.org_id)) {
      const n = T.screens.filter((x) => x.layout_id === before.id).length;
      if (n) return `The layout "${before.name}" is shown on ${n} screen(s). Choose something else for those screens first.`;
    }
    if (table === "directories" && T.directories.some((d) => d.slug === row.slug && d.id !== row.id)) return "duplicate key value violates unique constraint \"directories_slug_key\"";
    if (table === "screens" && T.screens.some((s) => s.key === row.key && s.id !== row.id)) return "duplicate key value violates unique constraint \"screens_key_key\"";
    if (table === "screens" && row.touch_idle_s != null && !(row.touch_idle_s >= 15 && row.touch_idle_s <= 300)) return "new row violates check constraint \"screens_touch_idle_range\"";
    if (table === "tenants" && !String(row.name || "").trim()) return "new row violates check constraint \"tenants_name_check\"";
    if (table === "people" && !String(row.first_name || "").trim() && !String(row.last_name || "").trim()) return "new row violates check constraint \"people_named\"";
    if (table === "people" && [["first_name", 60], ["last_name", 60], ["title", 80], ["phone", 40], ["email", 120], ["suite", 16]].some(([f, n]) => String(row[f] ?? "").length > n)) return "new row violates check constraint \"people_check\"";
    // 19-mail.sql: one row, and only sealed passwords
    if (table === "mail_settings" && (row.id !== true || !String(row.password_enc || "").startsWith("v1:"))) return "new row violates check constraint \"mail_settings_check\"";
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
      return out(order(rows, params.get("order")).slice(0, Math.min(Number(params.get("limit")) || MAX_ROWS, MAX_ROWS)).map(pick));
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
          const bad = checkRow(table, next, existing); if (bad) return err(409, bad);
          const before = { ...existing };
          Object.assign(existing, item);
          if (table === "tenants") { linkTenant(existing, before); touchDir(existing.directory_id, who.uid); }
          if (table === "people") touchCompany(existing.company_id, who.uid);
          result.push({ ...existing });
        } else {
          if (table === "layouts" && !who.service && ["draft", "published_version", "published_at", "menu_code"].some((k) => k in item)) return err(403, "permission denied for table layouts");
          if (table === "menus" && !who.service && ["content", "rev", "updated_by"].some((k) => k in item)) return err(403, "permission denied for table menus");
          if (table === "sample_links" && !who.service && Object.keys(item).some((k) => !["slug", "layout_id", "property_id", "days"].includes(k))) return err(403, "permission denied for table sample_links");
          const row = { ...(defaults[table]?.() || {}), ...item };
          if (!canWrite(table, "insert", row, who)) return err(403, `new row violates row-level security policy for table "${table}"`);
          if (table === "sample_links") Object.assign(row, { slug: String(row.slug).toLowerCase(), expires_at: new Date(Date.parse(now()) + Number(row.days ?? 30) * 86400_000).toISOString(), created_at: now(), opens: 0, last_open_at: null, created_by: who.uid || row.created_by || null });
          const bad = checkRow(table, row); if (bad) return err(409, bad);
          if (table === "tenants") linkTenant(row, null);
          T[table].push(row); result.push({ ...row });
          if (table === "tenants") touchDir(row.directory_id, who.uid);
          if (table === "people") touchCompany(row.company_id, who.uid);
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
          if (table === "companies" && ((body.name !== undefined && body.name !== r.name) || (body.property_id && body.property_id !== r.property_id))) return err(400, "A company takes its name from the tenant list: rename the tenant instead");
        }
        const bad = checkRow(table, { ...r, ...body }, r); if (bad) return err(409, bad);
        // 29: signed-in users may not write a layout's draft or its published fields (the site does, after its checks)
        if (table === "layouts" && !who.service && ["draft", "published_version", "published_at", "menu_code"].some((k) => k in body)) return err(403, "permission denied for table layouts");
        if (table === "layout_images" && !who.service && Object.keys(body).some((k) => k !== "name")) return err(403, "permission denied for table layout_images");
        if (table === "menus" && !who.service && ["content", "rev", "updated_by", "org_id"].some((k) => k in body)) return err(403, "permission denied for table menus");
        if (table === "sample_links" && !who.service && Object.keys(body).some((k) => !["property_id", "days", "expires_at", "turned_off_at"].includes(k))) return err(403, "permission denied for table sample_links");
        if (table === "layout_images" && ["key", "path", "org_id", "mime", "width", "height", "bytes"].some((k) => k in body && body[k] !== r[k])) return err(409, "A picture can't be changed once it's uploaded (only its name). Upload the new picture instead.");
      }
      rows.forEach((r) => {
        const before = { ...r };
        const { company_id, ...rest } = body;                     // a tenant's company comes from its name, never from the editor
        Object.assign(r, table === "tenants" ? rest : body);
        if (table === "sample_links" && (r.days !== before.days || r.expires_at !== before.expires_at)) r.expires_at = new Date(Date.parse(now()) + r.days * 86400_000).toISOString();   // 36: from now
        if (table === "properties" || table === "directories" || table === "menus") { r.updated_at = now(); if (table !== "menus") r.updated_by = who.uid || null; }
        if (table === "tenants") { linkTenant(r, before); touchDir(r.directory_id, who.uid); }
        if (table === "people") touchCompany(r.company_id, who.uid);
        if (table === "companies" && ["show_people", "show_title", "show_phone", "show_email", "name"].some((k) => before[k] !== r[k])) touchCompany(r.id, who.uid);
      });
      return wantRows ? out(rows.map((r) => ({ ...r }))) : out(undefined, 204);
    }
    if (req.method === "DELETE") {
      const rows = T[table].filter((r) => canSee(table, r, who) && match(r));
      for (const r of rows) if (!canWrite(table, "delete", r, who)) return err(403, `permission denied for table ${table}`);
      if (table === "layouts") for (const r of rows) { const n = T.screens.filter((x) => x.layout_id === r.id).length; if (n) return err(409, `The layout "${r.name}" is shown on ${n} screen(s). Choose something else for those screens first.`); }
      if (table === "layouts") { const ids = new Set(rows.map((r) => r.id)); T.layout_versions = T.layout_versions.filter((v) => !ids.has(v.layout_id)); }
      if (table === "menus") for (const r of rows) { const n = T.layouts.filter((x) => x.menu_id === r.id).length; if (n) return err(409, `The menu "${r.name}" feeds ${n} layout(s). Choose no menu for them first.`); }
      if (table === "menus") { const ids = new Set(rows.map((r) => r.id)); T.menu_revisions = T.menu_revisions.filter((v) => !ids.has(v.menu_id)); }
      T[table] = T[table].filter((r) => !rows.includes(r));
      if (table === "tenants") new Set(rows.map((r) => r.directory_id)).forEach((d) => touchDir(d, who.uid));
      if (table === "people") new Set(rows.map((r) => r.company_id)).forEach((c) => touchCompany(c, who.uid));
      if (table === "directories") { const ids = new Set(rows.map((r) => r.id)); T.tenants = T.tenants.filter((t) => !ids.has(t.directory_id)); T.screens.forEach((s) => { if (ids.has(s.directory_id)) s.directory_id = null; }); }
      return wantRows ? out(rows) : out(undefined, 204);
    }
    return err(405, "Method not allowed");
  }


  // ── database functions (mirror of supabase/05-tuning.sql; agent_checkin as last replaced by 20-save-wifi.sql) ──
  const centralDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
  // Mirror of device_credit (07-uptime.sql): {today, previous day} seconds for a check-in at `at` after one at `prev`
  function deviceCredit(prev, at) {
    const gap = prev ? (Date.parse(at) - Date.parse(prev)) / 1000 : 0;
    const total = gap > 0 && gap <= 180 ? Math.round(gap) : 0;
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]));
    const intoToday = Math.floor(p.hour * 3600 + p.minute * 60 + p.second + (Date.parse(at) % 1000) / 1000);
    return [Math.min(total, intoToday), total - Math.min(total, intoToday)];
  }
  // Supabase hands back at most 1,000 rows a request (tables and functions alike); so does this fake
  const MAX_ROWS = 1000;
  const addDays = (day, n) => new Date(Date.parse(day + "T12:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
  // Functions signed-in users may call (they check access themselves); the rest are server-only
  const USER_FUNCS = new Set(["set_screen_sizes", "togo_scan_count", "togo_replace_code", "menu_scan_count", "menu_save", "menu_restore"]);
  const FUNCS = {
    // Mirror of 18-sizes.sql and 22-widget-sizes.sql (SIZE_RANGES, exported below)
    set_screen_sizes({ p_screen, p_sizes = {} }, who) {
      const s = T.screens.find((x) => x.id === p_screen);
      const me = who.profile;
      const ok = s && (who.service || me?.role === "platform_admin" || (me && s.directory_id && dirOrg(s.directory_id) === me.org_id));
      if (!ok) throw Object.assign(new Error("That screen doesn't exist, or you don't have access to it."), { status: 403 });
      const outSizes = {};
      for (const [name, [lo, hi]] of Object.entries(SIZE_RANGES)) {
        if (typeof p_sizes?.[name] !== "number") continue;
        const v = Math.min(hi, Math.max(lo, Math.round(p_sizes[name])));
        if (v !== 100) outSizes[name] = v;
      }
      s.sizes = outSizes;
      return outSizes;
    },
    // Mirrors of 17-hardening.sql, written from the SQL (not from the site's code), so the tests compare the two
    recent_device_commands({ p_device_ids = [], p_per = 5 }) {
      const per = Math.max(1, Math.min(p_per ?? 5, 20));
      return p_device_ids.map((id) => {
        const mine = T.device_commands.filter((c) => c.device_id === id).sort((a, b) => b.id - a.id).slice(0, per);
        return mine.length ? { device_id: id, commands: mine.map(({ id, device_id, command, status, result, created_at, done_at }) => ({ id, device_id, command, status, result, created_at, done_at })) } : null;
      }).filter(Boolean);
    },
    health_window({ p_today }) {
      const rows = T.device_daily.filter((d) => d.day >= addDays(p_today, -29));
      const ids = [...new Set(rows.map((d) => d.device_id))];
      const sum = (list, f) => list.reduce((m, d) => m + f(d), 0);
      const up = (d) => (d.online_s ?? d.checkins * 60);
      return ids.map((id) => {
        const mine = rows.filter((d) => d.device_id === id).sort((a, b) => a.day.localeCompare(b.day));
        const wk = mine.filter((d) => d.day >= addDays(p_today, -6));
        const temps = wk.map((d) => d.max_temp_c).filter((t) => t !== null && t !== undefined);
        return { device_id: id, first_day: mine[0].day, first_at: mine[0].first_at ?? null,
          up_s_1: sum(mine.filter((d) => d.day >= p_today), up), up_s_7: sum(wk, up), up_s_30: sum(mine, up),
          dips_7: sum(wk, (d) => d.power_dips || 0), dips_30: sum(mine, (d) => d.power_dips || 0),
          browser_down_7: sum(wk, (d) => d.browser_down || 0), max_temp_7: temps.length ? Math.max(...temps) : null };
      });
    },
    trim_device_history() {
      const keep = new Set();
      const byDev = new Map();
      for (const c of [...T.device_commands].sort((a, b) => b.id - a.id)) {
        const n = (byDev.get(c.device_id) || 0) + 1; byDev.set(c.device_id, n);
        if (n <= 5) keep.add(c.id);
      }
      const at = Date.parse(now());
      const cutoff = new Date(at - 90 * 86400_000).toISOString();
      const before = [T.device_commands.length, T.device_daily.length];
      const prune = (list, keepIt) => { for (let i = list.length - 1; i >= 0; i--) if (!keepIt(list[i])) list.splice(i, 1); };
      prune(T.device_commands, (c) => keep.has(c.id) || ["pending", "sent"].includes(c.status) || c.created_at >= cutoff);
      prune(T.device_daily, (d) => d.day >= addDays(centralDay(new Date(at)), -400));
      return { commands: before[0] - T.device_commands.length, days: before[1] - T.device_daily.length };
    },
    agent_checkin({ p_serial, p_key_hash, p_info = {}, p_health = {}, p_screenshot = null, p_results = [] }) {
      const t = now();
      let dv = T.devices.find((d) => d.serial === p_serial);
      if (!dv) { dv = { ...defaults.devices(), serial: p_serial, key_hash: p_key_hash }; T.devices.push(dv); } // not registered: enrolls, waits under New devices
      const refuse = (why) => (Object.assign(dv, { refused_at: t, refused_why: why }), { refused: why });   // 10-refused.sql
      if (dv.status === "revoked") return refuse("revoked");
      if (!dv.key_hash) {
        if (!dv.enroll_until || dv.enroll_until < t) return refuse("enroll");  // registered, no key: needs the window
        Object.assign(dv, { key_hash: p_key_hash, enroll_until: null });
      } else if (dv.key_hash !== p_key_hash) return refuse("key");
      const prevSeen = dv.last_seen;
      Object.assign(dv, { last_seen: t, refused_at: null, refused_why: null, last_health: p_health || {}, model: p_info?.model ?? "", hostname: p_info?.hostname ?? "", agent_version: p_info?.version ?? "" });
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
        if (!c) continue;
        // 20-save-wifi.sql: a join with Save ticked is saved here, only if the Pi says it worked, and the result says so
        let note = "";
        if (c.command === "wifi_join" && c.save) {
          if (r.status !== "done") note = " Nothing was saved.";
          else {
            const sv = c.save, have = order(T.wifi_networks.filter((n) => n.ssid === sv.ssid), "updated_at.desc")[0];
            if (have) {
              Object.assign(have, { psk: sv.psk || "", hidden: !!sv.hidden, updated_at: t, updated_by: c.created_by ?? null });
              T.audit_log.push({ ...defaults.audit_log(), user_id: c.created_by ?? null, action: "update wifi from field", entity: "wifi_network", entity_id: have.id, detail: { ssid: sv.ssid, serial: dv.serial } });
              note = ` The saved password is updated: other Pis can join ${sv.ssid} with one tap.`;
            } else {
              const sc = T.screens.find((x) => x.id === dv.screen_id), dd = sc && T.directories.find((x) => x.id === sc.directory_id);
              const pp = dd && T.properties.find((x) => x.id === dd.property_id);
              const row = { ...defaults.wifi_networks(), label: pp?.name || "", ssid: sv.ssid, psk: sv.psk || "", hidden: !!sv.hidden, on_cards: false, updated_at: t, updated_by: c.created_by ?? null };
              T.wifi_networks.push(row);
              T.audit_log.push({ ...defaults.audit_log(), user_id: c.created_by ?? null, action: "save wifi from field", entity: "wifi_network", entity_id: row.id, detail: { ssid: sv.ssid, serial: dv.serial } });
              note = ` Saved for other screens: other Pis can join ${sv.ssid} with one tap.`;
            }
          }
        }
        Object.assign(c, { status: r.status === "done" ? "done" : "failed", result: String(r.result ?? "").slice(0, c.command === "wifi_scan" ? 4000 : 500) + note, payload: null, save: null, done_at: t });
      }
      const hourAgo = new Date(Date.parse(t) - 3600_000).toISOString();
      T.device_commands.filter((c) => c.device_id === dv.id && ["pending", "sent"].includes(c.status) && c.created_at < hourAgo).forEach((c) => { c.status = "expired"; c.payload = null; c.save = null; });
      const pending = T.device_commands.filter((c) => c.device_id === dv.id && c.status === "pending").sort((a, b) => a.id - b.id);
      // 13-tech.sql: each command goes out with its payload, which is cleared as it's handed over (20: save stays, never sent)
      const handed = pending.map((c) => ({ id: c.id, command: c.command, ...(c.payload != null ? { payload: c.payload } : {}) }));
      pending.forEach((c) => Object.assign(c, { status: "sent", sent_at: t, payload: null }));
      const sc = T.screens.find((s) => s.id === dv.screen_id);
      return { screen: sc?.key ?? null, commands: handed };
    },
    // Mirror of 23-info-panel.sql: may this screen ask Google for travel times now?
    traffic_claim({ p_key, p_device }) {
      let s;
      if (p_device) { const dv = T.devices.find((d) => d.serial === p_device); s = dv && T.screens.find((x) => x.id === dv.screen_id); }
      else s = T.screens.find((x) => x.key === p_key);
      if (!s) return { off: "no such screen" };
      const d = T.directories.find((x) => x.id === s.directory_id);
      if (!d || !d.times_enabled) return { off: "switched off" };
      const p = T.properties.find((x) => x.id === d.property_id);
      if (!(p.destinations || []).length) return { off: "no destinations" };
      if (p.lat == null && !String(p.address || "").trim()) return { off: "no building location" };
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: p.timezone || "America/Chicago", weekday: "short", hour: "numeric", hourCycle: "h23" })
        .formatToParts(new Date(now())).map((x) => [x.type, x.value]));
      if (["Sat", "Sun"].includes(parts.weekday) || Number(parts.hour) < 6 || Number(parts.hour) >= 19) return { off: "hours" };
      const t = Date.parse(now());
      if (s.traffic_at && Date.parse(s.traffic_at) > t - 25 * 60000) return { wait: Math.ceil((Date.parse(s.traffic_at) + 25 * 60000 - t) / 1000) };
      s.traffic_at = now();
      return { origin: { lat: p.lat, lon: p.lon, address: p.address }, destinations: p.destinations };
    },
    // Mirrors of 24-directory-to-go.sql
    togo_page({ p_code }) {
      const d = T.directories.find((x) => x.togo_code === String(p_code || "").toUpperCase());
      if (!d || !d.togo_enabled) return { missing: true };
      const p = T.properties.find((x) => x.id === d.property_id);
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(now()));
      const row = T.togo_scans.find((x) => x.directory_id === d.id && x.day === day);
      if (row) row.scans++; else T.togo_scans.push({ directory_id: d.id, day, scans: 1 });
      return {
        dir: { title: d.title, subtitle: d.subtitle, footer_override: d.footer_override, amenities_enabled: d.amenities_enabled },
        prop: { name: p.name, address: p.address, logo: p.logo, logo_replaces_name: p.logo_replaces_name, company_logo: p.company_logo, logo_swap: p.logo_swap,
          managed_by: p.managed_by, leased_by: p.leased_by, footer: p.footer, place_lists: p.place_lists || [] },
        tenants: order(T.tenants.filter((t) => t.directory_id === d.id), "sort,name").map(({ name, suite, note }) => ({ name, suite, note })),
      };
    },
    togo_scan_count({ p_directory }, who) {
      const me = who.profile;
      if (!(who.service || me?.role === "platform_admin" || (me && dirOrg(p_directory) === me.org_id))) throw Object.assign(new Error("That directory doesn't exist, or you don't have access to it."), { status: 403 });
      const since = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(Date.parse(now()) - 30 * 86400_000));
      const rows = T.togo_scans.filter((x) => x.directory_id === p_directory);
      return { last30: rows.filter((x) => x.day > since).reduce((n, x) => n + x.scans, 0), total: rows.reduce((n, x) => n + x.scans, 0) };
    },
    togo_replace_code({ p_directory }, who) {
      const me = who.profile, d = T.directories.find((x) => x.id === p_directory);
      if (!d || !(who.service || me?.role === "platform_admin" || (me && dirOrg(p_directory) === me.org_id))) throw Object.assign(new Error("That directory doesn't exist, or you don't have access to it."), { status: 403 });
      let c; do { c = newCode(); } while (T.directories.some((x) => x.togo_code === c));
      d.togo_code = c; d.updated_at = now();
      return c;
    },
    // 31-menu-to-go.sql: the phone menu's content, the building (the most recently seen screen showing it, else the
    // account's first by name), and its opens
    menu_page({ p_code, p_count = true }) {
      const l = T.layouts.find((x) => x.menu_code === String(p_code || "").toUpperCase());
      if (!l || l.published_version == null) return { missing: true };
      // 37-sample-menus.sql: a board in a WayTuGo samples account answers only while one of its sample links is open
      if (T.organizations.find((o) => o.id === l.org_id)?.kind === "samples" && !T.sample_links.some((x) => x.layout_id === l.id && !x.turned_off_at && Date.parse(x.expires_at) > Date.parse(now()))) return { missing: true };
      const lv = T.layout_versions.find((x) => x.layout_id === l.id && x.version === l.published_version);
      const scr = T.screens.filter((x) => x.layout_id === l.id && x.property_id).sort((a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")))[0];
      // 36: a board on no screen names the building of its newest sample link still open
      const sl = T.sample_links.filter((x) => x.layout_id === l.id && x.property_id && !x.turned_off_at && Date.parse(x.expires_at) > Date.parse(now())).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      const p = (scr && T.properties.find((x) => x.id === scr.property_id)) || (sl && T.properties.find((x) => x.id === sl.property_id)) || order(T.properties.filter((x) => x.org_id === l.org_id), "name")[0] || null;
      if (p_count) {
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(now()));
        const row = T.menu_scans.find((x) => x.layout_id === l.id && x.day === day);
        if (row) row.scans++; else T.menu_scans.push({ layout_id: l.id, day, scans: 1 });
      }
      const m = l.menu_id ? T.menus.find((x) => x.id === l.menu_id) : null;   // 32-menus.sql
      return { layout: { id: l.id, name: l.name, orientation: l.orientation, version: lv.version, doc: lv.doc, menu_code: l.menu_code },
        lists: m ? { id: m.id, spec: m.spec, content: m.content } : null,
        images: Object.fromEntries(T.layout_images.filter((i) => i.org_id === l.org_id && (JSON.stringify(lv.doc) + JSON.stringify(m?.content || {})).includes(`"img:${i.key}"`)).map((i) => [i.key, { path: i.path, w: i.width, h: i.height }])),
        prop: p ? { id: p.id, name: p.name, address: p.address, timezone: p.timezone, lat: p.lat, lon: p.lon, updated_at: p.updated_at } : null };
    },
    // 36-templates.sql: a sample link's page (the site only)
    sample_page({ p_slug, p_open = false }) {
      const s = T.sample_links.find((x) => x.slug === String(p_slug || "").toLowerCase());
      if (!s) return { missing: true };
      if (s.turned_off_at || Date.parse(s.expires_at) <= Date.parse(now())) return { ended: true, until: s.turned_off_at && s.turned_off_at < s.expires_at ? s.turned_off_at : s.expires_at };
      const r = FUNCS.menu_page({ p_code: T.layouts.find((x) => x.id === s.layout_id)?.menu_code, p_count: false });
      if (r.missing) return r;
      const p = s.property_id && T.properties.find((x) => x.id === s.property_id);
      if (p) r.prop = { id: p.id, name: p.name, address: p.address, timezone: p.timezone, lat: p.lat, lon: p.lon, updated_at: p.updated_at };
      if (p_open) { s.opens++; s.last_open_at = now(); }
      return { ...r, sample: { slug: s.slug, until: s.expires_at } };
    },
    // 36: copying a shop into an account (the site only; all or nothing)
    shop_copy({ p_from, p_org, p_name, p_content, p_layouts, p_images, p_property, p_by }) {
      const fail = (m, status = 400) => { throw Object.assign(new Error(m), { status }); };
      const src = T.menus.find((x) => x.id === p_from); if (!src) fail("No such menu.", 404);
      const org = T.organizations.find((x) => x.id === p_org); if (!org) fail("No such account.", 404);
      if (!Array.isArray(p_layouts) || !p_layouts.length) fail(`The menu "${src.name}" has no boards to copy.`);
      const have = T.layout_images.filter((x) => x.org_id === p_org).length, room = org.picture_room ?? 100;
      if (have + (p_images || []).length > room) fail(`That account has room for ${room} pictures and has ${have} already; this shop brings ${(p_images || []).length}. Give it more room under Accounts first.`);
      const snap = JSON.stringify({ i: T.layout_images, m: T.menus, r: T.menu_revisions, l: T.layouts, v: T.layout_versions, p: T.properties });
      try {
        for (const x of p_images || []) {
          if (!String(x.path).startsWith(`${p_org}/`)) fail("A copied picture must be in the account's own folder.");
          if (T.layout_images.some((i) => i.org_id === p_org && i.key === x.key)) fail("duplicate key value violates unique constraint \"layout_images_org_id_key_key\"", 409);
          T.layout_images.push({ ...defaults.layout_images(), org_id: p_org, key: x.key, name: x.name || "", path: x.path, mime: x.mime, width: x.width, height: x.height, bytes: x.bytes, created_by: p_by });
        }
        const menu = { ...defaults.menus(), org_id: p_org, name: String(p_name).trim().slice(0, 80), customer_edit: src.customer_edit, spec: src.spec, content: p_content, rev: 1, updated_by: p_by };
        const bad = menuRule(menu, null); if (bad) fail(bad);
        T.menus.push(menu);
        const pr = T.profiles.find((x) => x.user_id === p_by);
        T.menu_revisions.push({ menu_id: menu.id, rev: 1, content: p_content, saved_at: now(), saved_by: p_by, by_name: pr?.full_name || pr?.email || "", by_1point: true, restored_from: null });
        const outL = [];
        for (const x of p_layouts) {
          const l = T.layouts.find((y) => y.id === x.from && y.menu_id === p_from); if (!l) fail(`A board to copy isn't on the menu "${src.name}".`);
          const nl = { ...defaults.layouts(), id: x.id, org_id: p_org, name: String(x.name).trim().slice(0, 80), family: l.family, orientation: l.orientation, draft: x.draft || {}, menu_id: menu.id, updated_by: p_by };
          T.layouts.push(nl);
          if (x.doc && typeof x.doc === "object") {
            T.layout_versions.push({ layout_id: nl.id, version: 1, doc: x.doc, checks: {}, overridden: false, note: `Copied from "${l.name}"`.slice(0, 200), rolled_back_from: null, published_at: now(), published_by: p_by });
            Object.assign(nl, { published_version: 1, published_at: now() });
          }
          outL.push({ id: nl.id, from: x.from, name: nl.name });
        }
        for (const k of Object.keys(p_content?.boards || {})) if (!p_layouts.some((x) => x.id === k)) fail("A board look in the copy names a board that isn't in it.");
        let property_id = null;
        if (p_property && typeof p_property === "object") {
          const row = { ...defaults.properties(), org_id: p_org, name: String(p_property.name).trim().slice(0, 80), address: String(p_property.address || "").slice(0, 200), lat: p_property.lat ?? null, lon: p_property.lon ?? null, timezone: p_property.timezone || "America/Chicago", updated_by: p_by };
          T.properties.push(row); property_id = row.id;
        }
        T.audit_log.push({ id: T.audit_log.length + 1, at: now(), user_id: p_by, action: "copy shop", entity: "menu", entity_id: menu.id, detail: { from: p_from, org: p_org } });
        return { menu_id: menu.id, layouts: outL, property_id };
      } catch (e) {
        const b = JSON.parse(snap);
        T.layout_images.splice(0, Infinity, ...b.i); T.menus.splice(0, Infinity, ...b.m); T.menu_revisions.splice(0, Infinity, ...b.r);
        T.layouts.splice(0, Infinity, ...b.l); T.layout_versions.splice(0, Infinity, ...b.v); T.properties.splice(0, Infinity, ...b.p);
        throw e;
      }
    },
    menu_scan_count({ p_layout }, who) {
      const me = who.profile;
      if (!(who.service || me?.role === "platform_admin" || (me && layoutOrg(p_layout) === me.org_id))) throw Object.assign(new Error("That layout doesn't exist, or you don't have access to it."), { status: 403 });
      const since = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(Date.parse(now()) - 30 * 86400_000));
      const rows = T.menu_scans.filter((x) => x.layout_id === p_layout);
      return { last30: rows.filter((x) => x.day > since).reduce((n, x) => n + x.scans, 0), total: rows.reduce((n, x) => n + x.scans, 0) };
    },
    // 34-customer-pictures.sql: refused while on the boards now (a menu's lists, or a layout's draft or kept version);
    // a picture only an old menu save used can go
    layout_image_check({ p_id }) {
      const i = T.layout_images.find((x) => x.id === p_id);
      if (!i) throw Object.assign(new Error("That picture is already gone."), { status: 404 });
      const says = (doc) => JSON.stringify(doc || {}).includes(`"img:${i.key}"`);
      const menus = T.menus.filter((m) => m.org_id === i.org_id && says(m.content));
      if (menus.length) throw Object.assign(new Error(`The picture "${i.name || i.key}" is on the boards now (${menus.map((m) => m.name).join(", ")}). Choose another picture for those items first.`), { status: 400 });
      const lays = T.layouts.filter((l) => l.org_id === i.org_id && (says(l.draft) || T.layout_versions.some((v) => v.layout_id === l.id && says(v.doc))));
      if (lays.length) throw Object.assign(new Error(`The picture "${i.name || i.key}" is part of the layout ${lays.map((l) => l.name).join(", ")}, so only WayTuGo can take it off. Ask WayTuGo.`), { status: 400 });
      return i.path;
    },
    layout_image_delete({ p_id }, who) {
      const path = FUNCS.layout_image_check({ p_id }, who);
      T.layout_images = T.layout_images.filter((x) => x.id !== p_id);
      return path;
    },
    // 32-menus.sql: saving a menu as the signed-in user (menu_write's rules), restoring, and "Make lists" (the site only)
    menu_save({ p_menu, p_base_rev, p_content }, who) { return menuWrite(p_menu, p_base_rev, p_content, null, who); },
    menu_restore({ p_menu, p_rev, p_base_rev }, who) {
      const m = T.menus.find((x) => x.id === p_menu), me = who.profile;
      if (!m || !(who.service || me?.role === "platform_admin" || me?.org_id === m.org_id)) throw Object.assign(new Error("That menu doesn't exist, or you don't have access to it."), { status: 403 });
      const old = T.menu_revisions.find((x) => x.menu_id === p_menu && x.rev === p_rev);
      if (!old) throw Object.assign(new Error(`This menu has no revision ${p_rev}.`), { status: 404 });
      // 34: entries whose picture has since been removed come back without it
      let cleared = 0;
      const pics = new Set(T.layout_images.filter((i) => i.org_id === m.org_id).map((i) => `img:${i.key}`));
      const content = JSON.parse(JSON.stringify(old.content));
      for (const c of Object.values(content.lists || {})) for (const e of c.entries || []) if (e.image && !pics.has(e.image)) { delete e.image; cleared++; }
      return { ...menuWrite(p_menu, p_base_rev, content, p_rev, who), pictures_cleared: cleared };
    },
    menu_create({ p_org, p_name, p_spec, p_content, p_by, p_layout, p_draft }) {
      const row = { ...defaults.menus(), org_id: p_org, name: p_name, spec: p_spec, content: p_content, rev: 1, updated_by: p_by || null };
      const bad = menuRule(row, null); if (bad) throw Object.assign(new Error(bad), { status: 400 });
      const l = p_layout ? T.layouts.find((x) => x.id === p_layout && x.org_id === p_org) : null;
      if (p_layout && !l) throw Object.assign(new Error("No such layout in that account."), { status: 404 });
      T.menus.push(row);
      const pr = T.profiles.find((x) => x.user_id === p_by);
      T.menu_revisions.push({ menu_id: row.id, rev: 1, content: p_content, saved_at: now(), saved_by: p_by || null, by_name: pr?.full_name || pr?.email || "", by_1point: true, restored_from: null });
      if (l) Object.assign(l, { menu_id: row.id, draft: p_draft || l.draft, updated_at: now(), updated_by: p_by || null });
      return row.id;
    },
    // 33-menu-specials.sql: more lists on a menu (the site only)
    menu_add_lists({ p_menu, p_lists, p_content, p_by, p_layout, p_draft }) {
      const m = T.menus.find((x) => x.id === p_menu);
      if (!m) throw Object.assign(new Error("No such menu."), { status: 404 });
      for (const l of p_lists) if (m.spec.lists.some((x) => x.key === l.key)) throw Object.assign(new Error(`The menu "${m.name}" already has a list "${l.key}".`), { status: 409 });
      const next = { ...m, spec: { lists: [...m.spec.lists, ...p_lists] }, content: { ...m.content, lists: { ...(m.content.lists || {}), ...(p_content || {}) } } };   // 35: boards kept
      const bad = menuRule(next, m); if (bad) throw Object.assign(new Error(bad), { status: 400 });
      const l = p_layout ? T.layouts.find((x) => x.id === p_layout && x.org_id === m.org_id) : null;
      if (p_layout && !l) throw Object.assign(new Error("No such layout in that menu's account."), { status: 404 });
      Object.assign(m, { spec: next.spec, content: next.content, rev: m.rev + 1, updated_at: now(), updated_by: p_by || null });
      const pr = T.profiles.find((x) => x.user_id === p_by);
      T.menu_revisions.push({ menu_id: m.id, rev: m.rev, content: m.content, saved_at: now(), saved_by: p_by || null, by_name: pr?.full_name || pr?.email || "", by_1point: true, restored_from: null });
      if (l) Object.assign(l, { menu_id: m.id, draft: p_draft || l.draft, updated_at: now(), updated_by: p_by || null });
      return m.rev;
    },
    // 29-layout-engine.sql: publish and roll back, the site only (not in USER_FUNCS)
    layout_publish({ p_layout, p_doc, p_checks, p_overridden, p_note, p_by }) {
      const l = T.layouts.find((x) => x.id === p_layout);
      if (!l) throw Object.assign(new Error("No such layout."), { status: 404 });
      if ((p_doc?.orientation || "") !== l.orientation) throw Object.assign(new Error(`This layout is ${l.orientation}, so the layout's "orientation" must be "${l.orientation}".`), { status: 400 });
      const v = Math.max(0, ...T.layout_versions.filter((x) => x.layout_id === l.id).map((x) => x.version)) + 1;
      T.layout_versions.push({ layout_id: l.id, version: v, doc: p_doc, checks: p_checks || {}, overridden: !!p_overridden, note: String(p_note || "").slice(0, 200), rolled_back_from: null, published_at: now(), published_by: p_by || null });
      Object.assign(l, { draft: p_doc, published_version: v, published_at: now(), updated_at: now(), updated_by: p_by || null });
      T.audit_log.push({ id: T.audit_log.length + 1, at: now(), user_id: p_by, action: "publish layout", entity: "layout", entity_id: l.id, detail: { version: v } });
      return v;
    },
    layout_rollback({ p_layout, p_version, p_by }) {
      const l = T.layouts.find((x) => x.id === p_layout);
      if (!l) throw Object.assign(new Error("No such layout."), { status: 404 });
      const old = T.layout_versions.find((x) => x.layout_id === l.id && x.version === p_version);
      if (!old) throw Object.assign(new Error(`This layout has no version ${p_version}.`), { status: 404 });
      const v = Math.max(...T.layout_versions.filter((x) => x.layout_id === l.id).map((x) => x.version)) + 1;
      T.layout_versions.push({ ...old, version: v, note: `Rolled back to version ${p_version}`, rolled_back_from: p_version, published_at: now(), published_by: p_by || null });
      Object.assign(l, { draft: old.doc, published_version: v, published_at: now(), updated_at: now(), updated_by: p_by || null });
      return v;
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
      if (s.layout_id) {   // 29-layout-engine.sql: a layout screen
        const l = T.layouts.find((x) => x.id === s.layout_id);
        const lv = l?.published_version != null ? T.layout_versions.find((x) => x.layout_id === l.id && x.version === l.published_version) : null;
        const lp = s.property_id ? T.properties.find((x) => x.id === s.property_id) : null;
        const m = l.menu_id ? T.menus.find((x) => x.id === l.menu_id) : null;   // 32-menus.sql
        const etag = createHash("md5").update([m?.id || "-", m?.rev ?? "-", m?.updated_at || "-", "layout", "menu", l.menu_code, s.key, s.name, s.orientation, l.id, l.published_version ?? "-", l.name, s.identify_until || "-", lp?.updated_at || "-", String(!!s.hide_powered_by), String(!!s.touch), s.screen_inches ?? "-", String(s.touch_idle_s ?? 45)].join("|")).digest("hex");
        if (etag === p_etag) return { etag, not_modified: true };
        return { etag, kind: "layout",
          screen: { key: s.key, name: s.name, orientation: s.orientation, identify_until: s.identify_until ?? null, hide_powered_by: !!s.hide_powered_by, touch: !!s.touch, screen_inches: s.screen_inches ?? null, touch_idle_s: s.touch_idle_s ?? 45 },
          layout: { id: l.id, name: l.name, orientation: l.orientation, version: lv?.version ?? null, doc: lv ? lv.doc : null, menu_code: l.menu_code },
          lists: m ? { id: m.id, spec: m.spec, content: m.content } : null,
          images: lv ? Object.fromEntries(T.layout_images.filter((i) => i.org_id === l.org_id && (JSON.stringify(lv.doc) + JSON.stringify(m?.content || {})).includes(`"img:${i.key}"`)).map((i) => [i.key, { path: i.path, w: i.width, h: i.height }])) : {},
          prop: lp ? { id: lp.id, name: lp.name, address: lp.address, timezone: lp.timezone, lat: lp.lat, lon: lp.lon, updated_at: lp.updated_at } : null };
      }
      const d = s.directory_id ? T.directories.find((x) => x.id === s.directory_id) : null;
      const p = d ? T.properties.find((x) => x.id === d.property_id) : null;
      const etag = createHash("md5").update([s.key, s.name, s.orientation, s.directory_id || "-", s.identify_until || "-", d?.updated_at || "-", p?.updated_at || "-", JSON.stringify(s.sizes || {}), String(!!s.hide_powered_by), String(!!s.touch), s.screen_inches ?? "-", String(s.touch_idle_s ?? 45)].join("|")).digest("hex");
      if (etag === p_etag) return { etag, not_modified: true };
      // 26-people.sql: people only on touch screens, with the company's switch on, ticked Show, and the details it shows
      const peopleOf = (cid) => {
        const c = T.companies.find((x) => x.id === cid);
        if (!s.touch || !c?.show_people) return [];
        return [...T.people.filter((x) => x.company_id === cid && x.show !== false)]
          .sort((a, b) => a.sort - b.sort || a.last_name.toLowerCase().localeCompare(b.last_name.toLowerCase()) || a.first_name.toLowerCase().localeCompare(b.first_name.toLowerCase()))
          .map((x) => ({ first: x.first_name, last: x.last_name, title: c.show_title ? x.title : "", phone: c.show_phone ? x.phone : "", email: c.show_email ? x.email : "", suite: x.suite }));
      };
      const tenants = d ? order(T.tenants.filter((t) => t.directory_id === d.id), "sort,name").map(({ name, suite, arrow, note, sort, company_id }) => ({ name, suite, arrow, note, sort, people: peopleOf(company_id) })) : [];
      return { etag, screen: { key: s.key, name: s.name, orientation: s.orientation, identify_until: s.identify_until ?? null, sizes: s.sizes || {}, hide_powered_by: !!s.hide_powered_by, touch: !!s.touch, screen_inches: s.screen_inches ?? null, touch_idle_s: s.touch_idle_s ?? 45 }, dir: d ? { ...d } : null, prop: p ? { ...p } : null, tenants };
    },
  };
  function menuWrite(id, base, content, from, who) {
    const m = T.menus.find((x) => x.id === id), me = who.profile;
    const admin = !!who.service || me?.role === "platform_admin";
    if (!m || !(admin || (me?.org_id === m.org_id && ["org_admin", "org_editor"].includes(me?.role)))) throw Object.assign(new Error("That menu doesn't exist, or you don't have access to it."), { status: 403 });
    if (!admin && !m.customer_edit) throw Object.assign(new Error("WayTuGo keeps this menu up to date for you. Contact WayTuGo for changes."), { status: 403 });
    if (base !== m.rev) {
      const last = T.menu_revisions.find((x) => x.menu_id === m.id && x.rev === m.rev);
      throw Object.assign(new Error(`Someone else saved this menu after you opened it (${last?.by_name || "another user"}). Reload to see their changes, then make yours again.`), { status: 409 });
    }
    let c = content || { lists: {} };
    // 38-brand.sql: the brand is 1Point's; anyone else's save or Restore keeps the menu's brand as it is
    if (!admin) { const { brand, ...rest } = c; c = m.content?.brand ? { ...rest, brand: m.content.brand } : rest; }
    const next = { ...m, content: c };
    const bad = menuRule(next, m); if (bad) throw Object.assign(new Error(bad), { status: 400 });
    Object.assign(m, { content: next.content, rev: m.rev + 1, updated_at: now(), updated_by: who.uid || null });
    const at = now();
    T.menu_revisions.push({ menu_id: m.id, rev: m.rev, content: m.content, saved_at: at, saved_by: who.uid || null, by_name: me?.full_name || me?.email || "", by_1point: admin, restored_from: from });
    return { rev: m.rev, saved_at: at };
  }
  async function rpc(req, name) {
    const who = whoFrom(req);
    if (!who) return err(401, "Invalid API key");
    if (!FUNCS[name]) return err(404, `Could not find the function public.${name}`);
    if (!who.service && !(USER_FUNCS.has(name) && who.uid)) return err(403, `permission denied for function ${name}`);
    if (req.method !== "POST") return err(405, "Method not allowed");
    rpcCalls.push(name);
    let result;
    try { result = FUNCS[name](await req.json(), who); } catch (e) { return err(e.status || 400, e.message); }
    return out(Array.isArray(result) ? result.slice(0, MAX_ROWS) : result);
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

  // Supabase Storage, as far as the site uses it (E1b): upload with the service key (never overwriting), remove
  const storageStuck = new Set();   // tests: paths Storage "fails" to remove (to prove nothing else is removed then)
  async function storageApi(req, rest) {
    const who = whoFrom(req);
    if (!who?.service) return err(403, "new row violates row-level security policy");
    if (req.method === "POST" && rest === "copy") {   // T0: a shop's pictures copied into another account
      const { bucketId, sourceKey, destinationKey } = await req.json().catch(() => ({}));
      const src = storage.get(`${bucketId}/${sourceKey}`);
      if (!src) return err(404, "Object not found");
      if (storage.has(`${bucketId}/${destinationKey}`)) return err(409, "The resource already exists");
      storage.set(`${bucketId}/${destinationKey}`, { ...src, at: new Date().toISOString() });
      return out({ Key: `${bucketId}/${destinationKey}` }, 200);
    }
    if (req.method === "POST" && rest.startsWith("list/")) {   // Storage's list of a folder (E2c)
      const bucket = rest.slice(5);
      const { prefix = "", search = "", limit = 100, offset = 0 } = await req.json().catch(() => ({}));
      const dir = `${bucket}/${prefix.replace(/\/+$/, "")}/`;
      const names = [...storage.keys()].filter((k) => k.startsWith(dir) && !k.slice(dir.length).includes("/")).map((k) => k.slice(dir.length))
        .filter((n) => n.toLowerCase().startsWith(String(search).toLowerCase())).sort();
      return out(names.slice(offset, offset + limit).map((name) => ({ name, id: randomUUID(), created_at: storage.get(dir + name).at || "2026-01-01T00:00:00Z", metadata: {} })));
    }
    if (req.method === "POST") {
      if (storage.has(rest)) return err(409, "The resource already exists");
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > 1048576) return err(413, "The object exceeded the maximum allowed size");
      storage.set(rest, { bytes, mime: req.headers.get("content-type"), cacheControl: req.headers.get("cache-control"), at: new Date().toISOString() });
      return out({ Key: rest }, 200);
    }
    if (req.method === "DELETE") {
      const { prefixes = [] } = await req.json().catch(() => ({}));
      const gone = [];
      for (const p of prefixes) if (!storageStuck.has(p) && storage.delete(`${rest}/${p}`)) gone.push({ name: p });
      return out(gone);
    }
    return err(405, "Method not allowed");
  }

  async function handle(req) {
    const url = new URL(req.url);
    // 31-menu-to-go.sql: every layout has a menu code (a trigger makes it; tests that add layouts directly get one here)
    for (const l of T.layouts) if (!l.menu_code) { let c; do { c = newCode(); } while (T.layouts.some((x) => x.menu_code === c)); l.menu_code = c; }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/__outbox") return out(outbox);
    if (url.pathname.startsWith("/storage/v1/object/")) return storageApi(req, url.pathname.slice(19));
    if (url.pathname.startsWith("/rest/v1/rpc/")) return rpc(req, url.pathname.slice(13));
    if (url.pathname.startsWith("/rest/v1/")) return rest(req, url.pathname.slice(9), url.searchParams);
    if (url.pathname.startsWith("/auth/v1")) return authApi(req, url.pathname.slice(8), url);
    return err(404, "not found");
  }

  seed();
  for (const o of T.organizations) o.picture_room ??= 100;   // 34-customer-pictures.sql
  return { handle, T, storage, storageStuck, users, outbox, addUser, rpcCalls, restCalls, deviceCredit, setClock: (d) => { clock = d ? new Date(d) : null; } };
}
