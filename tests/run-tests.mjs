// Run with: npm test
// Every server function, against a fake Supabase with the same access rules as the real one. No network needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFake, SERVICE_KEY, ANON_KEY } from "./fake-supabase.mjs";
import { getStore, _reset } from "./blobs-stub.mjs";
import screen, { toPayload } from "../netlify/functions/screen.mjs";
import heartbeat from "../netlify/functions/heartbeat.mjs";
import users from "../netlify/functions/users.mjs";
import migrate from "../netlify/functions/migrate.mjs";
import config from "../netlify/functions/config.mjs";
import weather, { iconFor } from "../netlify/functions/weather.mjs";
import news from "../netlify/functions/news.mjs";
import agent from "../netlify/functions/agent.mjs";
import devices from "../netlify/functions/devices.mjs";
import { runAlerts, evaluate } from "../netlify/functions/alerts.mjs";
import { computeSummary } from "../netlify/functions/devices.mjs";
import { centralDay } from "../netlify/functions/agent.mjs";
import { parseFeed, isBlocked } from "../netlify/lib/rss.mjs";

const SB = "http://fake.supabase.test";
Object.assign(process.env, { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: SERVICE_KEY, SUPABASE_ANON_KEY: ANON_KEY });
const fake = createFake();
const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const SITE = "https://1pdirectory.netlify.app";

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith(SB)) return fake.handle(new Request(u, init));
  const ok = (b) => new Response(b, { status: 200 });
  if (u.includes("api.weather.gov/points/")) return ok(fx("nws-points.json"));
  if (u.includes("/forecast/hourly")) return ok(fx("nws-hourly.json"));
  if (u.includes("bbci")) return ok(fx("bbc.xml"));
  if (u.includes("npr")) return ok(fx("npr.xml"));
  if (u.includes("broken")) return new Response("nope", { status: 500 });
  throw new Error("unexpected fetch " + u);
};

const req = (path, { method = "GET", body, token, headers = {} } = {}) =>
  new Request(SITE + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
async function login(email, password) {
  const r = await fake.handle(new Request(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON_KEY }, body: JSON.stringify({ email, password }) }));
  return (await r.json()).access_token;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── Screens ──
test("a landscape Perimeter Park screen gets its title, subtitle, arrows, notes and footer", async () => {
  const r = await screen(req("/api/screen?key=ppi-1s"));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.propertyName, "Perimeter Park One - One South");
  assert.equal(d.buildingLabel, "South Tower");
  assert.equal(d.orientation, "landscape");
  assert.equal(d.tenants.length, 5);
  assert.deepEqual(d.tenants[1], { name: "Common Bond Title, LLC", suite: "130 S", dir: "left", note: "A subsidiary of Affiliates Consolidated Services" });
  assert.match(d.welcome, /205-795-4732/);
});

test("the Landmark Center's existing address (?site=) still works", async () => {
  const d = await (await screen(req("/api/screen?site=landmark-center"))).json();
  assert.equal(d.propertyName, "The Landmark Center");
  assert.equal(d.tenants.length, 8);
  assert.equal(d.managedBy.name, "Leigh Ann Kornegay");
  assert.equal(d.buildingLabel, "2100 1st Avenue North, Birmingham", "no subtitle, so the address shows");
});

test("unknown screens are 404, bad addresses 400, unassigned screens say so", async () => {
  assert.equal((await screen(req("/api/screen?key=nope"))).status, 404);
  assert.equal((await screen(req("/api/screen?key=../x"))).status, 400);
  fake.T.screens.push({ id: "s-new", key: "spare-1", name: "Spare", directory_id: null, orientation: "auto", hardware: {}, last_report: {} });
  const d = await (await screen(req("/api/screen?key=spare-1"))).json();
  assert.equal(d.assigned, false);
  assert.equal(d.tenants.length, 0);
});

