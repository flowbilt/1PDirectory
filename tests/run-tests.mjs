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

test("a pre-registered Pi is refused until 1Point opens its enrollment window", async () => {
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const r = await checkin({ screenshot: "data:image/jpeg;base64,/9j/4AAQ" });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /enrollment/i);
  assert.equal(dev.key_hash, null, "no key taken");
  assert.equal(dev.last_seen, null, "nothing recorded for a refused Pi");
  assert.equal(dev.screenshot, "", "no screenshot either");
  const owner = await login("leighann@barber.test", "owner-pass");
  assert.equal((await devApi(owner, { method: "POST", body: { action: "open_enrollment", device_id: dev.id } })).status, 403, "owners can't open it");
  dev.enroll_until = new Date(Date.now() - 60000).toISOString();
  assert.equal((await checkin({})).status, 403, "an expired window is closed");
});

test("with the window open, a Yodeck Pi enrolls and finds its own screen by serial", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const o = await devApi(admin, { method: "POST", body: { action: "open_enrollment", device_id: dev.id } });
  assert.equal(o.status, 200);
  const hours = (Date.parse(dev.enroll_until) - Date.now()) / 3600_000;
  assert.ok(hours > 23.9 && hours <= 24, "open for 24 hours");
  const listed = (await (await devApi(admin)).json()).devices.find((x) => x.id === dev.id);
  assert.equal(listed.enrolled, false); assert.equal(listed.enroll_until, dev.enroll_until, "the console sees the window");
  const r = await checkin({ health: { temp_c: 51.2, under_voltage_now: false, ip: "192.168.44.21", bogus: "dropped" } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.screen, "ppi-2s", "matched by the serial from the Yodeck report");
  assert.ok(dev.key_hash && dev.key_hash !== KEY, "key stored hashed");
  assert.equal(dev.last_health.temp_c, 51.2);
  assert.equal(dev.last_health.bogus, undefined, "unknown fields dropped");
  assert.equal(dev.enroll_until, null, "the window closes once it's used");
  assert.equal((await devApi(admin, { method: "POST", body: { action: "open_enrollment", device_id: dev.id } })).status, 409, "an enrolled Pi can't be reopened; that's Reset device key");
  assert.equal((await checkin({}, "y".repeat(43))).status, 401, "a second key is refused");
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

test("a brand-new Pi appears as an unassigned device, keeps no screenshot, and its screen says so", async () => {
  const r = await agent(new Request(SITE + "/api/agent", { method: "POST", headers: { Authorization: `Bearer ${"n".repeat(43)}` }, body: JSON.stringify({ serial: "10000000ffff0001", screenshot: "data:image/jpeg;base64,/9j/4AAQ" }) }));
  assert.equal(r.status, 200, "an unregistered Pi enrolls on first contact");
  assert.equal((await r.json()).screen, null);
  const newbie = fake.T.devices.find((x) => x.serial === "10000000ffff0001");
  assert.ok(newbie.key_hash, "it has its key");
  assert.equal(newbie.screenshot, "", "no screenshot stored until it's assigned");
  assert.equal(newbie.screenshot_at, null);
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
  // These rows have no online_s: history from before round 2, counted a minute per check-in
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
  // Round 2 rows: credited seconds, not check-ins
  const e = computeSummary({ devices: [{ id: "E", serial: "10000000eeeeeeee", screen_id: null, status: "active", last_seen: new Date(now).toISOString(), last_health: {} }],
    daily: [{ device_id: "E", day: "2026-09-23", checkins: 1400, online_s: 1440 * 60, power_dips: 0, browser_down: 0, max_temp_c: 50, first_at: "2026-09-23T05:00:00Z" },
            { device_id: "E", day: "2026-09-24", checkins: 700, online_s: 360 * 60, power_dips: 0, browser_down: 0, max_temp_c: 50 }], screens: [], dirs: [], props: [], orgs: [], now });
  assert.equal(e.devices[0].uptime.d1, 50, "360 of 720 minutes today, whatever the check-in count");
  assert.equal(e.devices[0].uptime.d7, Math.round((1440 + 360) / (1440 + 720) * 1000) / 10);
});

test("the summary endpoint returns every Pi for 1Point", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const r = await (await devApi(admin, { qs: "?summary=1" })).json();
  assert.ok(r.devices.length >= 16);
  const p = r.devices.find((x) => x.serial === PPI2S_SERIAL);
  assert.equal(p.screen.key, "ppi-2s"); assert.equal(p.account, "Barber Companies");
  assert.ok("d1" in p.uptime && "d30" in p.uptime);
  const row = fake.T.device_daily.find((x) => x.device_id === p.id && x.day === centralDay());
  assert.ok(row && "online_s" in row, "the summary reads credited time");
});

// ── Uptime counting (round 2): time since the previous check-in, up to 3 minutes ──
const pi = (serial) => (at, key = "u".repeat(43)) => { fake.setClock(at); return agent(new Request(SITE + "/api/agent", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ serial, health: {} }) })); };
const dailyOf = (serial) => { const d = fake.T.devices.find((x) => x.serial === serial); return fake.T.device_daily.filter((r) => r.device_id === d.id); };

