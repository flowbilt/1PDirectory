// Run with: npm test
// Exercises every function against an in-memory blob store and fixture feeds (no network needed).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { _reset } from "./blobs-stub.mjs";
import directory from "../netlify/functions/directory.mjs";
import sites from "../netlify/functions/sites.mjs";
import heartbeat from "../netlify/functions/heartbeat.mjs";
import weather, { iconFor } from "../netlify/functions/weather.mjs";
import news from "../netlify/functions/news.mjs";
import { parseFeed, isBlocked } from "../netlify/lib/rss.mjs";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const BASE = "https://example.test";
const req = (path, { method = "GET", body, pw } = {}) =>
  new Request(BASE + path, { method, body: body ? JSON.stringify(body) : undefined, headers: pw ? { "x-admin-password": pw } : {} });

// Fake the outside world for weather and news.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (body, type = "application/json") => new Response(body, { status: 200, headers: { "Content-Type": type } });
  if (u.startsWith("https://api.weather.gov/points/")) return ok(fx("nws-points.json"));
  if (u.includes("/forecast/hourly")) return ok(fx("nws-hourly.json"));
  if (u.includes("bbci")) return ok(fx("bbc.xml"), "application/xml");
  if (u.includes("npr")) return ok(fx("npr.xml"), "application/xml");
  if (u.includes("broken")) return new Response("nope", { status: 500 });
  return realFetch(url);
};

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

process.env.ADMIN_PASSWORD = "correct horse";

test("GET returns Landmark Center seed before anything is saved", async () => {
  const r = await directory(req("/api/directory?site=landmark-center"));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.propertyName, "The Landmark Center");
  assert.equal(d.tenants.length, 8);
  assert.equal(d.tenants.find((t) => t.name === "PRP Logistics").suite, "410");
  assert.equal(d.managedBy.phone, "205-995-9116");
  assert.equal(d.leasedBy.name, "Weyman Prater");
  assert.match(d.logo, /^data:image\/svg\+xml;base64,/);
  assert.equal(d.logoReplacesName, true);
});

test("GET with no site param uses the default site", async () => {
  const r = await directory(req("/api/directory"));
  assert.equal((await r.json()).site, "landmark-center");
});

test("GET unknown site is 404, bad key is 400", async () => {
  assert.equal((await directory(req("/api/directory?site=nope"))).status, 404);
  assert.equal((await directory(req("/api/directory?site=../etc"))).status, 400);
});

test("PUT without or with wrong password is refused", async () => {
  assert.equal((await directory(req("/api/directory?site=landmark-center", { method: "PUT", body: {} }))).status, 401);
  assert.equal((await directory(req("/api/directory?site=landmark-center", { method: "PUT", body: {}, pw: "nope" }))).status, 401);
});

test("PUT fails cleanly when ADMIN_PASSWORD is missing", async () => {
  const saved = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  const r = await directory(req("/api/directory?site=landmark-center", { method: "PUT", body: {}, pw: "x" }));
  process.env.ADMIN_PASSWORD = saved;
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /ADMIN_PASSWORD/);
});

test("PUT saves, cleans input, and GET returns the saved copy", async () => {
  const seed = await (await directory(req("/api/directory?site=landmark-center"))).json();
  const body = {
    ...seed,
    tenants: [...seed.tenants, { name: "  New Tenant LLC  ", suite: "600", dir: "sideways" }, { name: "", suite: "999" }],
    evil: "<script>",
  };
  const r = await directory(req("/api/directory?site=landmark-center", { method: "PUT", body, pw: "correct horse" }));
  assert.equal(r.status, 200);
  const saved = await r.json();
  assert.ok(saved.updatedAt);
  assert.equal(saved.evil, undefined);
  assert.equal(saved.tenants.length, 9, "blank tenant dropped");
  assert.deepEqual(saved.tenants.at(-1), { name: "New Tenant LLC", suite: "600", dir: "" }, "trimmed, bad arrow cleared");
  const again = await (await directory(req("/api/directory?site=landmark-center"))).json();
  assert.equal(again.tenants.length, 9);
});

test("PUT rejects missing property name, bad logo, bad time zone", async () => {
  const base = { propertyName: "X", tenants: [] };
  const put = (b) => directory(req("/api/directory?site=t1", { method: "PUT", body: b, pw: "correct horse" }));
  assert.equal((await put({ ...base, propertyName: "  " })).status, 400);
  assert.equal((await put({ ...base, logo: "javascript:alert(1)" })).status, 400);
  assert.equal((await put({ ...base, timezone: "Mars/Olympus" })).status, 400);
  assert.equal((await put({ ...base, tenants: "nope" })).status, 400);
  assert.equal((await put({ ...base, logo: "data:image/png;base64,iVBORw0KGgo=" })).status, 200);
  const withLogo = await (await put({ ...base, logo: "data:image/png;base64,iVBORw0KGgo=", logoReplacesName: true })).json();
  assert.equal(withLogo.logoReplacesName, true);
  const noLogo = await (await put({ ...base, logoReplacesName: true })).json();
  assert.equal(noLogo.logoReplacesName, false, "setting ignored without a logo");
});