test("screens re-download only when something changed (304)", async () => {
  const r1 = await screen(req("/api/screen?key=ppi-2s"));
  const etag = r1.headers.get("ETag");
  assert.equal((await screen(req("/api/screen?key=ppi-2s", { headers: { "If-None-Match": etag } }))).status, 304);
  // Edit a tenant the way the editor does (through the database, which marks the directory changed)
  const d = fake.T.directories.find((x) => x.slug === "ppi-2s");
  const t = fake.T.tenants.find((x) => x.directory_id === d.id);
  await new Promise((r) => setTimeout(r, 5));
  await fake.handle(new Request(`${SB}/rest/v1/tenants?id=eq.${t.id}`, { method: "PATCH", headers: { apikey: SERVICE_KEY }, body: JSON.stringify({ name: "Evan Terry Associates, LLC (edited)" }) }));
  const r2 = await screen(req("/api/screen?key=ppi-2s", { headers: { "If-None-Match": etag } }));
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).tenants[0].name, "Evan Terry Associates, LLC (edited)");
  assert.equal((await screen(req("/api/screen?key=ppi-2s", { headers: { "If-None-Match": `W/${r2.headers.get("ETag")}` } }))).status, 304, "weak ETags from the CDN count too");
});

test("a screen's check costs one database call, and records its check-in at most every 4 minutes", async () => {
  const s = fake.T.screens.find((x) => x.key === "ppii-5e");
  s.last_seen = null;
  const rest = fake.restCalls.length, calls = fake.rpcCalls.length;
  const look = (etag) => screen(req("/api/screen?key=ppii-5e", { headers: { "X-Screen-Size": "1920x1080", "X-Display-Version": "2.1.0", ...(etag ? { "If-None-Match": etag } : {}) } }));
  const r1 = await look();
  assert.equal(r1.status, 200);
  assert.equal(fake.rpcCalls.length - calls, 1); assert.equal(fake.restCalls.length - rest, 0, "no other trips to the database");
  assert.ok(s.last_seen, "check-in recorded");
  assert.deepEqual([s.last_report.w, s.last_report.h, s.last_report.version], [1920, 1080, "2.1.0"]);
  const seen = s.last_seen;
  assert.equal((await look(r1.headers.get("ETag"))).status, 304);
  assert.equal(s.last_seen, seen, "not re-recorded within 4 minutes");
  s.last_seen = new Date(Date.now() - 5 * 60000).toISOString();
  await look(r1.headers.get("ETag"));
  assert.notEqual(s.last_seen, seen, "recorded again after 4 minutes");
  const before = s.last_seen;
  await screen(req("/api/screen?key=ppii-5e"));
  assert.equal(s.last_seen, before, "a request without the display's headers isn't a check-in");
});

test("Identify reaches a screen on its next check even if nothing else changed", async () => {
  const r1 = await screen(req("/api/screen?key=ppii-3w"));
  const etag = r1.headers.get("ETag");
  fake.T.screens.find((x) => x.key === "ppii-3w").identify_until = new Date(Date.now() + 90000).toISOString();
  const r2 = await screen(req("/api/screen?key=ppii-3w", { headers: { "If-None-Match": etag } }));
  assert.equal(r2.status, 200);
  assert.ok((await r2.json()).identifyUntil);
});

test("the editor preview and real screens use the same fields", () => {
  const p = toPayload({ key: "k", name: "n", orientation: "portrait" }, { title: "T", subtitle: "", footer_override: null, news_enabled: false, weather_enabled: true, rotate_seconds: 9 },
    { address: "A", logo: "", lat: 1, lon: 2, footer: "F", managed_by: {}, leased_by: {} }, [{ name: "X", suite: "1", arrow: "up", note: "" }]);
  assert.equal(p.buildingLabel, "A"); assert.equal(p.welcome, "F"); assert.equal(p.news.enabled, false); assert.equal(p.news.rotateSeconds, 9);
  assert.deepEqual(p.tenants[0], { name: "X", suite: "1", dir: "up", note: "" });
});