test("each check-in credits the time since the previous one, up to 3 minutes", async () => {
  const at = pi("10000000c0ffee01"), t0 = Date.parse("2026-09-24T15:00:00Z");
  try {
    await at(t0);                                   // first contact: counted, nothing credited
    await at(t0 + 50_000);                          // 50 s later
    await at(t0 + 50_000 + 180_000);                // exactly 3 minutes: still up
    await at(t0 + 50_000 + 180_000 + 181_000);      // 3 min 1 s: an outage, nothing credited
    await at(t0 + 50_000 + 180_000 + 181_000 + 61_000);
  } finally { fake.setClock(null); }
  const [row] = dailyOf("10000000c0ffee01");
  assert.equal(row.checkins, 5);
  assert.equal(row.online_s, 50 + 180 + 0 + 61);
  assert.deepEqual(fake.deviceCredit(null, "2026-09-24T15:00:00Z"), [0, 0]);
  assert.deepEqual(fake.deviceCredit("2026-09-24T15:00:10Z", "2026-09-24T15:00:00Z"), [0, 0], "a clock that went backwards credits nothing");
});

test("a gap across midnight (Central) is split between the two days", async () => {
  const at = pi("10000000c0ffee02");
  try {
    await at("2026-09-25T04:58:30Z");               // 23:58:30 Central
    await at("2026-09-25T04:59:20Z");               // 23:59:20: 50 s to the 24th
    await at("2026-09-25T05:00:30Z");               // 00:00:30: 40 s to the 24th, 30 s to the 25th
  } finally { fake.setClock(null); }
  const rows = dailyOf("10000000c0ffee02");
  assert.equal(rows.find((r) => r.day === "2026-09-24").online_s, 90);
  assert.equal(rows.find((r) => r.day === "2026-09-25").online_s, 30);
  assert.deepEqual(fake.deviceCredit("2026-11-01T04:59:00Z", "2026-11-01T05:01:00Z"), [60, 60], "the night the clocks change");
});

