// Run with: npm test
// Every server function, against a fake Supabase with the same access rules as the real one. No network needed.
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, readdirSync } from "node:fs";
import { createFake, SERVICE_KEY, ANON_KEY, SIZE_RANGES } from "./fake-supabase.mjs";
import screen, { toPayload } from "../netlify/functions/screen.mjs";
import traffic, { toTimes } from "../netlify/functions/traffic.mjs";
import togo from "../netlify/functions/togo.mjs";
import { cleanPlaceLists, cleanPeople } from "../netlify/functions/screen.mjs";
import users from "../netlify/functions/users.mjs";
import config from "../netlify/functions/config.mjs";
import weather, { iconFor } from "../netlify/functions/weather.mjs";
import news from "../netlify/functions/news.mjs";
import agent from "../netlify/functions/agent.mjs";
import devices from "../netlify/functions/devices.mjs";
import networks, { normalCode } from "../netlify/functions/networks.mjs";
import alertSettings from "../netlify/functions/alert-settings.mjs";
import { sendMail } from "../netlify/lib/smtp.mjs";
import { fakeSmtp, CERT } from "./fake-smtp.mjs";
import alertsJob, { runAlerts, evaluate, sendEmail } from "../netlify/functions/alerts.mjs";
import { computeSummary, windowsFromDaily } from "../netlify/functions/devices.mjs";
import { centralDay } from "../netlify/functions/agent.mjs";
import { parseFeed, isBlocked } from "../netlify/lib/rss.mjs";
import { seal, open as unseal } from "../netlify/lib/secret.mjs";
import { DISPLAY_VERSION } from "../netlify/lib/version.mjs";

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
  if (u.includes("desc-test")) return ok(`<rss><channel><title>Bham Now</title>
    <item><title>Police update on downtown incident</title><description>&lt;p&gt;Two people were &lt;b&gt;killed&lt;/b&gt; overnight.&lt;/p&gt;</description><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item>
    <item><title>Neighborhood flooding closes roads</title><description>Crews are out.</description><pubDate>Mon, 05 Oct 2026 11:00:00 GMT</pubDate></item>
    <item><title>Convicted murderers appeal sentence</title><description>The court hears it today.</description><pubDate>Mon, 05 Oct 2026 12:00:00 GMT</pubDate></item>
    <item><title>New deadline set for the city's diet program</title><description>Downtown San Diego style.</description><pubDate>Mon, 05 Oct 2026 13:00:00 GMT</pubDate></item>
  </channel></rss>`);
  throw new Error("unexpected fetch " + u);
};

const req = (path, { method = "GET", body, token, headers = {} } = {}) =>
  new Request(SITE + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
async function login(email, password) {
  const r = await fake.handle(new Request(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON_KEY }, body: JSON.stringify({ email, password }) }));
  return (await r.json()).access_token;
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  assert.deepEqual(d.tenants[1], { name: "Common Bond Title, LLC", suite: "130 S", dir: "left", note: "A subsidiary of Affiliates Consolidated Services", people: [] });
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
  assert.deepEqual(p.tenants[0], { name: "X", suite: "1", dir: "up", note: "", people: [] });
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
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const q = await devApi(admin, { method: "POST", body: { action: "command", device_id: dev.id, command: "reboot" } });
  assert.equal(q.status, 409, "no commands for a Pi that hasn't enrolled");
  assert.ok(!fake.T.device_commands.some((c) => c.device_id === dev.id), "nothing queued");
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

test("a refused Pi says why in the console, until its next good check-in", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  assert.equal((await checkin({}, "z".repeat(43))).status, 401, "a new card's key");
  let listed = (await (await devApi(admin)).json()).devices.find((x) => x.id === dev.id);
  assert.equal(listed.refused_why, "key"); assert.ok(listed.refused_at);
  assert.equal((await checkin({})).status, 200, "the right key again");
  listed = (await (await devApi(admin)).json()).devices.find((x) => x.id === dev.id);
  assert.equal(listed.refused_why, null, "cleared"); assert.equal(listed.refused_at, null);
  const sql = readFileSync(new URL("../supabase/10-refused.sql", import.meta.url), "utf8");
  for (const why of ["key", "enroll", "revoked"]) assert.ok(sql.includes(`refused_why = '${why}'`), `10 records ${why}`);
  assert.ok(sql.includes("refused_at    = null"), "10 clears it on a good check-in");
});

test("the TV's state is reported, only as a known value, and a TV that's off shows in Health", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  await checkin({ health: { tv: "<script>" } });
  assert.equal(dev.last_health.tv, null, "unknown values are dropped");
  await checkin({ health: { tv: "standby" } });
  assert.equal(dev.last_health.tv, "standby");
  const p = (await (await devApi(admin, { qs: "?summary=1" })).json()).devices.find((x) => x.serial === PPI2S_SERIAL);
  assert.ok(p.problems.includes("TV off"), p.problems.join(", ")); assert.equal(p.tv, "standby");
  await checkin({ health: { tv: "on" } });
  const q = (await (await devApi(admin, { qs: "?summary=1" })).json()).devices.find((x) => x.serial === PPI2S_SERIAL);
  assert.ok(!q.problems.some((x) => x.startsWith("TV")));
  const sql = readFileSync(new URL("../supabase/11-layouts.sql", import.meta.url), "utf8");
  for (const o of ["auto", "portrait", "landscape", "portrait-flipped", "landscape-flipped"]) assert.ok(sql.includes(`'${o}'`), `11 allows ${o}`);
});

test("Update Pi can be sent to an enrolled Pi, and reaches it", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const q = await devApi(admin, { method: "POST", body: { action: "command", device_id: dev.id, command: "update_pi" } });
  assert.equal(q.status, 200);
  const got = await (await checkin({})).json();
  assert.ok(got.commands.some((c) => c.command === "update_pi"), "the Pi receives it");
  const sql = readFileSync(new URL("../supabase/09-update.sql", import.meta.url), "utf8");
  for (const c of ["reboot", "reload", "screenshot", "update_agent", "update_pi"]) assert.ok(sql.includes(`'${c}'`), `09 allows ${c}`);
});

test("Wi-Fi search and join: 1Point only, new agents only, and the password reaches the Pi once and is never kept or listed", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const owner = await login("leighann@barber.test", "owner-pass");
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const send = (token, body) => devApi(token, { method: "POST", body: { action: "command", device_id: dev.id, ...body } });
  await checkin({ version: "1.5.0" });
  const old = await send(admin, { command: "wifi_scan" });
  assert.equal(old.status, 409, "an agent before 1.6.0 doesn't know the Wi-Fi commands");
  assert.match((await old.json()).error, /Update agent/);
  await checkin({ version: "1.6.0" });
  assert.equal((await send(owner, { command: "wifi_scan" })).status, 403, "owners can't");
  for (const [bad, why] of [[{ ssid: "" }, "no network"], [{ ssid: "x".repeat(33) }, "too long"], [{ ssid: "Net", psk: "short" }, "password too short"],
    [{ ssid: "Net\n", psk: "" }, "control character"], [{ ssid: "Net", psk: "p".repeat(64) }, "password too long"]])
    assert.equal((await send(admin, { command: "wifi_join", ...bad })).status, 400, why);
  assert.equal((await send(admin, { command: "wifi_join", ssid: "Café Wi-Fi", psk: "" })).status, 200, "an open network, and a name that isn't plain ASCII");
  await checkin({ version: "1.6.0" });   // hand that one over, so the next is the only one waiting

  const q = await send(admin, { command: "wifi_join", ssid: "PPI Lobby", psk: "correct horse", hidden: true });
  assert.equal(q.status, 200);
  const { id } = await q.json();
  assert.ok(id, "the page gets the command's id, to follow it");
  assert.equal(fake.T.device_commands.find((c) => c.id === id).payload.psk, "correct horse", "held only until the Pi's next check-in");
  const listed = JSON.stringify(await (await devApi(admin)).json());
  assert.ok(!listed.includes("correct horse") && !listed.includes("payload"), "never listed back, not even to 1Point");
  assert.ok(!JSON.stringify(fake.T.audit_log).includes("correct horse"), "the audit log names the network only");
  assert.ok(fake.T.audit_log.some((a) => a.action === "device wifi_join" && a.detail.ssid === "PPI Lobby"));

  const got = await (await checkin({ version: "1.6.0" })).json();
  assert.deepEqual(got.commands.find((c) => c.id === id), { id, command: "wifi_join", payload: { ssid: "PPI Lobby", psk: "correct horse", hidden: true } });
  assert.equal(fake.T.device_commands.find((c) => c.id === id).payload, null, "cleared as it's handed over");
  assert.deepEqual((await (await checkin({ version: "1.6.0" })).json()).commands, [], "delivered once");
  await checkin({ version: "1.6.0", results: [{ id, status: "failed", result: "Couldn't join PPI Lobby: wrong password. Still on Wired connection 1." }] });
  assert.equal(fake.T.device_commands.find((c) => c.id === id).status, "failed");

  const s = await (await send(admin, { command: "wifi_scan" })).json();
  const r = await (await checkin({ version: "1.6.0" })).json();
  assert.ok(r.commands.some((c) => c.id === s.id && c.command === "wifi_scan" && !("payload" in c)), "a scan carries no payload");
  const list = JSON.stringify({ networks: Array.from({ length: 40 }, (_, i) => ({ ssid: `Network number ${i}`, open: false, signal: 90 - i, current: false })), wired: true });
  assert.ok(list.length > 2000 && list.length < 4000);
  await checkin({ version: "1.6.0", results: [{ id: s.id, status: "done", result: list }] });
  assert.equal(fake.T.device_commands.find((c) => c.id === s.id).result, list, "a scan's list is kept whole, past the usual 500 characters");

  fake.T.device_commands.push({ id: 5998, device_id: dev.id, command: "wifi_join", payload: { ssid: "Old", psk: "old-password" }, status: "pending", result: "", created_at: new Date(Date.now() - 2 * 3600_000).toISOString() });
  const late = await (await checkin({ version: "1.6.0" })).json();
  assert.ok(!late.commands.some((c) => c.id === 5998), "an hour-old join is never run");
  assert.deepEqual([fake.T.device_commands.find((c) => c.id === 5998).status, fake.T.device_commands.find((c) => c.id === 5998).payload], ["expired", null]);

  const sql = readFileSync(new URL("../supabase/13-tech.sql", import.meta.url), "utf8");
  for (const c of ["reboot", "reload", "screenshot", "update_agent", "update_pi", "wifi_scan", "wifi_join"]) assert.ok(sql.includes(`'${c}'`), `13 allows ${c}`);
  assert.ok(sql.includes("set status = 'sent', sent_at = v_now, payload = null"), "13 clears the payload as it hands it over");
  assert.ok(sql.includes("set status = 'expired', payload = null"), "13 clears it when a command expires");
});

test("layout: 1Point sets a screen's layout and restarts its Pi in one step; owners can't", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const owner = await login("leighann@barber.test", "owner-pass");
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const sc = fake.T.screens.find((x) => x.key === "ppi-2s");
  const layout = (token, body) => devApi(token, { method: "POST", body: { action: "layout", screen_id: sc.id, ...body } });
  assert.equal((await layout(owner, { orientation: "portrait" })).status, 403);
  assert.equal((await layout(admin, { orientation: "sideways" })).status, 400);
  const before = fake.T.device_commands.filter((c) => c.device_id === dev.id && c.command === "reboot" && c.status === "pending").length;
  const r = await (await layout(admin, { orientation: "landscape-flipped", restart: true })).json();
  assert.deepEqual(r, { ok: true, restarted: true });
  assert.equal(sc.orientation, "landscape-flipped");
  assert.equal(fake.T.device_commands.filter((c) => c.device_id === dev.id && c.command === "reboot" && c.status === "pending").length, before + 1, "its Pi is told to restart");
  const cad = fake.T.screens.find((x) => x.key === "cadence-place");
  const n = await (await devApi(admin, { method: "POST", body: { action: "layout", screen_id: cad.id, orientation: "portrait-flipped", restart: true } })).json();
  assert.deepEqual(n, { ok: true, restarted: false }, "a Pi that hasn't enrolled can't be restarted; the layout is still saved");
  assert.equal(cad.orientation, "portrait-flipped");
  // put both back, and let the Pi collect its reboot, so later tests start clean
  Object.assign(sc, { orientation: "landscape" }); Object.assign(cad, { orientation: "portrait" });
  await checkin({ version: "1.6.0" });
});