// ── Check-ins ──
test("heartbeat records the check-in on the screen", async () => {
  const r = await heartbeat(req("/api/heartbeat", { method: "POST", body: { key: "ppii-4e", screen: { w: 1920, h: 1080 }, version: "2.0.0" } }));
  assert.equal(r.status, 200);
  const s = fake.T.screens.find((x) => x.key === "ppii-4e");
  assert.ok(s.last_seen);
  assert.equal(s.last_report.w, 1920);
  assert.equal((await heartbeat(req("/api/heartbeat", { method: "POST", body: { key: "ghost" } }))).status, 404);
  assert.equal((await heartbeat(req("/api/heartbeat", { method: "POST", body: { key: "Bad Key" } }))).status, 400);
});

// ── Users and permissions ──
test("who sees which people", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const owner = await login("leighann@barber.test", "owner-pass");
  const editor = await login("editor@barber.test", "editor-pass");
  assert.equal((await users(req("/api/users"))).status, 401, "not signed in");
  assert.equal((await users(req("/api/users", { token: "bogus" }))).status, 401);
  assert.equal((await (await users(req("/api/users", { token: admin }))).json()).users.length, 3);
  const mine = (await (await users(req("/api/users", { token: owner }))).json()).users;
  assert.deepEqual(mine.map((u) => u.email).sort(), ["editor@barber.test", "leighann@barber.test"], "owner admin sees only their own people");
  assert.equal((await users(req("/api/users", { token: editor }))).status, 403, "editors can't manage people");
});

test("an owner admin can invite into their own account only, and never grant 1Point access", async () => {
  const owner = await login("leighann@barber.test", "owner-pass");
  const other = fake.T.organizations.find((o) => o.name === "Other Owner LLC").id;
  const invite = (b) => users(req("/api/users", { method: "POST", token: owner, body: { action: "invite", ...b } }));
  assert.equal((await invite({ email: "x@y.test", role: "platform_admin" })).status, 403);
  assert.equal((await invite({ email: "x@y.test", role: "org_editor", org_id: other })).status, 403);
  assert.equal((await invite({ email: "not-an-email", role: "org_editor" })).status, 400);
  const r = await invite({ email: "Frontdesk2@Barber.test", full_name: "Desk Two", role: "org_editor" });
  assert.equal(r.status, 201);
  const p = fake.T.profiles.find((x) => x.email === "frontdesk2@barber.test");
  assert.equal(p.role, "org_editor");
  assert.equal(p.org_id, fake.T.organizations.find((o) => o.name === "Barber Companies").id);
  const mail = fake.outbox.at(-1);
  assert.equal(mail.type, "invite");
  assert.match(mail.link, /^https:\/\/1pdirectory\.netlify\.app\/login\.html#access_token=/);
  assert.equal((await invite({ email: "frontdesk2@barber.test", role: "org_editor" })).status, 409, "no duplicates");
});

test("sign-in email: an invitation if they never signed in, a reset if they have", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const newbie = fake.T.profiles.find((x) => x.email === "frontdesk2@barber.test");
  const leigh = fake.T.profiles.find((x) => x.email === "leighann@barber.test");
  const send = async (id) => (await (await users(req("/api/users", { method: "POST", token: admin, body: { action: "email", user_id: id } }))).json()).sent;
  assert.equal(await send(newbie.user_id), "invitation");
  assert.equal(await send(leigh.user_id), "password reset");
  assert.equal(fake.outbox.at(-1).type, "recovery");
});

