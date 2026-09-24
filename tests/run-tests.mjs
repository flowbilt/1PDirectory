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
  const d = fake.T.directories.find((x) => x.slug === "ppi-2s");
  fake.T.tenants.find((t) => t.directory_id === d.id).name = "Evan Terry Associates, LLC (edited)";
  assert.equal((await screen(req("/api/screen?key=ppi-2s", { headers: { "If-None-Match": etag } }))).status, 200);
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