test("new building can be created and listed with its check-in time", async () => {
  await directory(req("/api/directory?site=riverchase-tower", { method: "PUT", body: { propertyName: "Riverchase Tower", tenants: [] }, pw: "correct horse" }));
  await heartbeat(new Request(BASE + "/api/heartbeat", { method: "POST", body: JSON.stringify({ site: "riverchase-tower", screen: { w: 1080, h: 1920 }, version: "1.0.0" }) }));
  const r = await sites(req("/api/sites", { pw: "correct horse" }));
  assert.equal(r.status, 200);
  const list = (await r.json()).sites;
  const rt = list.find((s) => s.site === "riverchase-tower");
  assert.ok(rt && rt.lastSeen, "check-in recorded");
  assert.deepEqual(rt.screen, { w: 1080, h: 1920 });
  assert.ok(list.find((s) => s.site === "landmark-center"), "seed site listed");
  assert.equal((await sites(req("/api/sites"))).status, 401);
});

test("heartbeat rejects bad site keys", async () => {
  const r = await heartbeat(new Request(BASE + "/api/heartbeat", { method: "POST", body: JSON.stringify({ site: "Bad Key!" }) }));
  assert.equal(r.status, 400);
});

test("DELETE removes a saved building", async () => {
  const r = await directory(req("/api/directory?site=riverchase-tower", { method: "DELETE", pw: "correct horse" }));
  assert.equal(r.status, 200);
  assert.equal((await directory(req("/api/directory?site=riverchase-tower"))).status, 404);
});

test("weather maps the NWS hourly forecast and sets CDN caching", async () => {
  const r = await weather(req("/api/weather?lat=33.5186&lon=-86.8104"));
  assert.equal(r.status, 200);
  const w = await r.json();
  assert.equal(w.tempF, 78);
  assert.equal(w.text, "Mostly Cloudy");
  assert.equal(w.icon, "cloud");
  assert.match(r.headers.get("Netlify-CDN-Cache-Control"), /s-maxage=600/);
  assert.equal((await weather(req("/api/weather"))).status, 400);
});

test("weather icons cover the common NWS wordings", () => {
  assert.equal(iconFor("Chance Showers And Thunderstorms"), "storm");
  assert.equal(iconFor("Partly Sunny", true), "partly-day");
  assert.equal(iconFor("Mostly Clear", false), "partly-night");
  assert.equal(iconFor("Sunny", true), "clear-day");
  assert.equal(iconFor("Clear", false), "clear-night");
  assert.equal(iconFor("Areas Of Fog"), "fog");
  assert.equal(iconFor("Light Rain Likely"), "rain");
  assert.equal(iconFor("Rain And Snow"), "snow");
});

test("RSS parser reads BBC thumbnails (upsized) and NPR inline images", () => {
  const bbc = parseFeed(fx("bbc.xml"));
  assert.equal(bbc[0].source, "BBC News");
  assert.equal(parseFeed(fx("npr.xml"))[0].source, "NPR");
  assert.equal(bbc[0].image, "https://ichef.bbci.co.uk/ace/standard/976/cpsprodpb/abc/live/berries.jpg");
  assert.equal(bbc[2].image, "");
  const npr = parseFeed(fx("npr.xml"));
  assert.equal(npr[0].title, "NASA\u2019s new moon rover passes final road test");
  assert.match(npr[0].image, /^https:\/\/media\.npr\.org\/.*rover_wide\.jpg/);
  assert.equal(npr[0].published, "2026-09-23T13:15:00.000Z");
});

test("blocklist matches whole words only", () => {
  assert.equal(isBlocked("Three killed in crash", ["killed"]), true);
  assert.equal(isBlocked("Warm weather lingers", ["war"]), false);
  assert.equal(isBlocked("Screenshot tool update", ["shot"]), false);
});

test("news merges feeds, drops blocked and duplicate stories, survives a dead feed", async () => {
  process.env.NEWS_FEEDS = "https://feeds.bbci.co.uk/x.xml, https://feeds.npr.org/1001/rss.xml, https://broken.example/rss";
  const r = await news(req("/api/news"));
  delete process.env.NEWS_FEEDS;
  assert.equal(r.status, 200);
  const { items, errors } = await r.json();
  const titles = items.map((i) => i.title);
  assert.ok(!titles.some((t) => /killed/i.test(t)), "blocked story removed");
  assert.equal(titles.filter((t) => /blueberry/.test(t)).length, 1, "duplicate removed");
  assert.ok(titles.includes("Warm weather expected to linger into October"));
  assert.ok(items[0].image && items[1].image, "stories with pictures first");
  assert.equal(errors.length, 1, "dead feed reported, not fatal");
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} passed`);
_reset();