test("role changes and removals respect the rules", async () => {
  const owner = await login("leighann@barber.test", "owner-pass");
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const me = fake.T.profiles.find((x) => x.email === "leighann@barber.test");
  const ed = fake.T.profiles.find((x) => x.email === "frontdesk2@barber.test");
  const patch = (t, b) => users(req("/api/users", { method: "PATCH", token: t, body: b }));
  assert.equal((await patch(owner, { user_id: ed.user_id, role: "platform_admin" })).status, 403);
  assert.equal((await patch(owner, { user_id: me.user_id, role: "org_editor" })).status, 400, "can't demote yourself");
  assert.equal((await patch(owner, { user_id: ed.user_id, role: "org_admin" })).status, 200);
  assert.equal(fake.T.profiles.find((x) => x.user_id === ed.user_id).role, "org_admin");
  const scot = fake.T.profiles.find((x) => x.role === "platform_admin");
  assert.equal((await users(req(`/api/users?user_id=${scot.user_id}`, { method: "DELETE", token: owner }))).status, 403, "owners can't remove 1Point");
  assert.equal((await users(req(`/api/users?user_id=${me.user_id}`, { method: "DELETE", token: owner }))).status, 400, "can't remove yourself");
  assert.equal((await users(req(`/api/users?user_id=${ed.user_id}`, { method: "DELETE", token: admin }))).status, 200);
  assert.ok(!fake.T.profiles.some((x) => x.user_id === ed.user_id));
  assert.ok(fake.T.audit_log.length >= 3, "actions are logged");
});

// ── Import from the old editor ──
test("1Point can import the Landmark Center's live settings; nobody else can", async () => {
  await getStore({ name: "directory" }).setJSON("sites/landmark-center", {
    propertyName: "The Landmark Center", buildingLabel: "2100 1st Avenue North, Birmingham", logo: "data:image/svg+xml;base64,PHN2Zz4=", logoReplacesName: true,
    tenants: [{ name: "EMW Law LLC.", suite: "300", dir: "" }, { name: "New Tenant", suite: "600", dir: "right" }],
    managedBy: { name: "Leigh Ann Kornegay" }, leasedBy: { name: "Weyman Prater" }, welcome: "Welcome!",
    weather: { enabled: true, lat: 33.51, lon: -86.81 }, news: { enabled: true, rotateSeconds: 15 }, background: { enabled: true, image: "data:image/jpeg;base64,/9j/", visibility: 18 },
  });
  const owner = await login("leighann@barber.test", "owner-pass");
  assert.equal((await migrate(req("/api/migrate?slug=landmark-center", { method: "POST", token: owner }))).status, 403);
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const r = await migrate(req("/api/migrate?slug=landmark-center", { method: "POST", token: admin }));
  assert.equal(r.status, 200);
  const d = await (await screen(req("/api/screen?key=landmark-center"))).json();
  assert.equal(d.tenants.length, 2);
  assert.equal(d.logoReplacesName, true);
  assert.equal(d.background.visibility, 18);
  assert.equal(d.news.rotateSeconds, 15);
  assert.equal(d.welcome, "Welcome!");
  assert.equal((await migrate(req("/api/migrate?slug=ppi-2s", { method: "POST", token: admin }))).status, 404, "nothing to import");
});

// ── Agent and devices ──
const PPI2S_SERIAL = "100000008294ba46";
const KEY = "k".repeat(43);
const checkin = (body, key = KEY) => agent(new Request(SITE + "/api/agent", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ serial: PPI2S_SERIAL, model: "Raspberry Pi 4 Model B Rev 1.5", hostname: "ppi-2s", version: "1.0.0", ...body }) }));
const devApi = (token, { method = "GET", body, qs = "" } = {}) => devices(req(`/api/devices${qs}`, { method, token, body }));