test("Wi-Fi saved from the technician page: only after a Pi joined it, one tap for other Pis, never on cards", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const owner = await login("leighann@barber.test", "owner-pass");
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const post = (token, body) => devApi(token, { method: "POST", body: { device_id: dev.id, ...body } });
  const net = { ssid: "Barber Lobby", psk: "lobby-pass-1", hidden: false };
  const joinAndReport = async (body, result) => {
    const { id } = await (await post(admin, { action: "command", command: "wifi_join", ...body })).json();
    const got = (await (await checkin({ version: "1.6.0" })).json()).commands.find((c) => c.id === id);
    await checkin({ version: "1.6.0", results: [{ id, status: result.startsWith("Joined") ? "done" : "failed", result }] });
    return got;
  };
  assert.equal((await post(admin, { action: "save_network", ...net })).status, 409, "nothing is saved before the Pi has joined it");
  await joinAndReport(net, "Couldn't join Barber Lobby: the password was refused. Still on OfficeNet.");
  assert.equal((await post(admin, { action: "save_network", ...net })).status, 409, "a failed join isn't enough");
  await joinAndReport(net, "Joined Barber Lobby; the directory site is reachable through it.");
  assert.equal((await post(owner, { action: "save_network", ...net })).status, 403, "owners can't");
  const saved = await post(admin, { action: "save_network", ...net });
  assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { ok: true, updated: false });
  const row = fake.T.wifi_networks.find((n) => n.ssid === "Barber Lobby");
  assert.deepEqual([row.label, row.psk, row.on_cards], ["Perimeter Park One", "lobby-pass-1", false], "labelled with the building, kept off cards");
  assert.ok(!JSON.stringify(fake.T.audit_log).includes("lobby-pass-1"), "the audit log names the network only");

  const listed = await (await networks(req("/api/networks", { token: admin }))).json();
  const l = listed.networks.find((n) => n.ssid === "Barber Lobby");
  assert.equal(l.on_cards, false); assert.equal(l.psk, undefined, "the list never carries passwords");

  const one = await joinAndReport({ ssid: "Barber Lobby", saved: true }, "Joined Barber Lobby; the directory site is reachable through it.");
  assert.deepEqual(one.payload, { ssid: "Barber Lobby", psk: "lobby-pass-1", hidden: false }, "a saved network joins with its stored password, which the phone never sent");
  assert.equal((await post(admin, { action: "command", command: "wifi_join", ssid: "Never Saved", saved: true })).status, 404);

  const prep = async () => {
    const { code } = await (await networks(req("/api/networks", { method: "POST", token: admin, body: { action: "code" } }))).json();
    return (await (await networks(req("/api/networks", { method: "POST", body: { action: "prepare", code } }))).json()).networks.map((n) => n.ssid);
  };
  assert.ok(!(await prep()).includes("Barber Lobby"), "a network saved from the field never goes on a card");
  await networks(req("/api/networks", { method: "POST", token: admin, body: { action: "save", id: row.id, label: row.label, ssid: row.ssid, hidden: false, on_cards: true } }));
  assert.ok((await prep()).includes("Barber Lobby"), "until the office puts it on cards in Pi setup");
  assert.equal(row.psk, "lobby-pass-1", "and moving it keeps its password");

  await joinAndReport({ ssid: "Barber Lobby", psk: "new-pass-2026" }, "Joined Barber Lobby; the directory site is reachable through it.");
  const upd = await (await post(admin, { action: "save_network", ssid: "Barber Lobby", psk: "new-pass-2026" })).json();
  assert.deepEqual(upd, { ok: true, updated: true });
  assert.equal(fake.T.wifi_networks.filter((n) => n.ssid === "Barber Lobby").length, 1, "one entry per network");
  assert.deepEqual([row.psk, row.on_cards], ["new-pass-2026", true], "a changed password is updated where it's saved, which stays as the office set it");
  const sql = readFileSync(new URL("../supabase/14-saved-wifi.sql", import.meta.url), "utf8");
  assert.ok(sql.includes("on_cards boolean not null default true"), "14: networks already saved stay on cards");
  fake.T.wifi_networks.splice(fake.T.wifi_networks.indexOf(row), 1);   // later tests count the saved networks
});

test("Save for other screens is done by the server when the Pi reports the join worked, so the phone can be closed", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const post = (body) => devApi(admin, { method: "POST", body: { device_id: dev.id, ...body } });
  const queue = async (body) => (await (await post({ action: "command", command: "wifi_join", ...body })).json()).id;
  const hand = async (id) => (await (await checkin({ version: "1.8.1" })).json()).commands.find((c) => c.id === id);
  const report = (id, status, result) => checkin({ version: "1.8.1", results: [{ id, status, result }] });
  const cmd = (id) => fake.T.device_commands.find((c) => c.id === id);
  const consoleSees = async () => JSON.stringify(await (await devApi(admin)).json());
  const nets = fake.T.wifi_networks.length;

  // A wrong password, Save ticked: the Pi gets the network, never the save copy; nothing is saved; the result says so
  const bad = await queue({ ssid: "Lobby Six", psk: "wrong-pass-6", save: true });
  assert.deepEqual(cmd(bad).save, { ssid: "Lobby Six", psk: "wrong-pass-6", hidden: false }, "the save copy waits on the server");
  const got = await hand(bad);
  assert.ok(got.payload && !("save" in got), "the Pi receives the network to join, not the save copy");
  assert.equal(cmd(bad).payload, null, "the join's payload is still cleared at the handover");
  assert.ok(cmd(bad).save, "the save copy stays until the Pi's result");
  assert.ok(!(await consoleSees()).includes("wrong-pass-6"), "the console never sees the password while it waits");
  await report(bad, "failed", "Couldn't join Lobby Six: the password was refused. Still on OfficeNet.");
  assert.equal(cmd(bad).result, "Couldn't join Lobby Six: the password was refused. Still on OfficeNet. Nothing was saved.");
  assert.equal(cmd(bad).save, null);
  assert.equal(fake.T.wifi_networks.length, nets, "a failed join saves nothing");

  // The right password, Save ticked, and nobody calls save_network afterwards (the phone was locked): saved anyway
  const good = await queue({ ssid: "Lobby Six", psk: "right-pass-6", save: true });
  await hand(good);
  const rest = fake.restCalls.length, calls = fake.rpcCalls.length;
  await report(good, "done", "Joined Lobby Six; the directory site is reachable through it.");
  assert.deepEqual(fake.rpcCalls.slice(calls), ["agent_checkin"], "the save rides on the Pi's check-in");
  assert.equal(fake.restCalls.length - rest, 0, "still one trip to the database per check-in");
  const row = fake.T.wifi_networks.find((n) => n.ssid === "Lobby Six");
  assert.deepEqual([row.label, row.psk, row.on_cards], ["Perimeter Park One", "right-pass-6", false], "labelled with the building, kept off cards");
  assert.equal(cmd(good).result, "Joined Lobby Six; the directory site is reachable through it. Saved for other screens: other Pis can join Lobby Six with one tap.");
  assert.equal(cmd(good).save, null, "the save copy is gone once it's saved");
  const recent = await consoleSees();
  assert.ok(recent.includes("Saved for other screens: other Pis can join Lobby Six"), "Recent actions shows it was saved");
  assert.ok(!recent.includes("right-pass-6"), "and never the password");
  assert.ok(!JSON.stringify(fake.T.audit_log).includes("right-pass-6"), "the audit log names the network only");
  assert.ok(fake.T.audit_log.some((a) => a.action === "save wifi from field" && a.detail.ssid === "Lobby Six" && a.detail.serial === PPI2S_SERIAL));

  // Joined again with a new password after the office put it on cards: the one entry is updated and stays on cards
  row.on_cards = true;
  const again = await queue({ ssid: "Lobby Six", psk: "newer-pass-6", save: true });
  await hand(again);
  await report(again, "done", "Joined Lobby Six; the directory site is reachable through it.");
  assert.equal(fake.T.wifi_networks.filter((n) => n.ssid === "Lobby Six").length, 1, "one entry per network");
  assert.deepEqual([row.psk, row.on_cards], ["newer-pass-6", true]);
  assert.match(cmd(again).result, / The saved password is updated: other Pis can join Lobby Six with one tap\.$/);

  // A join with a saved network, or without Save ticked, carries no save copy and saves nothing
  const one = await queue({ ssid: "Lobby Six", saved: true, save: true });
  assert.equal(cmd(one).save, null, "a saved network is already saved");
  const plain = await queue({ ssid: "Lobby Plain", psk: "plain-pass-6" });
  assert.equal(cmd(plain).save, null);
  await hand(plain);
  await report(one, "done", "Joined Lobby Six; the directory site is reachable through it.");
  await report(plain, "done", "Joined Lobby Plain; the directory site is reachable through it.");
  assert.equal(cmd(plain).result, "Joined Lobby Plain; the directory site is reachable through it.", "no note without Save");
  assert.ok(!fake.T.wifi_networks.some((n) => n.ssid === "Lobby Plain"));

  // A join the Pi never picks up expires after an hour, and its save copy with it
  const lost = await queue({ ssid: "Lobby Lost", psk: "lost-pass-66", save: true });
  cmd(lost).created_at = new Date(Date.now() - 2 * 3600_000).toISOString();
  await checkin({ version: "1.8.1" });
  assert.deepEqual([cmd(lost).status, cmd(lost).save, cmd(lost).payload], ["expired", null, null]);
  assert.ok(!fake.T.wifi_networks.some((n) => n.ssid === "Lobby Lost"));

  // 20-save-wifi.sql says the same things the fake does
  const sql = readFileSync(new URL("../supabase/20-save-wifi.sql", import.meta.url), "utf8");
  for (const s of ["Saved for other screens: other Pis can join %s with one tap.", "The saved password is updated: other Pis can join %s with one tap.",
                   "' Nothing was saved.'", "save    = null", "payload = null, save = null", "'save wifi from field'", "'update wifi from field'"])
    assert.ok(sql.includes(s), `20: ${s}`);
  fake.T.wifi_networks.splice(fake.T.wifi_networks.indexOf(row), 1);   // later tests count the saved networks
});

test("the technician page sends Save with the join and no longer saves from the phone", async () => {
  const js = readFileSync(new URL("../public/tech.js", import.meta.url), "utf8");
  assert.ok(/command: "wifi_join", ssid, psk, hidden, \.\.\.\(keep \? \{ save: true \} : \{\}\)/.test(js), "Save ticked goes with the join");
  assert.ok(!js.includes('action: "save_network"'), "the page never saves after the result itself");
  assert.ok(!js.includes("Keep this page open"), "nor asks to be kept open");
});

test("remove: a Pi under New devices can be removed by 1Point; an assigned one can't, and a running one comes back", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const owner = await login("leighann@barber.test", "owner-pass");
  const serial = "100000005e3713aa", key = "stray-key-".padEnd(43, "x");
  await agent(req("/api/agent", { method: "POST", token: key, body: { serial, version: "1.6.0", health: {} } }));
  const stray = fake.T.devices.find((x) => x.serial === serial);
  assert.ok(stray && !stray.screen_id, "a Pi nobody registered waits under New devices");
  const rm = (token, id) => devApi(token, { method: "POST", body: { action: "remove", device_id: id } });
  assert.equal((await rm(owner, stray.id)).status, 403);
  const assigned = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  assert.equal((await rm(admin, assigned.id)).status, 409, "a Pi on a screen must be unassigned first");
  assert.equal((await rm(admin, stray.id)).status, 200);
  assert.ok(!fake.T.devices.some((x) => x.serial === serial), "gone from the list");
  assert.ok(fake.T.audit_log.some((a) => a.action === "remove device" && a.detail.serial === serial));
  await agent(req("/api/agent", { method: "POST", token: key, body: { serial, version: "1.6.0", health: {} } }));
  const back = fake.T.devices.find((x) => x.serial === serial);
  assert.ok(back && !back.screen_id, "still running: it enrolls again on its next check-in");
  fake.T.devices.splice(fake.T.devices.indexOf(back), 1);
});

test("a second logo: the owner's or manager's, at the bottom, or swapped to the top", async () => {
  const lm = fake.T.properties.find((x) => x.name === "The Landmark Center");
  const shape = async () => (await (await screen(req("/api/screen?screen=landmark-center&view=1"))).json());
  let d = await shape();
  assert.deepEqual([d.companyLogo, d.logoSwap], ["", false], "none until one is uploaded");
  Object.assign(lm, { logo: "data:image/png;base64,QkxE", company_logo: "data:image/png;base64,QkFS", logo_swap: true, updated_at: new Date().toISOString() });
  d = await shape();
  assert.deepEqual([d.logo, d.companyLogo, d.logoSwap], ["data:image/png;base64,QkxE", "data:image/png;base64,QkFS", true]);
  const sql = readFileSync(new URL("../supabase/15-logos.sql", import.meta.url), "utf8");
  assert.ok(sql.includes("company_logo text not null default ''") && sql.includes("logo_swap boolean not null default false"));
  Object.assign(lm, { logo: "", company_logo: "", logo_swap: false, updated_at: new Date().toISOString() });
});

test("remote support: 1Point only, agent 1.8.0 or newer, and in 16-remote.sql", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const owner = await login("leighann@barber.test", "owner-pass");
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const send = (token, command) => devApi(token, { method: "POST", body: { action: "command", device_id: dev.id, command } });
  await checkin({ version: "1.7.0" });
  const old = await send(admin, "remote_on");
  assert.equal(old.status, 409, "an agent before 1.8.0 doesn't know it");
  assert.match((await old.json()).error, /Update agent/);
  await checkin({ version: "1.8.0" });
  assert.equal((await send(owner, "remote_on")).status, 403, "owners can't");
  for (const c of ["remote_on", "remote_off"]) assert.equal((await send(admin, c)).status, 200, c);
  const got = (await (await checkin({ version: "1.8.0" })).json()).commands.map((c) => c.command);
  assert.deepEqual(got.filter((c) => c.startsWith("remote_")), ["remote_on", "remote_off"]);
  const sql = readFileSync(new URL("../supabase/16-remote.sql", import.meta.url), "utf8");
  for (const c of ["reboot", "update_pi", "wifi_scan", "wifi_join", "remote_on", "remote_off"]) assert.ok(sql.includes(`'${c}'`), `16 allows ${c}`);
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
  const readable = [...cols.split(","), "sizes"];                           // sizes: granted in 18-sizes.sql, read by the editor
  assert.ok(edit.split(",").every((c) => readable.includes(c)), "the editor asks only for readable columns");
  // Every "grant select (...) on public.screens to authenticated" in the numbered SQL files, in order: 06, 18, 21...
  const dir = new URL("../supabase/", import.meta.url);
  const granted = readdirSync(dir).filter((f) => /^\d\d-.*\.sql$/.test(f)).sort()
    .flatMap((f) => [...readFileSync(new URL(f, dir), "utf8").matchAll(/grant select \(([^)]+)\)\s+on public\.screens to authenticated/g)])
    .flatMap((m) => m[1].split(",").map((c) => c.trim()));
  assert.deepEqual([...new Set(granted)].sort(), [...readable].sort(), "the SQL grants exactly the console's columns plus sizes");
  assert.ok(!granted.includes("hardware"));
});