test("a healthy Pi checking in every 61 seconds reads 100%; an outage costs its length plus at most a minute", async () => {
  const serial = "10000000c0ffee03", at = pi(serial), start = Date.parse("2026-09-23T05:00:00Z"); // midnight Central
  const sixAm = start + 6 * 3600_000;
  try {
    for (let t = start, i = 0; t <= sixAm; t += 61_000 + ((i++ % 5) - 2) * 700) await at(t);  // 59.6 to 62.4 s apart
  } finally { fake.setClock(null); }
  const summary = (daily, nowMs) => computeSummary({ devices: [{ ...fake.T.devices.find((x) => x.id === daily[0].device_id), last_seen: new Date(nowMs).toISOString() }], daily, screens: [], dirs: [], props: [], orgs: [], now: nowMs }).devices[0];
  const day = dailyOf(serial);
  assert.ok(day[0].checkins < 360, `drifting Pi made ${day[0].checkins} check-ins in 360 minutes`);
  assert.ok(day[0].checkins / 360 < 0.99, "the old count would have shown it under 99%");
  assert.ok(summary(day, sixAm).uptime.d1 >= 99.9, `uptime ${summary(day, sixAm).uptime.d1}%`);
  // The same six hours with a 10-minute gap from 02:00
  const serial2 = "10000000c0ffee04", at2 = pi(serial2);
  try {
    for (let t = start; t <= sixAm; t += 60_000) if (t < start + 2 * 3600_000 || t >= start + 2 * 3600_000 + 10 * 60_000) await at2(t);
  } finally { fake.setClock(null); }
  // Last check-in 01:59, next 02:10: the whole 11-minute gap is uncredited, so a 10-minute outage costs 11 minutes.
  // Outages are reported slightly long rather than hidden.
  const up = summary(dailyOf(serial2), sixAm).uptime.d1;
  assert.equal(up, Math.round((349 / 360) * 1000) / 10, `uptime ${up}%`);
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
  const newKey = (s) => agent(new Request(SITE + "/api/agent", { method: "POST", headers: { Authorization: `Bearer ${s.repeat(43)}` }, body: JSON.stringify({ serial: "10000000ffff0001", screenshot: "data:image/jpeg;base64,/9j/4AAQ" }) }));
  assert.equal((await newKey("n")).status, 200);
  assert.equal(newbie.screenshot, "data:image/jpeg;base64,/9j/4AAQ", "screenshots are kept once it's assigned");
  await devApi(admin, { method: "POST", body: { action: "reset_key", device_id: newbie.id } });
  assert.equal(newbie.key_hash, null, "key cleared");
  assert.ok(Date.parse(newbie.enroll_until) > Date.now() + 23.9 * 3600_000, "reset opens a 24-hour window");
  await devApi(admin, { method: "POST", body: { action: "close_enrollment", device_id: newbie.id } });
  assert.equal((await newKey("m")).status, 403, "closed again: refused");
  await devApi(admin, { method: "POST", body: { action: "open_enrollment", device_id: newbie.id } });
  assert.equal((await newKey("m")).status, 200, "the reflashed Pi enrolls with its new key");
  assert.equal((await newKey("n")).status, 401, "and the old key no longer works");
  await devApi(admin, { method: "POST", body: { action: "assign", device_id: newbie.id, screen_id: null } });
  assert.equal(newbie.screenshot, "", "unassigning clears its screenshot");
  assert.equal(newbie.screenshot_at, null);
});

// ── Screen hardware (serials, MACs, IPs) is server-only ──
test("nobody reads screens.hardware from the database; 1Point gets it through the server", async () => {
  const owner = await login("leighann@barber.test", "owner-pass");
  const editor = await login("editor@barber.test", "editor-pass");
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const rest = (token, q) => fake.handle(new Request(`${SB}/rest/v1/screens?${q}`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } }));
  const cols = readFileSync(new URL("../public/console.js", import.meta.url), "utf8").match(/SCREEN_COLS = "([^"]+)"/)[1];
  for (const t of [owner, editor, admin]) {
    assert.equal((await rest(t, "select=*")).status, 403, "select=* is refused");
    assert.equal((await rest(t, "select=id,hardware")).status, 403, "hardware is refused");
    const r = await rest(t, `select=${cols}`);
    assert.equal(r.status, 200, "the console's column list works");
    const rows = await r.json();
    assert.ok(rows.length && rows.every((x) => !("hardware" in x)));
  }
  const ppi2s = fake.T.screens.find((x) => x.key === "ppi-2s");
  for (const t of [owner, editor]) assert.equal((await devApi(t, { qs: `?hardware=${ppi2s.id}` })).status, 403);
  const hw = await (await devApi(admin, { qs: `?hardware=${ppi2s.id}` })).json();
  assert.equal(hw.hardware.serial, PPI2S_SERIAL);
  assert.equal(hw.hardware.yodeck_id, "194292");
  assert.equal(ppi2s.name, "TBC - PPI - 2 S - 194292", "the name matches its Yodeck ID");
  const edit = readFileSync(new URL("../public/edit.js", import.meta.url), "utf8").match(/screens\?directory_id=eq\.\$\{dir\.id\}&select=([\w,]+)/)[1];
  assert.ok(edit.split(",").every((c) => cols.split(",").includes(c)), "the editor asks only for readable columns");
  const granted = readFileSync(new URL("../supabase/06-trust.sql", import.meta.url), "utf8").match(/grant select \(([^)]+)\)/)[1].split(",").map((c) => c.trim());
  assert.deepEqual([...granted].sort(), cols.split(",").sort(), "06-trust.sql grants exactly the console's columns");
});