test("a Yodeck Pi enrolls on first check-in and finds its own screen by serial", async () => {
  const r = await checkin({ health: { temp_c: 51.2, under_voltage_now: false, ip: "192.168.44.21", bogus: "dropped" } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.screen, "ppi-2s", "matched by the serial from the Yodeck report");
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  assert.ok(dev.key_hash && dev.key_hash !== KEY, "key stored hashed");
  assert.equal(dev.last_health.temp_c, 51.2);
  assert.equal(dev.last_health.bogus, undefined, "unknown fields dropped");
});

test("a Pi's check-in is one database call", async () => {
  const rest = fake.restCalls.length, calls = fake.rpcCalls.length;
  assert.equal((await checkin({ health: { temp_c: 50 } })).status, 200);
  assert.deepEqual(fake.rpcCalls.slice(calls), ["agent_checkin"]);
  assert.equal(fake.restCalls.length - rest, 0);
});

test("a switched-off Pi is refused", async () => {
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  dev.status = "revoked";
  assert.equal((await checkin({})).status, 403);
  dev.status = "active";
  assert.equal((await checkin({ health: null })).status, 200, "a missing health report doesn't break the check-in");
});

test("a different key for an enrolled Pi is refused", async () => {
  assert.equal((await checkin({}, "x".repeat(43))).status, 401);
  assert.equal((await checkin({}, "short")).status, 401);
  const bad = await agent(new Request(SITE + "/api/agent", { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: JSON.stringify({ serial: "not-a-serial" }) }));
  assert.equal(bad.status, 400);
});

test("a brand-new Pi appears as an unassigned device, and its screen says so", async () => {
  const r = await agent(new Request(SITE + "/api/agent", { method: "POST", headers: { Authorization: `Bearer ${"n".repeat(43)}` }, body: JSON.stringify({ serial: "10000000ffff0001" }) }));
  assert.equal((await r.json()).screen, null);
  const shown = await (await screen(req("/api/screen?device=10000000ffff0001"))).json();
  assert.equal(shown.newDevice, true);
  const assigned = await (await screen(req(`/api/screen?device=${PPI2S_SERIAL}`))).json();
  assert.equal(assigned.propertyName, "Perimeter Park One - Two South", "an assigned Pi shows its screen");
});

test("screenshots are stored only if they're a sensible JPEG", async () => {
  await checkin({ screenshot: "data:image/jpeg;base64,/9j/4AAQ" });
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  assert.equal(dev.screenshot, "data:image/jpeg;base64,/9j/4AAQ");
  await checkin({ screenshot: "data:text/html;base64,PHNjcmlwdD4=" });
  assert.equal(dev.screenshot, "data:image/jpeg;base64,/9j/4AAQ", "non-JPEG ignored");
});

test("1Point queues a reboot; the Pi gets it once and reports back", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const q = await devApi(admin, { method: "POST", body: { action: "command", device_id: dev.id, command: "reboot" } });
  assert.equal(q.status, 200);
  const first = await (await checkin({})).json();
  assert.deepEqual(first.commands.map((c) => c.command), ["reboot"]);
  assert.deepEqual((await (await checkin({})).json()).commands, [], "not delivered twice");
  await checkin({ results: [{ id: first.commands[0].id, status: "done", result: "Rebooting." }] });
  const cmd = fake.T.device_commands.find((c) => c.id === first.commands[0].id);
  assert.equal(cmd.status, "done"); assert.equal(cmd.result, "Rebooting.");
});

test("commands older than an hour are dropped, not run late", async () => {
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  fake.T.device_commands.push({ id: 999, device_id: dev.id, command: "reboot", status: "pending", result: "", created_at: new Date(Date.now() - 2 * 3600_000).toISOString() });
  const r = await (await checkin({})).json();
  assert.ok(!r.commands.some((c) => c.id === 999));
  assert.equal(fake.T.device_commands.find((c) => c.id === 999).status, "expired");
});

test("Pi health is 1Point-only: owner users and editors are refused everything", async () => {
  const owner = await login("leighann@barber.test", "owner-pass");
  const editor = await login("editor@barber.test", "editor-pass");
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  for (const t of [owner, editor]) {
    assert.equal((await devApi(t)).status, 403);
    assert.equal((await devApi(t, { qs: "?summary=1" })).status, 403);
    assert.equal((await devApi(t, { qs: `?screenshot=${dev.id}` })).status, 403);
    assert.equal((await devApi(t, { method: "POST", body: { action: "command", device_id: dev.id, command: "reload" } })).status, 403);
    assert.equal((await devApi(t, { method: "POST", body: { action: "identify", screen_id: dev.screen_id } })).status, 403);
  }
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const list = (await (await devApi(admin)).json()).devices;
  assert.ok(list.length >= 16);
  assert.ok(!("key_hash" in list[0]), "keys never leave the server");
});