test("a screen marked as having no HDMI-CEC isn't flagged for its TV; everything else still is", async () => {
  const owner = await login("leighann@barber.test", "owner-pass");
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const rest = (token, q, init = {}) => fake.handle(new Request(`${SB}/rest/v1/screens?${q}`, { ...init, headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=minimal" } }));
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const sc = fake.T.screens.find((x) => x.id === dev.screen_id);
  const saved = { last_seen: dev.last_seen, last_health: dev.last_health };
  Object.assign(dev, { last_seen: new Date().toISOString(), last_health: { tv: "not-answering", temp_c: 50 } });
  const row = async () => (await (await devApi(admin, { qs: "?summary=1" })).json()).devices.find((d) => d.id === dev.id);

  const before = (await row()).problems;
  assert.ok(before.includes("TV not answering"), "a display that doesn't answer is flagged by default");
  assert.equal(sc.no_cec, false, "every screen starts as before");

  assert.equal((await rest(owner, `id=eq.${sc.id}`, { method: "PATCH", body: JSON.stringify({ no_cec: true }) })).status >= 400 || !sc.no_cec, true, "owners can't set it");
  assert.equal(sc.no_cec, false);
  const r = await rest(admin, `id=eq.${sc.id}`, { method: "PATCH", body: JSON.stringify({ no_cec: true }) });
  assert.ok(r.status < 300 && sc.no_cec === true, "1Point sets it in Screen settings");
  const read = await (await rest(owner, `select=id,no_cec&id=eq.${sc.id}`)).json();
  assert.deepEqual(read, [{ id: sc.id, no_cec: true }], "signed-in users can read it, like the other screen settings");

  let h = await row();
  assert.ok(!h.problems.some((p) => /^TV/.test(p)), "no TV problem for a display without HDMI-CEC");
  assert.deepEqual(h.problems, before.filter((p) => p !== "TV not answering"), "only the TV problem goes");
  assert.equal(h.no_cec, true); assert.equal(h.screen.no_cec, true);
  dev.last_health = { tv: "not-answering", under_voltage_now: true, temp_c: 85 };
  h = await row();
  assert.ok(h.problems.includes("power low now") && h.problems.includes("hot") && !h.problems.some((p) => /^TV/.test(p)), "every other check still counts");

  const js = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
  assert.ok(js("console.js").includes('no_cec: $("s-nocec").checked'), "the console's Screen settings save it");
  assert.ok(js("console-devices.js").includes("s?.no_cec ?"), "the Pi panel says so instead of a warning");
  assert.ok(/screens\?select=[\w,]*no_cec/.test(js("tech.js")) && js("tech.js").includes("!s.no_cec && h.tv"), "the technician page doesn't ask for the TV's CEC setting");
  const sql = readFileSync(new URL("../supabase/21-no-cec.sql", import.meta.url), "utf8");
  assert.ok(sql.includes("no_cec boolean not null default false") && sql.includes("grant select (no_cec) on public.screens to authenticated"));

  Object.assign(sc, { no_cec: false }); Object.assign(dev, saved);
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

// ── Wi-Fi networks and prepare codes (generic prepared cards) ──
const netApi = (token, { method = "GET", body } = {}) => networks(req("/api/networks", { method, token, body }));
test("saved Wi-Fi is 1Point-only, and passwords never come back to the console", async () => {
  const owner = await login("leighann@barber.test", "owner-pass");
  const editor = await login("editor@barber.test", "editor-pass");
  const admin = await login("scot@1pointusa.com", "admin-pass");
  for (const t of [owner, editor]) {
    assert.equal((await netApi(t)).status, 403);
    assert.equal((await netApi(t, { method: "POST", body: { action: "save", ssid: "X", psk: "password1" } })).status, 403);
    assert.equal((await netApi(t, { method: "POST", body: { action: "code" } })).status, 403);
  }
  assert.equal((await netApi(null)).status, 401);
  const save = (body) => netApi(admin, { method: "POST", body: { action: "save", ...body } });
  assert.equal((await save({ label: "Perimeter Park One", ssid: "PPI-Lobby", psk: "correct horse" })).status, 200);
  assert.equal((await save({ label: "1Point office", ssid: "1Point-Guest", psk: "" })).status, 200, "an open network");
  assert.equal((await save({ ssid: "Short", psk: "1234567" })).status, 400, "WPA passwords are at least 8 characters");
  assert.equal((await save({ ssid: "x".repeat(33), psk: "password1" })).status, 400, "network names are at most 32 bytes");
  const list = (await (await netApi(admin)).json()).networks;
  assert.equal(list.length, 2);
  assert.ok(list.every((n) => !("psk" in n)), "no passwords in the list");
  const ppi = list.find((n) => n.ssid === "PPI-Lobby");
  assert.equal(ppi.has_password, true); assert.equal(list.find((n) => n.ssid === "1Point-Guest").has_password, false);
  assert.equal((await save({ id: ppi.id, label: "Perimeter Park One", ssid: "PPI-Lobby", hidden: true })).status, 200);
  assert.equal(fake.T.wifi_networks.find((n) => n.id === ppi.id).psk, "correct horse", "editing without a password keeps the saved one");
});

test("a prepare code downloads the networks once, within the hour", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const r = await (await netApi(admin, { method: "POST", body: { action: "code" } })).json();
  assert.match(r.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, "reads cleanly off a screen");
  assert.ok(!fake.T.prepare_codes.some((c) => JSON.stringify(c).includes(normalCode(r.code))), "only a hash is stored");
  const prep = (code) => networks(req("/api/networks", { method: "POST", body: { action: "prepare", code } }));
  assert.equal((await prep("ZZZZ-ZZZZ")).status, 403, "a wrong code");
  const ok = await prep(r.code.toLowerCase().replace("-", " "));
  assert.equal(ok.status, 200, "case and spacing don't matter");
  const nets = (await ok.json()).networks;
  assert.deepEqual(nets.map((n) => [n.ssid, n.psk, n.hidden]), [["1Point-Guest", "", false], ["PPI-Lobby", "correct horse", true]]);
  assert.equal((await prep(r.code)).status, 403, "works once");
  const late = await (await netApi(admin, { method: "POST", body: { action: "code" } })).json();
  fake.T.prepare_codes.at(-1).expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await prep(late.code)).status, 403, "expired after an hour");
  const del = fake.T.wifi_networks.find((n) => n.ssid === "1Point-Guest");
  await netApi(admin, { method: "POST", body: { action: "delete", id: del.id } });
  assert.equal(fake.T.wifi_networks.length, 1);
});

// ── Alert email through the company mail server (SMTP) ──
const mail = (port, extra = {}) => ({ host: "localhost", port, user: "alerts@1pointusa.com", pass: "secret", from: "Lobby Directory <alerts@1pointusa.com>",
  to: ["ops@1pointusa.com", "tech@1pointusa.com"], subject: "Directory screens: 1 problem", html: "<p>⚠️ PPI 2 South is offline</p>", tlsOptions: { ca: CERT }, timeoutMs: 5000, ...extra });
const decoded = (m) => Buffer.from(m.data.split("\n\n").slice(1).join("").replace(/\s/g, ""), "base64").toString();

test("mail goes out through an encrypted-from-the-start server (port 465 style)", async () => {
  const srv = await fakeSmtp({ implicit: true });
  try {
    assert.equal(await sendMail(mail(srv.port, { secure: true })), true);
    const [m] = srv.got.messages;
    assert.equal(m.from, "alerts@1pointusa.com"); assert.deepEqual(m.to, ["ops@1pointusa.com", "tech@1pointusa.com"]);
    assert.match(m.data, /^From: Lobby Directory <alerts@1pointusa.com>$/m); assert.match(m.data, /^Subject: Directory screens: 1 problem$/m);
    assert.match(decoded(m), /PPI 2 South is offline/);
    assert.deepEqual(srv.got.auth, [{ user: "alerts@1pointusa.com", pass: "secret", secure: true }]);
  } finally { srv.close(); }
});

test("mail goes out through STARTTLS (port 587 style), signing in only once it's encrypted", async () => {
  const srv = await fakeSmtp({ starttls: true, plainAuth: false });
  try {
    assert.equal(await sendMail(mail(srv.port)), true);
    assert.equal(srv.got.messages.length, 1);
    assert.ok(srv.got.auth.length === 1 && srv.got.auth[0].secure, "the password went over the encrypted connection");
    assert.ok(!srv.got.commands.some((c) => /^AUTH/.test(c.line) && !c.secure), "never before encryption");
  } finally { srv.close(); }
});

test("a server that offers no encryption never gets the password", async () => {
  const srv = await fakeSmtp({ starttls: false });
  try {
    await assert.rejects(sendMail(mail(srv.port)), /doesn't offer encryption/);
    assert.equal(srv.got.auth.length, 0); assert.equal(srv.got.messages.length, 0);
  } finally { srv.close(); }
});

test("alerts use the mail server when it's set up; a wrong password means not sent (and retried next run)", async () => {
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  const srv = await fakeSmtp({ starttls: true, password: "right" });
  const saved = { ...process.env };
  Object.assign(process.env, { SMTP_HOST: "localhost", SMTP_PORT: String(srv.port), SMTP_USER: "alerts@1pointusa.com", SMTP_PASS: "wrong",
    ALERT_EMAIL_TO: "ops@1pointusa.com", ALERT_EMAIL_FROM: "Lobby Directory <alerts@1pointusa.com>" });
  delete process.env.RESEND_API_KEY;
  const log = console.log; console.log = () => {};
  try {
    dev.last_health = { temp_c: 88 };
    const bad = await runAlerts({ send: (lines) => sendEmail(lines, { tlsOptions: { ca: CERT } }) });
    assert.equal(bad.sent, false); assert.ok(!dev.alert_state.hot, "not saved after a refused sign-in");
    process.env.SMTP_PASS = "right";
    const good = await runAlerts({ send: (lines) => sendEmail(lines, { tlsOptions: { ca: CERT } }) });
    assert.equal(good.sent, true); assert.equal(dev.alert_state.hot, true);
    assert.match(decoded(srv.got.messages.at(-1)), /running hot at 88/);
  } finally {
    console.log = log; srv.close();
    for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "ALERT_EMAIL_TO", "ALERT_EMAIL_FROM"]) delete process.env[k];
    Object.assign(process.env, saved);
    dev.last_health = { temp_c: 50 }; await runAlerts({ send: async () => true });
  }
});

// ── Alert emails set in the console ──
const alertApi = (token, { method = "GET", body } = {}, extra) => alertSettings(req("/api/alert-settings", { method, token, body }), {}, extra);

test("alert recipients are 1Point-only, checked, and one address appears once", async () => {
  const owner = await login("leighann@barber.test", "owner-pass");
  const admin = await login("scot@1pointusa.com", "admin-pass");
  assert.equal((await alertApi(owner)).status, 403);
  assert.equal((await alertApi(owner, { method: "POST", body: { action: "save", email: "x@y.com" } })).status, 403);
  const save = (b) => alertApi(admin, { method: "POST", body: { action: "save", ...b } });
  assert.equal((await save({ email: "not an email" })).status, 400);
  assert.equal((await save({ email: "Ops@1PointUSA.com", name: "Ops" })).status, 200);
  assert.equal((await save({ email: "tech@1pointusa.com", name: "Tech", power: false, hot: false })).status, 200);
  assert.equal((await save({ email: "ops@1pointusa.com" })).status, 409, "already on the list");
  const r = await (await alertApi(admin)).json();
  assert.deepEqual(r.recipients.map((x) => [x.email, x.offline, x.power, x.hot]), [["ops@1pointusa.com", true, true, true], ["tech@1pointusa.com", true, false, false]]);
  assert.ok("sender" in r && !JSON.stringify(r).includes("SMTP_PASS"), "how mail is sent, without secrets");
});

test("each recipient gets only the alerts they chose; any failed email means retry", async () => {
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  dev.last_health = { temp_c: 90 };
  dev.last_seen = new Date(Date.now() - 60 * 60_000).toISOString();          // offline and (last known) hot
  const calls = [];
  let r = await runAlerts({ send: async (lines, opts) => { calls.push({ to: opts.to, kinds: lines.map((l) => l.kind).sort() }); return !opts.to.includes("tech@1pointusa.com"); } });
  assert.deepEqual(calls.sort((a, b) => a.to.length - b.to.length || a.to[0].localeCompare(b.to[0])),
    [{ to: ["ops@1pointusa.com"], kinds: ["hot", "offline"] }, { to: ["tech@1pointusa.com"], kinds: ["offline"] }]);
  assert.equal(r.sent, false, "tech's email failed");
  assert.ok(!dev.alert_state.offline, "so nothing is saved and it's retried");
  r = await runAlerts({ send: async () => true });
  assert.equal(r.sent, true); assert.equal(dev.alert_state.offline, true);
  dev.last_health = { temp_c: 50 }; dev.last_seen = new Date().toISOString();
  await runAlerts({ send: async () => true });
});

test("Send test email: sent to every recipient now, or the mail server's exact reason", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const srv = await fakeSmtp({ starttls: true, password: "right" });
  const saved = { ...process.env };
  const test = async (body = {}) => (await alertApi(admin, { method: "POST", body: { action: "test", ...body } }, { tlsOptions: { ca: CERT } })).json();
  try {
    for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "RESEND_API_KEY"]) delete process.env[k];
    const log = console.log; console.log = () => {};
    const none = await test(); console.log = log;
    assert.equal(none.ok, false); assert.match(none.error, /No mail server is set up/);
    Object.assign(process.env, { SMTP_HOST: "localhost", SMTP_PORT: String(srv.port), SMTP_USER: "directory@1pointusa.com", SMTP_PASS: "wrong",
      ALERT_EMAIL_FROM: "Lobby Directory <directory@1pointusa.com>" });
    const bad = await test();
    assert.equal(bad.ok, false); assert.match(bad.error, /^mail server: sign-in: 535/);
    process.env.SMTP_PASS = "right";
    const good = await test();
    assert.equal(good.ok, true); assert.deepEqual(good.to.sort(), ["ops@1pointusa.com", "tech@1pointusa.com"]);
    const m = srv.got.messages.at(-1);
    assert.deepEqual(m.to.sort(), ["ops@1pointusa.com", "tech@1pointusa.com"]);
    assert.match(m.data, /^Subject: Directory screens: test email$/m);
    assert.match(decoded(m), /test email from the Lobby Directory console, sent by Scot/);
    const one = await test({ email: "someone@example.com" });
    assert.equal(one.ok, true); assert.deepEqual(srv.got.messages.at(-1).to, ["someone@example.com"]);
    const info = await (await alertApi(admin)).json();
    assert.equal(info.sender.via, "mail server"); assert.equal(info.sender.source, "netlify");
    assert.equal(info.sender.server, `localhost:${srv.port}`); assert.equal(info.sender.from, "Lobby Directory <directory@1pointusa.com>");
    assert.ok(!/pass|enc/i.test(Object.keys(info.sender).join(",")) && !JSON.stringify(info).includes(process.env.SMTP_PASS), "never a password");
  } finally {
    srv.close();
    for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "ALERT_EMAIL_FROM"]) delete process.env[k];
    Object.assign(process.env, saved);
    fake.T.alert_recipients.length = 0;
  }
});