test("alerts email once when a Pi goes offline, and once when it's back", async () => {
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const sent = [];
  const send = async (lines) => { sent.push(...lines); return true; };
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

test("a failed alert email is retried on the next run, and state is saved only once it goes out", async () => {
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const before = JSON.stringify(dev.alert_state);
  dev.last_health = { temp_c: 85 };
  const tries = [];
  let r = await runAlerts({ send: async (lines) => { tries.push(lines); return false; } });
  assert.equal(r.sent, false); assert.equal(JSON.stringify(dev.alert_state), before, "not saved after a failed send");
  const log = console.log; console.log = () => {};
  try { r = await runAlerts({ send: async () => { throw new Error("Resend is down"); } }); } finally { console.log = log; }
  assert.equal(r.sent, false); assert.equal(JSON.stringify(dev.alert_state), before, "not saved after an error either");
  const sent = [];
  r = await runAlerts({ send: async (lines) => { sent.push(...lines); return true; } });
  assert.ok(sent.some((l) => /running hot at 85/.test(l.text)), "retried and delivered");
  assert.equal(dev.alert_state.hot, true, "saved once delivered");
  sent.length = 0;
  await runAlerts({ send: async (lines) => { sent.push(...lines); return true; } });
  assert.equal(sent.length, 0, "and not sent again");
  dev.last_health = { temp_c: 50 };
  await runAlerts({ send: async () => true });
});

test("problems that already exist are emailed once when the email settings are first added", async () => {
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  dev.last_health = { temp_c: 50, under_voltage_now: true };
  const saved = { ...process.env };
  for (const k of ["RESEND_API_KEY", "ALERT_EMAIL_TO", "ALERT_EMAIL_FROM"]) delete process.env[k];
  const log = console.log; console.log = () => {};
  try {
    const r1 = await runAlerts(), r2 = await runAlerts();         // the real sender, with no settings: logs only
    assert.equal(r1.sent, false); assert.equal(r2.sent, false);
    assert.ok(r2.lines.some((l) => /under-voltage/.test(l.text)), "still pending, not forgotten");
    assert.ok(!dev.alert_state.power, "nothing saved while email isn't set up");
  } finally { console.log = log; Object.assign(process.env, saved); }
  // The settings are added: the real sender posts to Resend
  Object.assign(process.env, { RESEND_API_KEY: "re_test", ALERT_EMAIL_TO: "ops@1pointusa.com", ALERT_EMAIL_FROM: "Directory <alerts@1pointusa.com>" });
  const realFetch = globalThis.fetch, posted = [];
  globalThis.fetch = async (url, init) => (String(url).startsWith("https://api.resend.com") ? (posted.push(JSON.parse(init.body)), new Response("{}", { status: 200 })) : realFetch(url, init));
  try {
    await runAlerts(); await runAlerts();
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ["RESEND_API_KEY", "ALERT_EMAIL_TO", "ALERT_EMAIL_FROM"]) delete process.env[k];
  }
  assert.equal(posted.length, 1, "one email, not one per run");
  assert.match(posted[0].html, /under-voltage/);
  assert.deepEqual(posted[0].to, ["ops@1pointusa.com"]);
  assert.equal(dev.alert_state.power, true);
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