test("every check-in adds to the Pi's daily summary", async () => {
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const before = fake.T.device_daily.find((r) => r.device_id === dev.id && r.day === centralDay())?.checkins || 0;
  await checkin({ health: { temp_c: 61.5, under_voltage_now: true, browser_running: false } });
  await checkin({ health: { temp_c: 58, under_voltage_now: false, browser_running: true } });
  const row = fake.T.device_daily.find((r) => r.device_id === dev.id && r.day === centralDay());
  assert.equal(row.checkins, before + 2);
  assert.ok(row.power_dips >= 1); assert.ok(row.browser_down >= 1);
  assert.ok(row.max_temp_c >= 61.5, "keeps the day's peak");
  assert.equal(fake.T.device_daily.filter((r) => r.device_id === dev.id && r.day === centralDay()).length, 1, "one row per day");
});

test("uptime math: full days, today so far, and new Pis aren't penalized for days before they existed", () => {
  const now = Date.parse("2026-09-24T17:00:00Z"); // noon Central -> 720 minutes into today
  const d = (day, checkins, extra = {}) => ({ device_id: "A", day, checkins, power_dips: 0, browser_down: 0, max_temp_c: 55, ...extra });
  const daily = [d("2026-09-22", 1440), d("2026-09-23", 720, { power_dips: 3, max_temp_c: 71 }), d("2026-09-24", 720)];
  const devices = [{ id: "A", serial: "10000000aaaaaaaa", screen_id: "S", status: "active", last_seen: new Date(now - 60000).toISOString(), last_health: { temp_c: 50 } },
                   { id: "B", serial: "10000000bbbbbbbb", screen_id: null, status: "active", last_seen: null, last_health: {} }];
  const r = computeSummary({ devices, daily, screens: [{ id: "S", name: "Lobby", key: "lobby", directory_id: "D" }], dirs: [{ id: "D", property_id: "P" }], props: [{ id: "P", name: "Tower", org_id: "O" }], orgs: [{ id: "O", name: "Barber Companies" }], now });
  const a = r.devices.find((x) => x.id === "A");
  assert.equal(a.uptime.d1, 100, "720 of 720 minutes today");
  assert.equal(a.uptime.d7, Math.round((1440 + 720 + 720) / (1440 + 1440 + 720) * 1000) / 10, "only counted from its first day");
  assert.equal(a.dips.d7, 3); assert.equal(a.max_temp_7d, 71);
  assert.deepEqual(a.problems, ["power dips this week"]);
  assert.equal(a.account, "Barber Companies"); assert.equal(a.building, "Tower");
  const b = r.devices.find((x) => x.id === "B");
  assert.equal(b.uptime.d30, null, "no history yet: no uptime rather than 0%");
  // A Pi installed at 11:50 Central today with 10 check-ins since: ~100%, not 10 out of 720 minutes
  const c = computeSummary({ devices: [{ id: "C", serial: "10000000cccccccc", screen_id: null, status: "active", last_seen: new Date(now).toISOString(), last_health: {} }],
    daily: [{ device_id: "C", day: "2026-09-24", checkins: 10, power_dips: 0, browser_down: 0, max_temp_c: 50, first_at: "2026-09-24T16:50:00Z" }], screens: [], dirs: [], props: [], orgs: [], now });
  assert.equal(c.devices[0].uptime.d1, 100, "counted from its first check-in");
  assert.equal(r.fleet.never, 1); assert.equal(r.fleet.online, 1);
});

test("the summary endpoint returns every Pi for 1Point", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const r = await (await devApi(admin, { qs: "?summary=1" })).json();
  assert.ok(r.devices.length >= 16);
  const p = r.devices.find((x) => x.serial === PPI2S_SERIAL);
  assert.equal(p.screen.key, "ppi-2s"); assert.equal(p.account, "Barber Companies");
  assert.ok(p.uptime.d1 > 0);
});