// ── Config ──
test("config hands the pages only the public settings", async () => {
  const d = await (await config()).json();
  assert.deepEqual(d, { url: SB, anonKey: ANON_KEY, mapsKey: "", togoBase: "https://waytugo.com/d/" });
  assert.ok(!JSON.stringify(d).includes(SERVICE_KEY));
  // The Google Maps browser key is public by design (locked to the site's address); the Routes key never leaves the server
  Object.assign(process.env, { GOOGLE_MAPS_KEY: "browser-key-123", GOOGLE_ROUTES_KEY: "server-routes-key-456" });
  try {
    const e = await (await config()).json();
    assert.equal(e.mapsKey, "browser-key-123");
    assert.ok(!JSON.stringify(e).includes("server-routes-key-456"));
  } finally { delete process.env.GOOGLE_MAPS_KEY; delete process.env.GOOGLE_ROUTES_KEY; }
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

// ── Hardening (DP-04 round 2, 17-hardening.sql) ──
// Made-up Pis for these tests, removed afterwards so the alert and health tests elsewhere aren't affected
const scratchPis = (n, prefix) => Array.from({ length: n }, (_, i) => {
  const d = { id: `${prefix}-${i}`, serial: `${prefix.replace(/[^0-9a-f]/g, "").padEnd(8, "0").slice(0, 8)}${String(i).padStart(8, "0")}`, screen_id: null, status: "active",
    model: "", hostname: "", agent_version: "1.8.1", last_seen: new Date().toISOString(), last_health: {}, key_hash: "h", created_at: new Date().toISOString() };
  fake.T.devices.push(d); return d;
});
const dropPis = (ids) => {
  for (const t of ["device_commands", "device_daily", "devices"]) {
    const list = fake.T[t];
    for (let i = list.length - 1; i >= 0; i--) if (ids.has(t === "devices" ? list[i].id : list[i].device_id)) list.splice(i, 1);
  }
};
const shiftDay = (day, n) => new Date(Date.parse(day + "T12:00:00Z") + n * 86400_000).toISOString().slice(0, 10);

test("Health counts every Pi's whole month past 33 Pis (Supabase returns at most 1,000 rows)", async () => {
  const pis = scratchPis(40, "aaaa");
  const today = centralDay();
  for (const d of pis) for (let i = 0; i < 30; i++)
    fake.T.device_daily.push({ id: fake.T.device_daily.length + 100000, device_id: d.id, day: shiftDay(today, -i), checkins: 1440, online_s: 86400, power_dips: i < 7 ? 1 : 0, browser_down: 0, max_temp_c: 50, first_at: `${shiftDay(today, -29)}T05:00:00Z` });
  try {
    // The old way, 30 daily rows a Pi: 1,200 rows, of which only 1,000 come back
    const raw = await fake.handle(new Request(`${SB}/rest/v1/device_daily?day=gte.${shiftDay(today, -29)}&select=device_id`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }));
    assert.ok((await raw.json()).length <= 1000, "the fake caps rows as Supabase does");
    const admin = await login("scot@1pointusa.com", "admin-pass");
    const before = fake.rpcCalls.length;
    const r = await (await devApi(admin, { qs: "?summary=1" })).json();
    assert.ok(fake.rpcCalls.slice(before).includes("health_window"), "totals come from the database, one row per Pi");
    for (const d of pis) {
      const row = r.devices.find((x) => x.id === d.id);
      assert.equal(row.uptime.d30, 100, `${d.serial} has its whole month counted`);
      assert.equal(row.dips.d7, 7); assert.equal(row.dips.d30, 7); assert.equal(row.max_temp_7d, 50);
      assert.equal(row.history_from, shiftDay(today, -29));
    }
  } finally { dropPis(new Set(pis.map((d) => d.id))); }
});

test("the site's 30-day totals match the database function's on the same history", async () => {
  const today = "2026-10-06", rows = [];
  for (const id of ["A", "B", "C"]) for (let i = 0; i < 40; i++) {
    if ((i * 7 + id.charCodeAt(0)) % 5 === 0) continue;                  // gaps: days a Pi was off
    rows.push({ device_id: id, day: shiftDay(today, -i), checkins: 30 + i, online_s: i % 9 === 0 ? null : 1000 * i + 17,
      power_dips: i % 3, browser_down: i % 4 === 0 ? 1 : 0, max_temp_c: i % 6 === 0 ? null : 40 + (i % 11), first_at: `${shiftDay(today, -i)}T1${i % 10}:00:00Z` });
  }
  const saved = fake.T.device_daily.splice(0);
  try {
    fake.T.device_daily.push(...rows);
    const db = await (await fake.handle(new Request(`${SB}/rest/v1/rpc/health_window`, { method: "POST", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }, body: JSON.stringify({ p_today: today }) }))).json();
    const site = windowsFromDaily(rows, today);
    const sort = (l) => [...l].sort((a, b) => a.device_id.localeCompare(b.device_id));
    assert.deepEqual(sort(site), sort(db));
    assert.equal(db.length, 3);
  } finally { fake.T.device_daily.splice(0, fake.T.device_daily.length, ...saved); }
});

test("the console reads only each Pi's latest five actions", async () => {
  const [d] = scratchPis(1, "bbbb");
  const sc = fake.T.screens.find((x) => !fake.T.devices.some((v) => v.screen_id === x.id));
  d.screen_id = sc.id;
  for (let i = 1; i <= 12; i++)
    fake.T.device_commands.push({ id: 900000 + i, device_id: d.id, command: "reload", status: "done", result: `r${i}`, payload: null, created_at: new Date(Date.now() - (13 - i) * 60000).toISOString(), sent_at: null, done_at: null });
  try {
    const admin = await login("scot@1pointusa.com", "admin-pass");
    const before = fake.restCalls.length, rpcBefore = fake.rpcCalls.length;
    const r = await (await devApi(admin)).json();
    const mine = r.devices.find((x) => x.id === d.id);
    assert.deepEqual(mine.commands.map((c) => c.result), ["r12", "r11", "r10", "r9", "r8"]);
    assert.ok(!("payload" in mine.commands[0]), "a join's password field never reaches the console");
    assert.ok(fake.rpcCalls.slice(rpcBefore).includes("recent_device_commands"));
    assert.ok(!fake.restCalls.slice(before).includes("GET device_commands"), "the whole action history isn't read");
  } finally { dropPis(new Set([d.id])); }
});

test("old actions and history are trimmed by the alert check; each Pi's latest five stay", async () => {
  const [d, e] = scratchPis(2, "cccc");
  const old = new Date(Date.now() - 100 * 86400_000).toISOString(), fresh = new Date().toISOString();
  for (let i = 1; i <= 8; i++)
    fake.T.device_commands.push({ id: 910000 + i, device_id: d.id, command: "reload", status: "done", result: "", payload: null, created_at: i <= 6 ? old : fresh, sent_at: null, done_at: null });
  fake.T.device_commands.push({ id: 910100, device_id: e.id, command: "reboot", status: "done", result: "", payload: null, created_at: old, sent_at: null, done_at: null });
  const today = centralDay();
  fake.T.device_daily.push({ device_id: d.id, day: shiftDay(today, -401), checkins: 1 }, { device_id: d.id, day: shiftDay(today, -399), checkins: 1 });
  const saved = { SMTP_HOST: process.env.SMTP_HOST, RESEND_API_KEY: process.env.RESEND_API_KEY };
  delete process.env.SMTP_HOST; delete process.env.RESEND_API_KEY;
  try {
    await alertsJob();
    const left = fake.T.device_commands.filter((c) => c.device_id === d.id).map((c) => c.id - 910000).sort((a, b) => a - b);
    assert.deepEqual(left, [4, 5, 6, 7, 8], "over 90 days old goes, unless it's one of the Pi's latest five");
    assert.ok(fake.T.device_commands.some((c) => c.device_id === e.id), "a Pi's only action stays however old");
    const days = fake.T.device_daily.filter((x) => x.device_id === d.id).map((x) => x.day);
    assert.deepEqual(days, [shiftDay(today, -399)], "daily history older than 400 days goes");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    dropPis(new Set([d.id, e.id]));
  }
});

// ── News blocklist (DP-04 round 3) ──
test("a blocked word catches its forms, not words that merely start the same way", () => {
  const L = ["murder", "dead", "die", "war", "body", "stab", "kill", "abuse", "mass shooting"];
  for (const t of ["Murders rise", "Murderer caught", "The murderer’s trial", "Murderous plot", "Murdered at home", "Warring factions",
    "Bodies found", "Stabbing downtown", "Killings continue", "Abusing power", "Dying patient", "Two dead", "Mass shootings rise", "MURDER TRIAL"])
    assert.equal(isBlocked(t, L), true, t);
  for (const t of ["Deadline extended", "Diet tips", "San Diego Padres", "Diesel prices", "Warm weather", "Warriors win", "Warning issued",
    "Killarney festival", "Massive shooting star display"])
    assert.equal(isBlocked(t, L), false, t);
  assert.equal(isBlocked("Terrorism hearing", ["terror"]), true);
  assert.equal(isBlocked("Bombshell report", ["bomb"]), false, "without * only the word's forms");
  assert.equal(isBlocked("Bombshell report", ["bomb*"]), true, "with * every word starting with it");
  assert.equal(isBlocked("Anything", []), false);
});

test("Netlify's blocklist adds to the built-in one, and descriptions are checked too", async () => {
  process.env.NEWS_FEEDS = "https://desc-test.example/rss";
  process.env.NEWS_BLOCKLIST = "flooding";
  try {
    const { items } = await (await news(req("/api/news"))).json();
    const titles = items.map((i) => i.title);
    assert.ok(!titles.includes("Police update on downtown incident"), "blocked by its description ('killed')");
    assert.ok(!titles.includes("Neighborhood flooding closes roads"), "blocked by Netlify's own word");
    assert.ok(!titles.includes("Convicted murderers appeal sentence"), "the built-in list still applies, with word forms");
    assert.deepEqual(titles, ["New deadline set for the city's diet program"]);
    assert.ok(!("summary" in items[0]), "descriptions aren't sent to the screens");
  } finally { delete process.env.NEWS_FEEDS; delete process.env.NEWS_BLOCKLIST; }
});

// ── Per-screen sizes (DP-04 round 4, 18-sizes.sql) ──
const setSizes = (token, screenId, sizes) => fake.handle(new Request(`${SB}/rest/v1/rpc/set_screen_sizes`, { method: "POST",
  headers: { apikey: ANON_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: JSON.stringify({ p_screen: screenId, p_sizes: sizes }) }));

test("anyone with the screen's account can size it; the screen picks it up at once", async () => {
  const scr = fake.T.screens.find((x) => x.key === "ppi-1s");
  const first = await screen(req("/api/screen?key=ppi-1s"));
  const etag = first.headers.get("ETag");
  assert.deepEqual((await first.json()).sizes, {}, "standard until someone changes it");
  try {
    const editor = await login("editor@barber.test", "editor-pass");       // a front-desk editor, not only the owner
    const r = await setSizes(editor, scr.id, { title: 80, logo: 100, brand: 999, welcome: 40, ticker: 70, bogus: "x" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { title: 80, brand: 250, welcome: 80 }, "100 isn't stored; out of range is clamped; unknown names ignored");
    const next = await screen(req("/api/screen?key=ppi-1s", { headers: { "If-None-Match": etag } }));
    assert.equal(next.status, 200, "a size change changes the screen's version");
    assert.deepEqual((await next.json()).sizes, { title: 80, brand: 250, welcome: 80 });
    const other = await screen(req("/api/screen?key=ppi-2s"));
    assert.deepEqual((await other.json()).sizes, {}, "per screen: another screen of the same owner is untouched");
  } finally { scr.sizes = {}; }
});

test("nobody outside the screen's account can size it", async () => {
  const scr = fake.T.screens.find((x) => x.key === "ppi-1s");
  const otherScreen = fake.T.screens.find((x) => x.key === "other-tower");
  const owner = await login("leighann@barber.test", "owner-pass");
  assert.equal((await setSizes(owner, otherScreen.id, { title: 60 })).status, 403, "another owner's screen");
  assert.equal((await setSizes(null, scr.id, { title: 60 })).status, 403, "not signed in");
  assert.deepEqual(otherScreen.sizes, {}); assert.deepEqual(scr.sizes, {});
  // and sizing is the only screen change an owner can make
  const patch = await fake.handle(new Request(`${SB}/rest/v1/screens?id=eq.${scr.id}`, { method: "PATCH",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${owner}`, "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ sizes: { title: 60 }, name: "Renamed" }) }));
  assert.ok(patch.status >= 400 || (await patch.json()).length === 0, "screens stay 1Point-only to write directly");
  assert.notEqual(scr.name, "Renamed");
});

// ── Widget sizes (DP-08 round 10, 22-widget-sizes.sql) ──
test("news, clock, weather and contacts can be sized per screen, 70 to 150%", async () => {
  const scr = fake.T.screens.find((x) => x.key === "ppi-1s");
  const etag = (await screen(req("/api/screen?key=ppi-1s"))).headers.get("ETag");
  try {
    const editor = await login("editor@barber.test", "editor-pass");
    const r = await setSizes(editor, scr.id, { news: 130, clock: 10, weather: 400, contacts: 100, title: 80 });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { news: 130, clock: 70, weather: 150, title: 80 }, "clamped to 70-150; 100 not stored; the older names still work");
    const next = await screen(req("/api/screen?key=ppi-1s", { headers: { "If-None-Match": etag } }));
    assert.equal(next.status, 200, "a widget size change reaches the screen within a minute");
    assert.deepEqual((await next.json()).sizes, { news: 130, clock: 70, weather: 150, title: 80 });
    const other = await screen(req("/api/screen?key=ppi-2s"));
    assert.deepEqual((await other.json()).sizes, {}, "per screen");
  } finally { scr.sizes = {}; }
});

test("the size ranges agree: the latest SQL, the display, the editor's sliders and the test fake", () => {
  // The newest numbered SQL file that defines set_screen_sizes is what Supabase runs
  const files = readdirSync(new URL("../supabase/", import.meta.url)).filter((f) => /^\d\d-.*\.sql$/.test(f)).sort();
  const sqlFile = files.filter((f) => readFileSync(new URL(`../supabase/${f}`, import.meta.url), "utf8").includes("function public.set_screen_sizes")).pop();
  assert.equal(sqlFile, "24-directory-to-go.sql");
  const sql = readFileSync(new URL(`../supabase/${sqlFile}`, import.meta.url), "utf8");
  const fromSql = Object.fromEntries([...sql.matchAll(/\('(\w+)', (\d+), (\d+)\)/g)].map(([, n, lo, hi]) => [n, [+lo, +hi]]));
  assert.deepEqual(fromSql, SIZE_RANGES, "SQL = test fake");
  const js = readFileSync(new URL("../public/display.js", import.meta.url), "utf8");
  const block = js.match(/const SIZE_RANGES = \{([^}]+)\}/)[1];
  const fromDisplay = Object.fromEntries([...block.matchAll(/(\w+): \[(\d+), (\d+)\]/g)].map(([, n, lo, hi]) => [n, [+lo, +hi]]));
  assert.deepEqual(fromDisplay, SIZE_RANGES, "display = SQL");
  const html = readFileSync(new URL("../public/edit.html", import.meta.url), "utf8");
  const fromEditor = Object.fromEntries([...html.matchAll(/<input id="sz-(\w+)" type="range" min="(\d+)" max="(\d+)"/g)].map(([, n, lo, hi]) => [n, [+lo, +hi]]));
  assert.deepEqual(fromEditor, SIZE_RANGES, "editor sliders = SQL");
  const ejs = readFileSync(new URL("../public/edit.js", import.meta.url), "utf8");
  const listed = JSON.parse(ejs.match(/const SIZES = (\[[^\]]+\])/)[1]);
  assert.deepEqual([...listed].sort(), Object.keys(SIZE_RANGES).sort(), "the editor saves every size");
});

// ── The information panel: traffic map, travel times, amenities (DP-08 round 11, 23-info-panel.sql) ──
const infoFixture = () => {
  const scr = fake.T.screens.find((x) => x.key === "ppi-1s");
  const dir = fake.T.directories.find((x) => x.id === scr.directory_id);
  const prop = fake.T.properties.find((x) => x.id === dir.property_id);
  const saved = { dir: { ...dir }, prop: { ...prop }, scr: { ...scr } };
  const restore = () => { Object.assign(dir, saved.dir); Object.assign(prop, saved.prop); Object.assign(scr, saved.scr); fake.setClock(null);
    delete process.env.GOOGLE_MAPS_KEY; delete process.env.GOOGLE_ROUTES_KEY; };
  return { scr, dir, prop, restore };
};
const WEEKDAY_NOON = "2026-10-21T17:00:00Z";   // a Wednesday, noon in Birmingham
const GOOGLE_OK = [
  { originIndex: 0, destinationIndex: 0, status: {}, condition: "ROUTE_EXISTS", duration: "1260s", staticDuration: "1020s", distanceMeters: 25750 },
  { originIndex: 0, destinationIndex: 1, status: {}, condition: "ROUTE_EXISTS", duration: "1080s", staticDuration: "1080s", distanceMeters: 22530 },
];
async function withGoogle(answer, fn) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://routes.googleapis.com/")) { calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return typeof answer === "function" ? answer() : new Response(JSON.stringify(answer), { status: 200 }); }
    return real(url, init);
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

test("the information panel is off until switched on: existing screens look exactly as before", async () => {
  const d = await (await screen(req("/api/screen?key=ppi-1s"))).json();
  assert.deepEqual(d.traffic, { map: false, times: false, lat: d.traffic.lat, lon: d.traffic.lon, mapsKey: "", destinations: [] });
  assert.deepEqual(d.amenities, []);
});

test("switched on per directory: the screen gets the map (with the browser key), its destinations and tidy amenities", async () => {
  const { dir, prop, restore } = infoFixture();
  try {
    process.env.GOOGLE_MAPS_KEY = "browser-key-123"; process.env.GOOGLE_ROUTES_KEY = "server-routes-key-456";
    Object.assign(dir, { map_enabled: true, times_enabled: true, amenities_enabled: true, updated_at: new Date().toISOString() });
    Object.assign(prop, { destinations: [{ label: "Birmingham Airport", address: "5900 Messer Airport Hwy, Birmingham, AL" }, { label: "BJCC", address: "2100 Richard Arrington Jr Blvd N, Birmingham, AL" }],
      amenities: [{ name: "  The Summit  ", distance: "1.2 mi", line: "Shops and restaurants", extra: "x" }, { name: "" }, ...Array.from({ length: 25 }, (_, i) => ({ name: `Place ${i}` }))] });
    const d = await (await screen(req("/api/screen?key=ppi-1s"))).json();
    assert.equal(d.traffic.map, true); assert.equal(d.traffic.times, true);
    assert.equal(d.traffic.mapsKey, "browser-key-123");
    assert.deepEqual(d.traffic.destinations, ["Birmingham Airport", "BJCC"], "labels only: addresses stay on the server");
    assert.ok(!JSON.stringify(d).includes("server-routes-key-456"), "the Routes key never reaches a screen");
    assert.deepEqual(d.amenities[0], { name: "The Summit", distance: "1.2 mi", line: "Shops and restaurants" });
    assert.ok(d.amenities.length <= 20 && d.amenities.every((a) => a.name), "at most 20, none blank");
    delete process.env.GOOGLE_MAPS_KEY;
    const e = await (await screen(req("/api/screen?key=ppi-1s"))).json();
    assert.equal(e.traffic.map, false, "no map without the Google Maps key in Netlify");
    assert.equal(e.traffic.mapsKey, "");
  } finally { restore(); }
});

test("travel times: one Google call per screen, traffic-aware, straight through, never stored or shared", async () => {
  const { dir, prop, scr, restore } = infoFixture();
  try {
    fake.setClock(WEEKDAY_NOON);
    process.env.GOOGLE_ROUTES_KEY = "server-routes-key-456";
    Object.assign(dir, { times_enabled: true });
    Object.assign(prop, { lat: 33.4285, lon: -86.7114, destinations: [{ label: "Birmingham Airport", address: "5900 Messer Airport Hwy" }, { label: "BJCC", address: "2100 Richard Arrington Jr Blvd N" }] });
    await withGoogle(GOOGLE_OK, async (calls) => {
      const r = await traffic(req("/api/traffic?key=ppi-1s"));
      assert.equal(r.status, 200);
      const d = await r.json();
      assert.deepEqual(d.times, [
        { label: "Birmingham Airport", minutes: 21, usualMinutes: 17, miles: 16 },
        { label: "BJCC", minutes: 18, usualMinutes: 18, miles: 14 },
      ]);
      assert.equal(d.source, "Google Maps");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].headers["X-Goog-Api-Key"], "server-routes-key-456");
      assert.match(calls[0].headers["X-Goog-FieldMask"], /duration/);
      assert.equal(calls[0].body.routingPreference, "TRAFFIC_AWARE");
      assert.equal(calls[0].body.travelMode, "DRIVE");
      assert.deepEqual(calls[0].body.origins, [{ waypoint: { location: { latLng: { latitude: 33.4285, longitude: -86.7114 } } } }]);
      assert.deepEqual(calls[0].body.destinations.map((x) => x.waypoint.address), ["5900 Messer Airport Hwy", "2100 Richard Arrington Jr Blvd N"]);
      // Asking again within 25 minutes goes nowhere near Google
      const again = await (await traffic(req("/api/traffic?key=ppi-1s"))).json();
      assert.ok(again.wait > 0 && again.wait <= 1500, JSON.stringify(again));
      assert.equal(calls.length, 1);
      // Another screen of the same building asks for itself (no shared cache), and gets its own Google call
      const other = fake.T.screens.find((x) => x.key !== "ppi-1s" && x.directory_id && fake.T.directories.find((y) => y.id === x.directory_id)?.property_id === prop.id);
      const od = fake.T.directories.find((y) => y.id === other.directory_id); const odSaved = { ...od };
      try {
        od.times_enabled = true;
        const o = await (await traffic(req(`/api/traffic?key=${other.key}`))).json();
        assert.equal(o.times.length, 2); assert.equal(calls.length, 2);
      } finally { Object.assign(od, odSaved); other.traffic_at = null; }
      // After 25 minutes it may ask again
      fake.setClock(new Date(Date.parse(WEEKDAY_NOON) + 26 * 60000));
      assert.ok((await (await traffic(req("/api/traffic?key=ppi-1s"))).json()).times);
      assert.equal(calls.length, 3);
    });
    // Nothing from Google is kept anywhere in the database
    assert.ok(!JSON.stringify(fake.T).includes("1260s") && !JSON.stringify(fake.T).includes("ROUTE_EXISTS"));
  } finally { restore(); }
});

test("travel times stay quiet when they shouldn't run: no key, switched off, weekends and nights, Google errors", async () => {
  const { dir, prop, scr, restore } = infoFixture();
  try {
    Object.assign(dir, { times_enabled: true });
    Object.assign(prop, { destinations: [{ label: "BJCC", address: "2100 Richard Arrington Jr Blvd N" }] });
    fake.setClock(WEEKDAY_NOON);
    const before = fake.rpcCalls.length;
    assert.deepEqual(await (await traffic(req("/api/traffic?key=ppi-1s"))).json(), { off: "not set up" });
    assert.equal(fake.rpcCalls.length, before, "no Routes key: not even a database call");
    process.env.GOOGLE_ROUTES_KEY = "server-routes-key-456";
    await withGoogle(GOOGLE_OK, async (calls) => {
      dir.times_enabled = false;
      assert.deepEqual(await (await traffic(req("/api/traffic?key=ppi-1s"))).json(), { off: "switched off" });
      dir.times_enabled = true;
      fake.setClock("2026-10-25T17:00:00Z");                          // Sunday
      assert.deepEqual(await (await traffic(req("/api/traffic?key=ppi-1s"))).json(), { off: "hours" });
      fake.setClock("2026-10-22T03:00:00Z");                          // Wednesday 10 p.m. in Birmingham
      assert.deepEqual(await (await traffic(req("/api/traffic?key=ppi-1s"))).json(), { off: "hours" });
      fake.setClock("2026-10-21T11:30:00Z");                          // 6:30 a.m.: on
      assert.ok((await (await traffic(req("/api/traffic?key=ppi-1s"))).json()).times);
      assert.equal(calls.length, 1, "only the in-hours ask reached Google");
      assert.equal(scr.traffic_at !== null, true);
    });
    scr.traffic_at = null;
    await withGoogle(() => new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 400 }), async () => {
      const r = await traffic(req("/api/traffic?key=ppi-1s"));
      assert.equal(r.status, 502);
      assert.match((await r.json()).error, /API key not valid/);
    });
    assert.equal((await traffic(req("/api/traffic?key=Bad Key"))).status, 400);
  } finally { restore(); }
});

test("Google's answer is read safely: missing routes show no time rather than a wrong one", () => {
  const t = toTimes([{ label: "A" }, { label: "B" }, { label: "C" }], [
    { destinationIndex: 0, duration: "600s", staticDuration: "540s", distanceMeters: 8000, condition: "ROUTE_EXISTS" },
    { destinationIndex: 1, condition: "ROUTE_NOT_FOUND" },
    { destinationIndex: 2, status: { code: 3, message: "bad" } },
  ]);
  assert.deepEqual(t.map((x) => x.minutes), [10, null, null]);
});

// ── Round 12: the WayTuGo mark, Directory to Go, place lists (24-directory-to-go.sql) ──
test("every screen shows Powered by WayTuGo unless 1Point hides it, and hiding it reaches the screen at once", async () => {
  const scr = fake.T.screens.find((x) => x.key === "ppi-1s");
  const first = await screen(req("/api/screen?key=ppi-1s"));
  assert.equal((await first.json()).poweredBy, true);
  try {
    scr.hide_powered_by = true;
    const next = await screen(req("/api/screen?key=ppi-1s", { headers: { "If-None-Match": first.headers.get("ETag") } }));
    assert.equal(next.status, 200, "the switch changes the screen's version");
    assert.equal((await next.json()).poweredBy, false);
  } finally { scr.hide_powered_by = false; }
  // Owners can read the switch (the console's column list) but only 1Point writes screens
  const owner = await login("leighann@barber.test", "owner-pass");
  const patch = await fake.handle(new Request(`${SB}/rest/v1/screens?id=eq.${scr.id}`, { method: "PATCH",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${owner}`, "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ hide_powered_by: true }) }));
  assert.ok(patch.status >= 400 || (await patch.json()).length === 0);
  assert.equal(scr.hide_powered_by, false);
});

test("Directory to Go: off until switched on; then the screen gets its waytugo.com link and words", async () => {
  const { dir, restore } = infoFixture();
  try {
    let d = await (await screen(req("/api/screen?key=ppi-1s"))).json();
    assert.deepEqual(d.togo, { enabled: false, url: "", line: "Take this directory with you!" });
    assert.match(dir.togo_code, /^[A-HJKMNP-Z2-9]{6}$/, "every directory has a code");
    Object.assign(dir, { togo_enabled: true, updated_at: new Date().toISOString() });
    d = await (await screen(req("/api/screen?key=ppi-1s"))).json();
    assert.deepEqual(d.togo, { enabled: true, url: `https://waytugo.com/d/${dir.togo_code}`, line: "Take this directory with you!" });
    process.env.TOGO_BASE = "https://example.test/d";
    Object.assign(dir, { togo_line: "  Scan me  ", updated_at: new Date(Date.now() + 1000).toISOString() });
    d = await (await screen(req("/api/screen?key=ppi-1s"))).json();
    assert.equal(d.togo.url, `https://example.test/d/${dir.togo_code}`);
    assert.equal(d.togo.line, "Scan me");
  } finally { delete process.env.TOGO_BASE; restore(); }
});

test("the phone page: the directory to take away, counted, read-only, only when switched on", async () => {
  const { dir, prop, restore } = infoFixture();
  const page = (code) => togo(req(`/d/${code}`));
  try {
    assert.equal((await page(dir.togo_code)).status, 404, "off: no page");
    assert.equal((await page("bad!")).status, 404);
    assert.equal((await page("AAAAAA")).status, 404, "an unknown code");
    Object.assign(dir, { togo_enabled: true, amenities_enabled: false });
    Object.assign(prop, { address: "100 Test Way, Birmingham, AL", managed_by: { name: "Leigh Ann", phone: "(205) 555-0100" },
      place_lists: [{ heading: "While you're here!", items: [{ name: "Barber Motorsports Park", distance: "15 min", line: "Racing and the museum" }] }] });
    const tenant = fake.T.tenants.find((t) => t.directory_id === dir.id);
    const savedName = tenant.name; tenant.name = 'Acme <script>alert(1)</script> & Co';
    const before = fake.T.togo_scans.filter((x) => x.directory_id === dir.id).reduce((n, x) => n + x.scans, 0);
    const r = await page(dir.togo_code.toLowerCase());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Cache-Control"), "no-store");
    assert.match(r.headers.get("X-Robots-Tag"), /noindex/);
    const html = await r.text();
    tenant.name = savedName;
    assert.ok(html.includes(esc(dir.title)), "the directory's title");
    assert.ok(html.includes("Acme &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co") && !html.includes("<script>alert(1)"), "names are escaped");
    assert.ok(html.includes('href="tel:2055550100"'), "phone numbers tap to call");
    assert.ok(html.includes("https://www.google.com/maps/search/?api=1&amp;query=100%20Test%20Way"), "the address opens in maps");
    assert.ok(!html.includes("Barber Motorsports Park"), "places only when the directory shows them");
    assert.ok(html.includes(`${SITE}/waytugo-logo.png`) && html.includes("Powered by <b>WayTuGo</b>"), "the WayTuGo mark");
    assert.equal(fake.T.togo_scans.filter((x) => x.directory_id === dir.id).reduce((n, x) => n + x.scans, 0), before + 1, "the open is counted");
    dir.amenities_enabled = true;
    const withPlaces = await (await page(dir.togo_code)).text();
    assert.ok(withPlaces.includes("While you&#39;re here!") && withPlaces.includes("Barber Motorsports Park"));
    // The count: the directory's own account, not a stranger
    const editor = await login("editor@barber.test", "editor-pass");
    const count = await fake.handle(new Request(`${SB}/rest/v1/rpc/togo_scan_count`, { method: "POST",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${editor}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_directory: dir.id }) }));
    assert.equal(count.status, 200);
    assert.ok((await count.json()).last30 >= 2);
    const other = fake.T.directories.find((x) => x.slug === "other-tower");
    const stray = await fake.handle(new Request(`${SB}/rest/v1/rpc/togo_scan_count`, { method: "POST",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${editor}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_directory: other.id }) }));
    assert.equal(stray.status, 403);
    // Replacing the code: the old link stops working, the new one works
    const old = dir.togo_code;
    const rep = await fake.handle(new Request(`${SB}/rest/v1/rpc/togo_replace_code`, { method: "POST",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${editor}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_directory: dir.id }) }));
    const code = await rep.json();
    assert.notEqual(code, old);
    assert.equal((await page(old)).status, 404);
    assert.equal((await page(code)).status, 200);
  } finally { restore(); }
});