test("identify flashes a screen; 1Point can assign a new Pi and reset keys", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const cad = fake.T.screens.find((x) => x.key === "cadence-place");
  await devApi(admin, { method: "POST", body: { action: "identify", screen_id: cad.id } });
  const shown = await (await screen(req("/api/screen?key=cadence-place"))).json();
  assert.ok(Date.parse(shown.identifyUntil) > Date.now());
  const newbie = fake.T.devices.find((x) => x.serial === "10000000ffff0001");
  const old = fake.T.devices.find((x) => x.screen_id === cad.id);
  assert.equal((await devApi(admin, { method: "POST", body: { action: "assign", device_id: newbie.id, screen_id: cad.id } })).status, 200);
  assert.equal(newbie.screen_id, cad.id);
  assert.equal(old.screen_id, null, "one Pi per screen: the old one is unassigned");
  await devApi(admin, { method: "POST", body: { action: "reset_key", device_id: newbie.id } });
  assert.equal(newbie.key_hash, null, "next check-in enrolls again");
});

test("alerts email once when a Pi goes offline, and once when it's back", async () => {
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const sent = [];
  const send = async (lines) => sent.push(...lines);
  dev.last_seen = new Date(Date.now() - 30 * 60000).toISOString();
  dev.last_health = { temp_c: 50, under_voltage_now: true };
  await runAlerts({ send });
  assert.ok(sent.some((l) => /went offline/.test(l.text) && l.problem));
  assert.ok(sent.some((l) => /under-voltage/.test(l.text)));
  sent.length = 0;
  await runAlerts({ send });
  assert.equal(sent.length, 0, "not repeated every 10 minutes");
  await checkin({ health: { temp_c: 50, under_voltage_now: false } });
  await runAlerts({ send });
  assert.ok(sent.some((l) => /back online/.test(l.text) && !l.problem));
  assert.ok(sent.some((l) => /power is normal/.test(l.text)));
  assert.deepEqual(evaluate({ last_seen: null, last_health: {} }), { offline: false, power: false, hot: false }, "never-seen Pis aren't 'offline'");
});

// ── Config ──
test("config hands the pages only the public settings", async () => {
  const d = await (await config()).json();
  assert.deepEqual(d, { url: SB, anonKey: ANON_KEY });
  assert.ok(!JSON.stringify(d).includes(SERVICE_KEY));
  const saved = process.env.SUPABASE_ANON_KEY; delete process.env.SUPABASE_ANON_KEY;
  assert.equal((await config()).status, 500);
  process.env.SUPABASE_ANON_KEY = saved;
});

// ── Weather and news (unchanged) ──
test("weather maps the NWS hourly forecast", async () => {
  const w = await (await weather(req("/api/weather?lat=33.5186&lon=-86.8104"))).json();
  assert.equal(w.tempF, 78); assert.equal(w.icon, "cloud");
  assert.equal((await weather(req("/api/weather"))).status, 400);
  assert.equal(iconFor("Chance Showers And Thunderstorms"), "storm");
});
test("RSS parsing and the blocklist", () => {
  assert.equal(parseFeed(fx("bbc.xml"))[0].image, "https://ichef.bbci.co.uk/ace/standard/976/cpsprodpb/abc/live/berries.jpg");
  assert.equal(parseFeed(fx("npr.xml"))[0].source, "NPR");
  assert.equal(isBlocked("Warm weather lingers", ["war"]), false);
  assert.equal(isBlocked("Three killed in crash", ["killed"]), true);
});
test("news merges feeds and drops blocked stories", async () => {
  process.env.NEWS_FEEDS = "https://feeds.bbci.co.uk/x.xml,https://feeds.npr.org/1001/rss.xml,https://broken.example/rss";
  const { items, errors } = await (await news(req("/api/news"))).json();
  delete process.env.NEWS_FEEDS;
  assert.ok(!items.some((i) => /killed/i.test(i.title)));
  assert.equal(errors.length, 1);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} passed`);
_reset();