test("place lists: headings, pictures only as small images, empty lists and entries dropped, at most 5 of 12", () => {
  const tiny = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  const lists = cleanPlaceLists([
    { heading: "  While you're here!  ", items: [{ name: "Barber Motorsports", distance: "15 min", line: "x".repeat(200), image: tiny }, { name: "" }] },
    { heading: "", items: [{ name: "Cafe", image: "javascript:alert(1)" }, { name: "Big", image: "data:image/png;base64," + "A".repeat(170000) }] },
    { heading: "Empty", items: [{ name: " " }] },
    ...Array.from({ length: 6 }, (_, i) => ({ heading: `L${i}`, items: Array.from({ length: 20 }, (_, j) => ({ name: `P${j}` })) })),
  ]);
  assert.equal(lists[0].heading, "While you're here!");
  assert.equal(lists[0].items.length, 1, "an entry without a name is dropped");
  assert.equal(lists[0].items[0].image, tiny);
  assert.equal(lists[0].items[0].line.length, 120);
  assert.equal(lists[1].heading, "Nearby", "a blank heading reads Nearby");
  assert.deepEqual(lists[1].items.map((a) => a.image), ["", ""], "only small data images are kept");
  assert.ok(!lists.some((l) => l.heading === "Empty"), "an empty list never shows");
  assert.ok(lists.length <= 5 && lists.every((l) => l.items.length <= 12));
  assert.deepEqual(cleanPlaceLists([], [{ name: "Coffee" }]), [{ heading: "Nearby", items: [{ name: "Coffee", distance: "", line: "", image: "" }] }], "round 11's places become Nearby");
});

test("the QR encoder in the display is the bundled MIT library and makes a code for any link", () => {
  const src = readFileSync(new URL("../public/vendor/qrcode.js", import.meta.url), "utf8");
  assert.match(src, /Kazuhiko Arase/); assert.match(src, /MIT license/);
  const ctx = { window: {} }; vm.runInNewContext(src, ctx);
  for (const url of ["https://waytugo.com/d/K7M2Q9", "https://1pdirectory.netlify.app/d/ABCDEF"]) {
    const q = ctx.window.LobbyQR(url);
    assert.ok(q.size >= 21 && q.size <= 41, `a small code (${q.size} modules)`);
    // the three finder patterns are where a QR code has them
    for (const [r, c] of [[0, 0], [0, q.size - 7], [q.size - 7, 0]]) assert.ok(q.dark(r, c) && q.dark(r + 6, c + 6) && !q.dark(r + 1, c + 1) && q.dark(r + 3, c + 3));
  }
  const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(index.indexOf("/vendor/qrcode.js") < index.indexOf("/display.js"), "loaded before the display");
  assert.ok(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8").includes('"/vendor/qrcode.js"'), "kept for offline");
});

test("the editor preview and the screen send sizes the same way", () => {
  const p = toPayload({ key: "k", name: "n", orientation: "portrait", sizes: { logo: 150 } }, { title: "T", updated_at: "x" }, { name: "B" }, []);
  assert.deepEqual(p.sizes, { logo: 150 });
  assert.deepEqual(toPayload({ key: "k", name: "n" }, null, null, []).sizes, {});
});

// ── Mail server sign-in in the console (DP-04 round 5, 19-mail.sql) ──
const SKEY = "test-settings-key-0123456789-abcdefghij";
test("sealed secrets: only the right SETTINGS_KEY opens them", () => {
  const a = seal("hunter2!", SKEY), b = seal("hunter2!", SKEY);
  assert.match(a, /^v1:/); assert.notEqual(a, b, "a fresh nonce each time");
  assert.ok(!a.includes("hunter2"));
  assert.equal(unseal(a, SKEY), "hunter2!");
  assert.throws(() => unseal(a, SKEY + "x"), /SETTINGS_KEY in Netlify has changed/);
  const raw = Buffer.from(a.slice(3), "base64"); raw[raw.length - 1] ^= 1;
  assert.throws(() => unseal("v1:" + raw.toString("base64"), SKEY), /changed|damaged/, "tampering is caught");
  assert.throws(() => seal("x", null), /SETTINGS_KEY isn't set/);
});

test("1Point sets the mail server in the console: sealed, write-only, and it wins over Netlify's", async () => {
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const owner = await login("leighann@barber.test", "owner-pass");
  const good = await fakeSmtp({ starttls: true, password: "console-pass" });
  const saved = { ...process.env };
  const post = async (body, token = admin) => (await alertApi(token, { method: "POST", body }, { tlsOptions: { ca: CERT } }));
  const form = { action: "mail-save", host: "localhost", port: String(good.port), secure: false, user: "alerts@1pointusa.com", password: "console-pass", from_address: "directory@1pointusa.com", from_name: "1Point Directory" };
  try {
    // Netlify's settings point at a server that refuses everything
    Object.assign(process.env, { SMTP_HOST: "localhost", SMTP_PORT: "1", SMTP_USER: "old", SMTP_PASS: "netlify-pass", ALERT_EMAIL_FROM: "old@1pointusa.com" });
    delete process.env.SETTINGS_KEY;
    assert.equal((await post(form, owner)).status, 403, "1Point only");
    const nokey = await post(form);
    assert.equal(nokey.status, 409); assert.match((await nokey.json()).error, /SETTINGS_KEY isn't set/);
    assert.equal(fake.T.mail_settings.length, 0);
    process.env.SETTINGS_KEY = SKEY;
    assert.equal((await post({ ...form, host: "not a host" })).status, 400);
    assert.equal((await post({ ...form, password: "" })).status, 400, "a first save needs the password");
    assert.equal((await post(form)).status, 200);
    const row = fake.T.mail_settings[0];
    assert.match(row.password_enc, /^v1:/); assert.ok(!row.password_enc.includes("console-pass"), "never stored as typed");
    const info = await (await alertApi(admin)).json();
    assert.equal(info.sender.source, "console"); assert.equal(info.sender.user, "alerts@1pointusa.com");
    assert.ok(!JSON.stringify(info).includes("console-pass") && !JSON.stringify(info).includes(row.password_enc), "the password never comes back");
    assert.ok(!fake.T.audit_log.some((a) => JSON.stringify(a).includes("console-pass")), "nor into the audit log");
    // the test email goes through the console's server, signing in with the saved password, over STARTTLS
    const t1 = await (await post({ action: "test", email: "ops@1pointusa.com" })).json();
    assert.equal(t1.ok, true, t1.error);
    assert.deepEqual(good.got.auth.at(-1), { user: "alerts@1pointusa.com", pass: "console-pass", secure: true });
    assert.match(good.got.messages.at(-1).data, /From: 1Point Directory <directory@1pointusa\.com>/);
    // saving again with the password left empty keeps it
    assert.equal((await post({ ...form, password: "", from_name: "" })).status, 200);
    assert.equal(unseal(fake.T.mail_settings[0].password_enc, SKEY), "console-pass");
    // a changed SETTINGS_KEY: the test email says exactly what to do
    process.env.SETTINGS_KEY = SKEY + "-rotated";
    const t2 = await (await post({ action: "test", email: "ops@1pointusa.com" })).json();
    assert.equal(t2.ok, false); assert.match(t2.error, /SETTINGS_KEY in Netlify has changed.*Enter the password again/);
    process.env.SETTINGS_KEY = SKEY;
    // removing the console's settings goes back to Netlify's
    assert.equal((await post({ action: "mail-clear" })).status, 200);
    assert.equal(fake.T.mail_settings.length, 0);
    assert.equal((await (await alertApi(admin)).json()).sender.source, "netlify");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fake.T.mail_settings.length = 0;
    good.close?.();
  }
});

// ── Screens reload themselves for a new display (DP-04 round 5) ──
test("the site and the display agree on the live display version", () => {
  const js = readFileSync(new URL("../public/display.js", import.meta.url), "utf8");
  assert.equal(js.match(/const VERSION = "([^"]+)"/)[1], DISPLAY_VERSION);
});
test("a display deploy gives every screen a fresh answer that names the live version", async () => {
  const first = await screen(req("/api/screen?key=ppi-1s"));
  const etag = first.headers.get("ETag");
  assert.ok(etag.includes(`-${DISPLAY_VERSION}-`), etag);
  assert.equal((await first.json()).display, DISPLAY_VERSION);
  assert.equal((await screen(req("/api/screen?key=ppi-1s", { headers: { "If-None-Match": etag } }))).status, 304);
  // a tag from before the deploy (another display version) is never "not modified"
  const old = etag.replace(`-${DISPLAY_VERSION}-`, "-2.7.0-");
  assert.equal((await screen(req("/api/screen?key=ppi-1s", { headers: { "If-None-Match": old } }))).status, 200);
});

// ── Round 13: touch screens, first step (25-touch.sql), agent 1.9.0 ──
test("agent 1.9.0's health: firmware, remote support and busy reach the console, only as known values", async () => {
  const dev = fake.T.devices.find((x) => x.serial === PPI2S_SERIAL);
  await checkin({ health: { firmware: "not-responding", remote: "on", busy: { command: "remote_on", since: 1761235000.4 } } });
  assert.equal(dev.last_health.firmware, "not-responding");
  assert.equal(dev.last_health.remote, "on");
  assert.deepEqual(dev.last_health.busy, { command: "remote_on", since: 1761235000 });
  await checkin({ health: { firmware: "<b>", remote: "maybe", busy: { command: "rm -rf /", since: 1 } } });
  assert.equal(dev.last_health.firmware, null); assert.equal(dev.last_health.remote, null); assert.equal(dev.last_health.busy, null);
  await checkin({ health: { busy: { command: "remote_off", since: "soon" } } });
  assert.equal(dev.last_health.busy, null, "a busy report needs a real start time");
  await checkin({ health: {} });
  const agentPy = readFileSync(new URL("../public/pi/agent.py", import.meta.url), "utf8");
  assert.equal(agentPy.match(/VERSION = "([^"]+)"/)[1], "1.9.0", "the agent on the site is 1.9.0");
  for (const w of ['"not-responding"', 'h["remote"]', 'h["busy"]']) assert.ok(agentPy.includes(w), `the agent reports ${w}`);
  const consoleJs = readFileSync(new URL("../public/console-devices.js", import.meta.url), "utf8");
  for (const w of ["Firmware stuck", "Remote on", "Remote off", "Busy: "]) assert.ok(consoleJs.includes(w), `the Screens list can say ${w}`);
});

test("touch settings: off and blank by default, then they reach the screen and change its version", async () => {
  const scr = fake.T.screens.find((x) => x.key === "ppi-1s");
  const first = await screen(req("/api/screen?key=ppi-1s"));
  const d0 = await first.json();
  assert.equal(d0.touch, false); assert.equal(d0.screenInches, null);
  try {
    Object.assign(scr, { touch: true, screen_inches: 13.3 });
    const next = await screen(req("/api/screen?key=ppi-1s", { headers: { "If-None-Match": first.headers.get("ETag") } }));
    assert.equal(next.status, 200, "the change gives the screen a new version");
    const d1 = await next.json();
    assert.equal(d1.touch, true); assert.equal(d1.screenInches, 13.3);
  } finally { Object.assign(scr, { touch: false, screen_inches: null }); }
  const sql = readFileSync(new URL("../supabase/25-touch.sql", import.meta.url), "utf8");
  assert.ok(sql.includes("between 7 and 100") && sql.includes("'touch', s.touch") && sql.includes("s.touch::text"), "25 checks the size and sends both");
  const con = readFileSync(new URL("../public/console.js", import.meta.url), "utf8");
  assert.ok(con.includes("touch,screen_inches") && con.includes('id="s-touch"') && con.includes('id="s-inches"'), "Screen settings has both");
});

test("the touch lockdown is on every screen: no zooming, selecting, dragging or long-press menus", () => {
  const css = readFileSync(new URL("../public/display.css", import.meta.url), "utf8");
  for (const w of ["touch-action: none", "user-select: none", "-webkit-touch-callout: none", "-webkit-user-drag: none", "overscroll-behavior: none"]) assert.ok(css.includes(w), w);
  const js = readFileSync(new URL("../public/display.js", import.meta.url), "utf8");
  for (const w of ['"contextmenu", "selectstart", "dragstart", "gesturestart"', "e.touches.length > 1", "e.ctrlKey"]) assert.ok(js.includes(w), w);
  assert.ok(DISPLAY_VERSION >= "2.12.0");
});

// ── People under tenants (DP-09 round 14; supabase/26-people.sql) ──
const rest = async (path, { method = "GET", token, body, prefer } = {}) => {
  const r = await fake.handle(new Request(`${SB}/rest/v1/${path}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) } }));
  return { status: r.status, data: r.status === 204 ? null : await r.json().catch(() => null) };
};
/** A second directory in Perimeter Park One (an entrance screen) that also lists Common Bond, and a touch screen for it. */
function entranceFixture() {
  const ppi = fake.T.properties.find((p) => p.name === "Perimeter Park One");
  const did = crypto.randomUUID(), sid = crypto.randomUUID(), tid = crypto.randomUUID();
  fake.T.directories.push({ id: did, property_id: ppi.id, slug: "ppi-entrance-test", title: "Perimeter Park One", subtitle: "", footer_override: null, news_enabled: false, rotate_seconds: 12, weather_enabled: false, map_enabled: false, times_enabled: false, amenities_enabled: false, togo_enabled: true, togo_line: "", togo_code: "PPXTST", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  fake.T.screens.push({ id: sid, directory_id: did, key: "ppi-entrance-test", name: "PPI entrance (test)", location_note: "", orientation: "portrait", hardware: {}, last_seen: null, last_report: {}, sizes: {}, no_cec: false, traffic_at: null, hide_powered_by: false, touch: true, screen_inches: 32, created_at: new Date().toISOString() });
  return { ppi, did, sid, tid, cleanup() {
    fake.T.tenants = fake.T.tenants.filter((t) => t.directory_id !== did);
    fake.T.screens = fake.T.screens.filter((x) => x.id !== sid);
    fake.T.directories = fake.T.directories.filter((x) => x.id !== did);
  } };
}

test("people: every tenant has its building's company, the same name in two directories is one company, and people start hidden", async () => {
  const fxr = entranceFixture();
  const editor = await login("editor@barber.test", "editor-pass");
  try {
    const add = await rest("tenants", { method: "POST", token: editor, prefer: "return=representation", body: { id: fxr.tid, directory_id: fxr.did, sort: 0, name: "  common bond   TITLE, llc ", suite: "130 S" } });
    assert.equal(add.status, 201);
    const floor = fake.T.tenants.find((t) => t.name === "Common Bond Title, LLC");
    assert.ok(floor.company_id && add.data[0].company_id === floor.company_id, "one company for the building, whatever the case and spaces");
    assert.ok(fake.T.tenants.every((t) => t.company_id), "every tenant has a company");
    const other = fake.T.tenants.find((t) => t.name === "Secret Tenant Inc.");
    assert.notEqual(fake.T.companies.find((c) => c.id === other.company_id).property_id, fxr.ppi.id);
    const co = fake.T.companies.find((c) => c.id === floor.company_id);
    assert.deepEqual([co.show_people, co.show_title, co.show_phone, co.show_email], [false, true, false, false], "off until the owner turns it on");
    const sql = readFileSync(new URL("../supabase/26-people.sql", import.meta.url), "utf8");
    assert.ok(sql.includes("show_people  boolean not null default false") && sql.includes("show_title   boolean not null default true")
      && sql.includes("show_phone   boolean not null default false") && sql.includes("show_email   boolean not null default false")
      && sql.includes("show         boolean not null default true"), "the fake's defaults are the SQL's");
  } finally { fxr.cleanup(); }
});

test("people: only a touch screen gets them, only with the owner's switch on, only people ticked Show, only the details shown", async () => {
  const fxr = entranceFixture();
  const owner = await login("leighann@barber.test", "owner-pass");
  try {
    await rest("tenants", { method: "POST", token: owner, body: { id: fxr.tid, directory_id: fxr.did, sort: 0, name: "Common Bond Title, LLC", suite: "130 S" } });
    const cid = fake.T.tenants.find((t) => t.id === fxr.tid).company_id;
    const ins = await rest("people", { method: "POST", token: owner, body: [
      { company_id: cid, sort: 10, first_name: "Bea", last_name: "Zimmer", title: "Closer", phone: "x204", email: "bea@cb.example" },
      { company_id: cid, sort: 20, first_name: "Al", last_name: "Young", title: "Escrow", phone: "205-555-0101", email: "al@cb.example" },
      { company_id: cid, sort: 30, first_name: "Hidden", last_name: "Person", show: false }] });
    assert.equal(ins.status, 201);
    const people = async (key, etag) => { const r = await screen(req(`/api/screen?key=${key}`, { headers: etag ? { "If-None-Match": etag } : {} })); return { r, d: r.status === 200 ? await r.json() : null }; };
    const pick = (d) => d.tenants.find((t) => t.name === "Common Bond Title, LLC").people;
    // switch off: no one, anywhere
    let a = await people("ppi-entrance-test");
    assert.deepEqual(pick(a.d), [], "switch off");
    // switch on
    assert.equal((await rest(`companies?id=eq.${cid}`, { method: "PATCH", token: owner, body: { show_people: true } })).status, 204);
    const b = await people("ppi-entrance-test", a.r.headers.get("ETag"));
    assert.equal(b.r.status, 200, "turning the switch on gives the screen a new version");
    assert.deepEqual(pick(b.d), [
      { first: "Bea", last: "Zimmer", title: "Closer", phone: "", email: "", suite: "" },
      { first: "Al", last: "Young", title: "Escrow", phone: "", email: "", suite: "" }], "ticked Show, in order, title only");
    // the display-only directional listing the same company never gets them
    assert.deepEqual(pick((await people("ppi-1s")).d), [], "display-only screen");
    // details: the owner's choice
    await rest(`companies?id=eq.${cid}`, { method: "PATCH", token: owner, body: { show_title: false, show_email: true } });
    const c = await people("ppi-entrance-test", b.r.headers.get("ETag"));
    assert.equal(c.r.status, 200);
    assert.deepEqual(pick(c.d)[0], { first: "Bea", last: "Zimmer", title: "", phone: "", email: "bea@cb.example", suite: "" });
    // a person's edit reaches every screen listing the company: both directories change
    const before = fake.T.directories.filter((x) => ["ppi-entrance-test", "ppi-1s"].includes(x.slug)).map((x) => x.updated_at);
    await new Promise((res) => setTimeout(res, 5));
    const al = fake.T.people.find((x) => x.first_name === "Al");
    await rest(`people?id=eq.${al.id}`, { method: "PATCH", token: owner, body: { show: false } });
    const after = fake.T.directories.filter((x) => ["ppi-entrance-test", "ppi-1s"].includes(x.slug)).map((x) => x.updated_at);
    assert.ok(after.every((t, i) => t > before[i]), "both directories marked changed");
    const e = await people("ppi-entrance-test", c.r.headers.get("ETag"));
    assert.equal(e.r.status, 200); assert.deepEqual(pick(e.d).map((x) => x.first), ["Bea"]);
    // never on the Directory to Go phone page
    const page = await (await togo(req("/d/PPXTST"))).text();
    assert.ok(page.includes("Common Bond") && !page.includes("Zimmer") && !page.includes("bea@cb.example"), "the phone page lists the company, never its people");
    const sql = readFileSync(new URL("../supabase/26-people.sql", import.meta.url), "utf8");
    assert.ok(sql.includes("case when not s.touch then '[]'::jsonb") && sql.includes("co.show_people and pe.show")
      && sql.includes("case when co.show_email then pe.email else '' end"), "the SQL has the same rules");
  } finally { fake.T.people = []; fake.T.companies.forEach((c) => Object.assign(c, { show_people: false, show_title: true, show_phone: false, show_email: false })); fxr.cleanup(); }
});

test("people: the owner's users and 1Point edit them; strangers see nothing; companies come only from the tenant list", async () => {
  const editor = await login("editor@barber.test", "editor-pass");
  const admin = await login("scot@1pointusa.com", "admin-pass");
  const other = fake.T.organizations.find((o) => o.name === "Other Owner LLC").id;
  if (!fake.T.profiles.some((p) => p.email === "stray@other.test")) fake.addUser("stray@other.test", "stray-pass", "org_admin", other, "Stray");
  const stray = await login("stray@other.test", "stray-pass");
  const t = fake.T.tenants.find((x) => x.name === "Common Bond Title, LLC");
  try {
    assert.equal((await rest("people", { method: "POST", token: editor, body: { company_id: t.company_id, first_name: "Front", last_name: "Desk" } })).status, 201, "an owner's editor adds a person");
    assert.equal((await rest("people", { method: "POST", token: editor, body: { company_id: t.company_id, first_name: " ", last_name: "" } })).status, 409, "a blank person is refused");
    assert.equal((await rest("people", { method: "POST", token: editor, body: { company_id: t.company_id, first_name: "X", suite: "12345678901234567" } })).status, 409, "a 17-character suite is refused");
    assert.equal((await rest(`companies?id=eq.${t.company_id}`, { method: "PATCH", token: admin, body: { show_people: true } })).status, 204, "1Point keeps control");
    assert.equal((await rest(`companies?id=eq.${t.company_id}`, { method: "PATCH", token: editor, body: { name: "Renamed by hand" } })).status, 400, "no renaming a company by hand");
    assert.equal((await rest("companies", { method: "POST", token: editor, body: { property_id: fake.T.properties[0].id, name: "Made by hand" } })).status, 403, "no making one by hand");
    const others = fake.T.companies.find((c) => c.property_id !== fake.T.properties.find((p) => p.name === "Perimeter Park One").id && companyOrgName(c) === "Other Owner LLC");
    await rest(`tenants?id=eq.${t.id}`, { method: "PATCH", token: editor, body: { company_id: others.id } });
    assert.notEqual(fake.T.tenants.find((x) => x.id === t.id).company_id, others.id, "a tenant's company comes from its name, not the editor");
    assert.deepEqual((await rest("people?select=*", { token: stray })).data, [], "a stranger sees no people");
    assert.deepEqual((await rest("companies?select=*", { token: stray })).data.filter((c) => c.id === t.company_id), [], "nor Barber's companies");
    assert.equal((await rest("people", { method: "POST", token: stray, body: { company_id: t.company_id, first_name: "Intruder" } })).status, 403);
    await rest(`companies?id=eq.${t.company_id}`, { method: "PATCH", token: stray, body: { show_people: false } });
    assert.equal(fake.T.companies.find((c) => c.id === t.company_id).show_people, true, "a stranger's change does nothing");
    assert.ok(readFileSync(new URL("../supabase/26-people.sql", import.meta.url), "utf8").includes("revoke insert on public.companies from authenticated"));
  } finally { fake.T.people = []; fake.T.companies.forEach((c) => (c.show_people = false)); }
  function companyOrgName(c) { const p = fake.T.properties.find((x) => x.id === c.property_id); return fake.T.organizations.find((o) => o.id === p.org_id)?.name; }
});

test("people: fixing a tenant's name keeps its people; a renamed tenant still listed elsewhere starts a new company", async () => {
  const fxr = entranceFixture();
  const owner = await login("leighann@barber.test", "owner-pass");
  try {
    await rest("tenants", { method: "POST", token: owner, body: { id: fxr.tid, directory_id: fxr.did, sort: 0, name: "Brand New Tenant Co", suite: "400" } });
    const cid = fake.T.tenants.find((t) => t.id === fxr.tid).company_id;
    await rest("people", { method: "POST", token: owner, body: { company_id: cid, first_name: "Kay", last_name: "Lee" } });
    // the editor saves by upsert: a typo fix on the only listing renames the company, people and all
    await rest("tenants", { method: "POST", token: owner, prefer: "resolution=merge-duplicates", body: [{ id: fxr.tid, directory_id: fxr.did, sort: 0, name: "Brand New Tenant Company", suite: "400" }] });
    const t = fake.T.tenants.find((x) => x.id === fxr.tid);
    assert.equal(t.company_id, cid); assert.equal(fake.T.companies.find((c) => c.id === cid).name, "Brand New Tenant Company");
    assert.equal(fake.T.people.filter((x) => x.company_id === cid).length, 1);
    // renaming a tenant that another directory still lists leaves the people with the company the other one lists
    const floor = fake.T.tenants.find((x) => x.name === "Common Bond Title, LLC");
    const shared = floor.company_id;
    await rest("tenants", { method: "POST", token: owner, body: { id: crypto.randomUUID(), directory_id: fxr.did, sort: 10, name: "Common Bond Title, LLC", suite: "130 S" } });
    await rest("people", { method: "POST", token: owner, body: { company_id: shared, first_name: "Stays", last_name: "Put" } });
    await rest(`tenants?id=eq.${floor.id}`, { method: "PATCH", token: owner, body: { name: "Common Bond Title Group" } });
    assert.notEqual(fake.T.tenants.find((x) => x.id === floor.id).company_id, shared);
    assert.equal(fake.T.people.filter((x) => x.company_id === shared).length, 1, "the people stay with the company still listed");
  } finally {
    const floor = fake.T.tenants.find((x) => x.name === "Common Bond Title Group"); if (floor) floor.name = "Common Bond Title, LLC";
    fake.T.people = []; fxr.cleanup();
    for (const t of fake.T.tenants) { const c = fake.T.companies.find((x) => x.id === t.company_id); if (c && c.name.toLowerCase() !== t.name.toLowerCase().trim()) Object.assign(t, { company_id: fake.T.companies.find((x) => x.property_id === c.property_id && x.name.toLowerCase() === t.name.toLowerCase())?.id ?? t.company_id }); }
  }
});

test("people: tidied and capped for the screen; the editor saves them after the tenants and never sets a tenant's company", () => {
  const list = cleanPeople([{ first: "  Ann ", last: "Bee", title: "x".repeat(200), phone: "1", email: "a@b", suite: "9".repeat(30), extra: "no" }, { first: "", last: " " }, null]);
  assert.deepEqual(list, [{ first: "Ann", last: "Bee", title: "x".repeat(80), phone: "1", email: "a@b", suite: "9".repeat(16) }]);
  assert.equal(cleanPeople(Array.from({ length: 300 }, (_, i) => ({ first: `P${i}` }))).length, 200);
  assert.deepEqual(cleanPeople(undefined), []);
  const ed = readFileSync(new URL("../public/edit.js", import.meta.url), "utf8");
  assert.ok(ed.indexOf("await savePeople(d.id)") > ed.indexOf('Auth.db("tenants", { method: "POST"'), "people after tenants");
  assert.ok(!/directory_id: d\.id, sort: i \* 10, name: t\.name[^)]*company_id/.test(ed), "the tenant rows sent carry no company");
  assert.ok(ed.includes("companies?property_id=eq.") && ed.includes('Auth.db("people"') && ed.includes("S.peopleOff = true"), "reads by building; works without 26 run");
});

test("a new directory gets its Directory to Go code from a trigger, not a default the signed-in user would have to run (27)", () => {
  const sql = readFileSync(new URL("../supabase/27-new-directory.sql", import.meta.url), "utf8");
  assert.ok(sql.includes("alter column togo_code drop default"), "no default left");
  assert.ok(/function public\.directories_togo_new\(\)[\s\S]*security definer/.test(sql), "the trigger runs with the database's rights");
  assert.ok(sql.includes("before insert on public.directories"), "on every new directory");
  assert.ok(sql.includes("revoke all on function public.directories_togo_new() from public, anon, authenticated"), "and stays private");
  const check = readFileSync(new URL("../supabase/check-new-directory.sql", import.meta.url), "utf8");
  assert.ok(check.includes("perform set_config('role', 'authenticated', true)"), "the check adds rows as a signed-in user, as the console does");
});

test("the touch directory's settings: idle time per screen (15–300, 45), the keyboard per directory, both reach the screen", async () => {
  const scr = fake.T.screens.find((x) => x.key === "ppi-1s");
  const dir = fake.T.directories.find((x) => x.id === scr.directory_id);
  const first = await screen(req("/api/screen?key=ppi-1s"));
  const d0 = await first.json();
  assert.equal(d0.touchIdle, 45); assert.equal(d0.keyboard, false);
  try {
    Object.assign(scr, { touch: true, touch_idle_s: 90 }); dir.touch_keyboard = true; dir.updated_at = new Date(Date.now() + 1000).toISOString();
    const next = await screen(req("/api/screen?key=ppi-1s", { headers: { "If-None-Match": first.headers.get("ETag") } }));
    assert.equal(next.status, 200);
    const d1 = await next.json();
    assert.equal(d1.touchIdle, 90); assert.equal(d1.keyboard, true); assert.equal(d1.touch, true);
    // only 1Point sets the idle time; the owner's users set the keyboard in the editor
    const admin = await login("scot@1pointusa.com", "admin-pass"), owner = await login("leighann@barber.test", "owner-pass");
    const r1 = await fake.handle(new Request(`${SB}/rest/v1/screens?id=eq.${scr.id}`, { method: "PATCH", headers: { apikey: ANON_KEY, Authorization: `Bearer ${owner}`, "Content-Type": "application/json" }, body: JSON.stringify({ touch_idle_s: 20 }) }));
    assert.notEqual(r1.status, 204, "an owner can't change Screen settings");
    const r2 = await fake.handle(new Request(`${SB}/rest/v1/screens?id=eq.${scr.id}`, { method: "PATCH", headers: { apikey: ANON_KEY, Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, body: JSON.stringify({ touch_idle_s: 14 }) }));
    assert.equal(r2.status, 409, "14 seconds is refused");
  } finally { Object.assign(scr, { touch: false, touch_idle_s: 45 }); dir.touch_keyboard = false; }
  assert.deepEqual([toPayload({ key: "k", touch_idle_s: 5 }, {}, {}, []).touchIdle, toPayload({ key: "k", touch_idle_s: 999 }, {}, {}, []).touchIdle, toPayload({ key: "k" }, null, null, []).touchIdle], [15, 300, 45]);
  const sql = readFileSync(new URL("../supabase/28-touch-directory.sql", import.meta.url), "utf8");
  assert.ok(sql.includes("touch_idle_s between 15 and 300") && sql.includes("default 45") && sql.includes("touch_keyboard boolean not null default false")
    && sql.includes("'touch_idle_s', s.touch_idle_s") && sql.includes("s.touch_idle_s::text") && sql.includes("'people', case when not s.touch"), "28 keeps round 14's people and adds the idle time");
  const con = readFileSync(new URL("../public/console.js", import.meta.url), "utf8");
  assert.ok(con.includes(",touch_idle_s\"") && con.includes('id="s-idle"') && con.includes("from 15 to 300"), "Screen settings has the idle time");
  const ed = readFileSync(new URL("../public/edit.js", import.meta.url), "utf8");
  assert.ok(ed.includes("touch_keyboard: !!d.touch_keyboard") && ed.includes('$("kbd-on")'), "the editor saves the keyboard switch");
});

test("the touch directory is only on touch screens: cards, A to Z, the keyboard (company names only) and the idle return", () => {
  const js = readFileSync(new URL("../public/display.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  for (const id of ['id="touchbar"', 'id="kbd-btn"', 'id="az"', 'id="card"', 'id="kbd"']) assert.ok(html.includes(id), id);
  assert.ok(js.includes("if (data?.touch) return fitTouch(u);") && js.includes('if (!data?.touch) return;'), "display-only screens keep the old fit and ignore taps");
  assert.ok(js.includes("(data.tenants || [])[Number(r.dataset.i)]") && !/people[^\n]*includes\(q/.test(js), "the keyboard searches company names, never people");
  assert.ok(js.includes("Number(data.touchIdle) || 45") && js.includes("goIdle"), "back to the directory after the idle time");
  assert.equal(DISPLAY_VERSION, "2.14.0");
  assert.ok(js.includes("new ResizeObserver") && js.includes("frameSize() !== fittedAt"), "the list refits when its space changes size (15b)");
});

test("the touch keyboard (round 16): keys about 12 mm in a compact block, matches always with room, Show, drag to scroll", () => {
  const js = readFileSync(new URL("../public/display.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/display.css", import.meta.url), "utf8");
  assert.ok(js.includes('data-key="enter">Show</button>') && js.includes('if (k === "enter")'), "an Enter key labelled Show");
  assert.ok(js.includes("if (hits.length === 1) { openCard(hits[0].t); return; }"), "Show with one match opens its card");
  assert.ok(/\.keys-away \.kbd-keys \{ display: none; \}/.test(css) && js.includes("data-kfield"), "Show puts the keys away; the field brings them back");
  assert.ok(css.includes("--key: clamp(calc(var(--u) * 4), calc(var(--finger, 60px) * 0.8), calc(var(--u) * 7))"), "keys about 12 mm, capped");
  assert.ok(css.includes(".kbd-results { list-style: none; flex: 1 1 auto; min-height: calc(var(--key) * 3);"), "the matches always keep room for three");
  assert.ok(js.includes('e.pointerType === "touch"') && js.includes("#stage.scrolling .list-frame, .card-people, .kbd-results"),
    "a finger that reaches the page as a mouse drags the lists; real touch scrolls natively");
  assert.ok(!/people[^\n]*includes\(q/.test(js), "still company names only");
});

test("drive times' status reaches the Pi panel, never Google's minutes or labels (15c)", async () => {
  const scr = fake.T.screens.find((x) => x.key === "ppi-1s");
  const keep = { last_seen: scr.last_seen, last_report: scr.last_report };
  try {
    scr.last_seen = null;
    const sent = JSON.stringify({ s: "ok", n: 3, of: 3, at: "2026-10-26T23:15:00Z", shown: true, times: [{ label: "Birmingham Airport", minutes: 16 }], label: "BJCC", minutes: 17 });
    const r = await screen(req("/api/screen?key=ppi-1s", { headers: { "X-Screen-Size": "1920x1080", "X-Display-Version": DISPLAY_VERSION, "X-Traffic": sent } }));
    assert.equal(r.status, 200);
    assert.deepEqual(scr.last_report.traffic, { s: "ok", n: 3, of: 3, at: "2026-10-26T23:15:00.000Z", shown: true });
    assert.ok(!JSON.stringify(scr.last_report).includes("Airport") && !JSON.stringify(scr.last_report).includes("16"), "nothing Google returned is kept");
  } finally { Object.assign(scr, keep); }
  const { trafficStatus } = await import("../netlify/functions/screen.mjs");
  assert.deepEqual(trafficStatus('{"s":"off","why":"hours"}'), { s: "off", why: "hours", shown: false });
  assert.deepEqual(trafficStatus('{"s":"off","why":"<script>"}'), { s: "off", why: "switched off", shown: false }, "unknown reasons become plain ones");
  assert.equal(trafficStatus('{"s":"error","why":"<b>x</b> quota"}').why, "bx/b quota");
  assert.equal(trafficStatus("not json"), null); assert.equal(trafficStatus('{"s":"dance"}'), null);
  assert.equal(trafficStatus('{"s":"ok","n":99,"of":-4}').n, 3);
  const js = readFileSync(new URL("../public/display.js", import.meta.url), "utf8");
  assert.ok(js.includes('headers["X-Traffic"]') && js.includes("traffic.status = null; return;"), "screens without drive times report nothing");
  const dev = readFileSync(new URL("../public/console-devices.js", import.meta.url), "utf8");
  assert.ok(dev.includes('row("Drive times", trafficLine(s))') && dev.includes("weekdays from 6 a.m. to 7 p.m."), "the Pi panel says what the screen reported");
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} passed`);
