// Browser checks (DP-11, round E1a; before this they were run ad hoc in each chat). Starts the local test server
// (tests/test-server.mjs, with the fake Supabase), drives Chromium with Playwright, and ends with "N/N passed".
//
//   node tests/browser-checks.mjs                       # the layout page, the console's Layouts tab, Orientation
//   node tests/browser-checks.mjs --compare <public>    # also: directory screens drawn exactly as by another copy of
//                                                       # public/ (e.g. the previous chat's), element by element
// Needs Playwright with Chromium (require("playwright")); about a minute.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PORT = 8931, OLD_PORT = 8932, B = `http://localhost:${PORT}`;
const compareDir = process.argv.includes("--compare") ? process.argv[process.argv.indexOf("--compare") + 1] : null;
const DOC = JSON.parse(readFileSync(new URL("../layouts/donut-joes-pelham.json", import.meta.url), "utf8"));

let pass = 0, total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${String(e.message || e).split("\n").slice(0, 4).join("\n       ")}`); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg || "assertion failed"); };
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

function server(port, env = {}) {
  const p = spawn(process.execPath, [`${HERE}test-server.mjs`, String(port)], { env: { ...process.env, ...env }, stdio: "ignore" });
  return p;
}
async function waitUp(base) { for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/config`)).ok) return; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 100)); } throw new Error(`server ${base} didn't start`); }

// The fake Supabase through the test server, with the service key (setting things up as the site would)
const SVC = { apikey: "test-service-key", "Content-Type": "application/json", Prefer: "return=representation" };
const sb = async (path, opts = {}) => { const r = await fetch(`${B}/sb/rest/v1/${path}`, { headers: SVC, ...opts }); const t = await r.text(); return { status: r.status, data: t ? JSON.parse(t) : null }; };

async function signIn(page, email, password) {
  await page.goto(`${B}/login.html`);
  await page.fill("#email", email); await page.fill("#password", password);
  await page.click("#signin button[type=submit]");
  await page.waitForURL(/console/); await page.waitForTimeout(1200);
}

const srv = server(PORT);
const old = compareDir ? server(OLD_PORT, { PUBLIC_DIR: compareDir }) : null;
const browser = await chromium.launch();
try {
  await waitUp(B); if (old) await waitUp(`http://localhost:${OLD_PORT}`);
  const props = (await sb("properties?select=id,name,org_id")).data;
  const screens = (await sb("screens?select=id,key,orientation,directory_id")).data;
  const portrait = screens.find((s) => s.orientation === "portrait");
  const landscape = screens.find((s) => s.orientation === "landscape");
  const home = props.find((p) => p.org_id === (props.find((x) => /Landmark/.test(x.name)) || props[0]).org_id);
  const otherOrg = props.find((p) => p.org_id !== home.org_id);

  // Directory screens first, before anything changes (the comparison wants untouched screens)
  if (old) {
    const pick = [portrait, landscape, screens.filter((s) => s.orientation === "landscape")[1] || landscape].filter(Boolean);
    for (const s of pick) for (const [w, h] of [[1080, 1920], [1920, 1080]]) {
      await check(`directory screen ${s.key} (${w}x${h}) drawn exactly as before`, async () => {
        const boxes = async (base) => {
          const p = await browser.newPage({ viewport: { width: w / 2, height: h / 2 }, deviceScaleFactor: 1 });
          await p.goto(`${base}/?screen=${s.key}&view=1`); await p.waitForTimeout(2500);
          const r = await p.evaluate(() => [...document.querySelectorAll("#stage > *, #stage .tenant, #property, #time, #date, #weather, .contact")]
            .filter((e) => !e.hidden && e.offsetParent !== null).map((e) => { const b = e.getBoundingClientRect(); return `${e.id || e.className}:${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`; }));
          await p.close(); return r;
        };
        const [a, b] = [await boxes(`http://localhost:${OLD_PORT}`), await boxes(B)];
        const differ = a.filter((x, i) => x !== b[i] && !/^(time|date)/.test(x));
        assert(a.length === b.length && differ.length === 0, `${a.length} vs ${b.length} elements; first differences: ${differ.slice(0, 3).join(" | ")}`);
      });
    }
  }

  await check("a directory screen stays on the directory page and draws its tenants", async () => {
    const p = await browser.newPage({ viewport: { width: 540, height: 960 } });
    await p.goto(`${B}/?screen=${portrait.key}&view=1`); await p.waitForTimeout(2000);
    assert(new URL(p.url()).pathname === "/", p.url());
    assert(await p.locator(".tenant").count() > 0, "no tenants");
    await p.close();
  });

  // A layout in the home account, published, as the site would
  const [lay] = (await sb("layouts", { method: "POST", body: JSON.stringify({ org_id: home.org_id, name: "Donut Joe's Pelham", family: "menu", orientation: "portrait" }) })).data;
  const [wide] = (await sb("layouts", { method: "POST", body: JSON.stringify({ org_id: home.org_id, name: "Wide test", family: "board", orientation: "landscape" }) })).data;
  await sb("rpc/layout_publish", { method: "POST", body: JSON.stringify({ p_layout: lay.id, p_doc: DOC, p_checks: {}, p_overridden: false, p_note: "", p_by: null }) });
  await sb(`screens?id=eq.${portrait.id}`, { method: "PATCH", body: JSON.stringify({ directory_id: null, layout_id: lay.id, property_id: home.id }) });

  await check("a layout screen's address hands over to the layout page, keeping its options", async () => {
    const p = await browser.newPage({ viewport: { width: 540, height: 960 } });
    await p.goto(`${B}/?screen=${portrait.key}&view=1`); await p.waitForTimeout(2500);
    const u = new URL(p.url());
    assert(u.pathname === "/board.html" && u.searchParams.get("screen") === portrait.key && u.searchParams.get("view") === "1", p.url());
    assert(await p.locator(".b").count() === DOC.blocks.length, `${await p.locator(".b").count()} blocks`);
    await p.close();
  });

  await check("blocks sit on the grid, the canvas scaled to the screen, the layout's fonts loaded", async () => {
    const p = await browser.newPage({ viewport: { width: 540, height: 960 } });
    await p.goto(`${B}/board.html?screen=${portrait.key}&view=1`); await p.waitForTimeout(2500);
    const r = await p.evaluate(() => {
      const hero = document.querySelector('[data-id="hero"]').getBoundingClientRect();
      return { hero: [hero.x, hero.y, hero.width, hero.height], fraunces: document.fonts.check('800 40px "Fraunces"'), font: getComputedStyle(document.querySelector('[data-id="logo"] .b-logo')).fontFamily };
    });
    // 12 x 24 grid, gap 16, margin 40 on 1080 x 1920, at half size: the hero (col 1, row 4, 12 x 7)
    const cw = (1080 - 80 - 11 * 16) / 12, ch = (1920 - 80 - 23 * 16) / 24;
    near(r.hero[0], 20, 1, "hero left"); near(r.hero[1], (40 + 3 * (ch + 16)) / 2, 1, "hero top");
    near(r.hero[2], (12 * cw + 11 * 16) / 2, 1, "hero width"); near(r.hero[3], (7 * ch + 6 * 16) / 2, 1, "hero height");
    assert(r.fraunces && /Fraunces/.test(r.font), `font ${r.font}`);
    await p.close();
  });

  await check("the layout's text fits its boxes (nothing overflows on Donut Joe's)", async () => {
    const p = await browser.newPage({ viewport: { width: 540, height: 960 } });
    await p.goto(`${B}/board.html?screen=${portrait.key}&view=1`); await p.waitForTimeout(2500);
    const rep = await p.evaluate(() => window.LayoutBoard.fitAll());
    assert(rep.overflow.length === 0, JSON.stringify(rep));
    await p.close();
  });

  // Schedules, hours and dates: the preview mode (no site clock), with the page's clock set
  const payload = (doc, extra = {}) => ({ kind: "layout", key: "preview", screenName: "Preview", orientation: doc.orientation, layout: { id: null, name: "x", version: null, doc }, timezone: "America/Chicago", weather: { enabled: false }, poweredBy: true, display: "x", assigned: true, ...extra });
  async function previewAt(iso, doc = DOC, viewport = { width: 540, height: 960 }) {
    const p = await browser.newPage({ viewport });
    await p.clock.install({ time: new Date(iso) });
    await p.goto(`${B}/board.html?preview=1`); await p.waitForTimeout(300);
    await p.evaluate((d) => window.postMessage({ type: "layout-draft", data: d }, location.origin), payload(doc));
    await p.clock.runFor(2500);
    return p;
  }
  const shown = (p, id) => p.evaluate((i) => !document.querySelector(`[data-id="${i}"]`).hidden, id);

  await check("schedules: the morning footer 6 to 11 a.m. building time, the other one after, by the building's clock", async () => {
    let p = await previewAt("2026-10-28T13:30:00Z");   // Wednesday 8:30 a.m. in Chicago
    assert(await shown(p, "foot-morning") && !(await shown(p, "foot")), "8:30 a.m.");
    await p.close();
    p = await previewAt("2026-10-28T17:30:00Z");       // 12:30 p.m.
    assert(!(await shown(p, "foot-morning")) && await shown(p, "foot"), "12:30 p.m.");
    await p.close();
  });

  await check("a block switches by itself when its time comes (11:00)", async () => {
    const p = await previewAt("2026-10-28T15:59:30Z");   // 10:59:30 a.m.
    assert(await shown(p, "foot-morning"), "before 11");
    await p.clock.runFor(45000);
    assert(!(await shown(p, "foot-morning")) && await shown(p, "foot"), "after 11");
    await p.close();
  });

  await check("date ranges: the fall box through November 30, gone December 1", async () => {
    let p = await previewAt("2026-11-30T18:00:00Z"); assert(await shown(p, "fall"), "Nov 30"); await p.close();
    p = await previewAt("2026-12-01T18:00:00Z"); assert(!(await shown(p, "fall")), "Dec 1"); await p.close();
  });

  await check("hours: open now on a Wednesday morning, and when it opens next on a Monday", async () => {
    let p = await previewAt("2026-10-28T13:30:00Z");
    assert((await p.textContent('[data-live="hours"]')) === "Open now · until 6 PM", await p.textContent('[data-live="hours"]')); await p.close();
    p = await previewAt("2026-10-26T15:00:00Z");   // Monday
    assert((await p.textContent('[data-live="hours"]')) === "Closed now · opens tomorrow at 6 AM", await p.textContent('[data-live="hours"]')); await p.close();
  });

  await check("a box with too much text is reported as overflowing and marked in the preview", async () => {
    const doc = JSON.parse(JSON.stringify(DOC));
    doc.blocks.find((b) => b.id === "more").content.items.push(...Array.from({ length: 14 }, (_, i) => ({ name: `Extra item ${i + 1}`, price: "$1.00" })));
    const p = await previewAt("2026-10-28T13:30:00Z", doc);
    const r = await p.evaluate(() => window.LayoutBoard.fitAll());
    assert(r.overflow.includes("more") && await p.evaluate(() => document.querySelector('[data-id="more"]').classList.contains("overflow-mark")), JSON.stringify(r));
    await p.close();
  });

  await check("every screen's behaviour: Powered by WayTuGo, Identify, the touch lockdown", async () => {
    const p = await browser.newPage({ viewport: { width: 540, height: 960 } });
    await p.goto(`${B}/board.html?screen=${portrait.key}&view=1`); await p.waitForTimeout(2000);
    assert(await p.isVisible("#powered"), "Powered by shows");
    const prevented = await p.evaluate(() => { const e = new Event("contextmenu", { cancelable: true, bubbles: true }); document.body.dispatchEvent(e); return e.defaultPrevented; });
    assert(prevented, "long-press menu blocked");
    await sb(`screens?id=eq.${portrait.id}`, { method: "PATCH", body: JSON.stringify({ identify_until: new Date(Date.now() + 60000).toISOString(), hide_powered_by: true }) });
    await p.reload(); await p.waitForTimeout(2000);
    assert(await p.isVisible("#identify") && (await p.textContent("#identify")).includes(portrait.key), "Identify shows");
    assert(!(await p.isVisible("#powered")), "1Point's switch hides Powered by");
    await sb(`screens?id=eq.${portrait.id}`, { method: "PATCH", body: JSON.stringify({ identify_until: null, hide_powered_by: false }) });
    await p.close();
  });

  await check("a real screen checks in with its version; View doesn't", async () => {
    await sb(`screens?id=eq.${portrait.id}`, { method: "PATCH", body: JSON.stringify({ last_seen: null, last_report: {} }) });
    const p = await browser.newPage({ viewport: { width: 540, height: 960 } });
    await p.goto(`${B}/board.html?screen=${portrait.key}&view=1`); await p.waitForTimeout(1500);
    let [s] = (await sb(`screens?id=eq.${portrait.id}&select=last_seen,last_report`)).data;
    assert(!s.last_seen, "View recorded a check-in");
    await p.goto(`${B}/board.html?screen=${portrait.key}`); await p.waitForTimeout(2000);
    [s] = (await sb(`screens?id=eq.${portrait.id}&select=last_seen,last_report`)).data;
    const version = readFileSync(new URL("../netlify/lib/version.mjs", import.meta.url), "utf8").match(/"([\d.]+)"/)[1];
    assert(s.last_seen && s.last_report.version === version, JSON.stringify(s));
    await p.close();
  });

  await check("offline: the kept copy is drawn with Reconnecting…, and Powered by steps aside", async () => {
    const p = await browser.newPage({ viewport: { width: 540, height: 960 } });
    await p.goto(`${B}/board.html?screen=${portrait.key}&view=1`); await p.waitForTimeout(2000);
    await p.route("**/api/screen**", (r) => r.abort());
    await p.reload(); await p.waitForTimeout(2500);
    assert(await p.locator(".b").count() === DOC.blocks.length, "drawn from the kept copy");
    assert(await p.isVisible("#offline"), "Reconnecting shows");
    assert(await p.evaluate(() => getComputedStyle(document.getElementById("powered")).visibility === "hidden"), "Powered by steps aside");
    await p.close();
  });

  await check("a newer display makes a real layout screen reload itself, once", async () => {
    const p = await browser.newPage({ viewport: { width: 540, height: 960 } });
    let loads = 0;
    p.on("load", () => loads++);
    await p.route("**/api/screen**", async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ response: res, json: { ...j, display: "9.9.9" } }); });
    await p.goto(`${B}/board.html?screen=${portrait.key}`); await p.waitForTimeout(6000);
    const note = await p.evaluate(() => JSON.parse(localStorage.getItem("display-reload") || "null"));
    assert(note && note.to === "9.9.9" && loads === 2, `${JSON.stringify(note)}, ${loads} page loads (2 expected: once, then no loop)`);
    await p.close();
  });

  await check("a portrait layout in a landscape window turns as the Pi turns its picture", async () => {
    const p = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await p.goto(`${B}/board.html?screen=${portrait.key}&view=1`); await p.waitForTimeout(2000);
    const t = await p.evaluate(() => document.getElementById("stage").style.transform);
    assert(/rotate\(-90deg\)/.test(t), t);
    await p.close();
  });

  await check("switched back to a directory, the layout page hands back to the directory page", async () => {
    const p = await browser.newPage({ viewport: { width: 540, height: 960 } });
    await p.goto(`${B}/board.html?screen=${portrait.key}&view=1`); await p.waitForTimeout(1500);
    await sb(`screens?id=eq.${portrait.id}`, { method: "PATCH", body: JSON.stringify({ layout_id: null, property_id: null, directory_id: portrait.directory_id }) });
    await p.reload(); await p.waitForTimeout(2500);
    assert(new URL(p.url()).pathname === "/" && await p.locator(".tenant").count() > 0, p.url());
    await sb(`screens?id=eq.${portrait.id}`, { method: "PATCH", body: JSON.stringify({ directory_id: null, layout_id: lay.id, property_id: home.id }) });
    await p.close();
  });

  // ── The console ──
  const admin = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  admin.on("dialog", (d) => d.accept());
  await signIn(admin, "scot@1pointusa.com", "admin-pass");

  await check("the console says Orientation (Screens list and Screen settings), and lists layout screens", async () => {
    assert(await admin.evaluate(() => [...document.querySelectorAll("#panel-screens thead")].some((t) => t.textContent.includes("Orientation") && !t.textContent.includes("Layout"))), "list header");
    assert((await admin.textContent("#screen-rows")).includes("Layout: Donut Joe's Pelham"), "layout screen listed");
    await admin.click(`[data-screen="${landscape.id}"]`); await admin.waitForTimeout(300);
    assert((await admin.textContent("#f-s-orient label")) === "Orientation", "Screen settings label");
    await admin.click('#dlg button[value="cancel"]');
  });

  await check("Screen settings: a portrait layout on a landscape screen is refused in plain words", async () => {
    await admin.click(`[data-screen="${landscape.id}"]`); await admin.waitForTimeout(300);
    await admin.selectOption("#s-dir", `l:${lay.id}`);
    assert(await admin.isVisible("#f-s-prop"), "the Building choice appears");
    await admin.click("#dlg-ok"); await admin.waitForTimeout(800);
    const msg = await admin.textContent("#dlg-error");
    assert(/is portrait, and this screen's Orientation is Landscape\. Change the screen's Orientation to Portrait first/.test(msg), msg);
    await admin.click('#dlg button[value="cancel"]');
  });

  await check("Screen settings: choosing a layout and its building for a matching screen works", async () => {
    await admin.click(`[data-screen="${landscape.id}"]`); await admin.waitForTimeout(300);
    await admin.selectOption("#s-dir", `l:${wide.id}`);
    await admin.click("#dlg-ok"); await admin.waitForTimeout(800);
    const msg = await admin.textContent("#dlg-error");
    assert(/hasn't been published yet/.test(msg), `unpublished refused: ${msg}`);
    await sb("rpc/layout_publish", { method: "POST", body: JSON.stringify({ p_layout: wide.id, p_doc: { format: 1, orientation: "landscape", grid: { cols: 16, rows: 9 }, blocks: [] }, p_checks: {}, p_overridden: false, p_note: "", p_by: null }) });
    await admin.click('#dlg button[value="cancel"]');
    await admin.evaluate(() => window.ConsoleRefresh());
    await admin.click(`[data-screen="${landscape.id}"]`); await admin.waitForTimeout(300);
    await admin.selectOption("#s-dir", `l:${wide.id}`);
    await admin.click("#dlg-ok"); await admin.waitForTimeout(1000);
    const [s] = (await sb(`screens?id=eq.${landscape.id}&select=layout_id,property_id,directory_id`)).data;
    assert(s.layout_id === wide.id && s.property_id && !s.directory_id, JSON.stringify(s));
    await sb(`screens?id=eq.${landscape.id}`, { method: "PATCH", body: JSON.stringify({ layout_id: null, property_id: null, directory_id: landscape.directory_id }) });
    await admin.evaluate(() => window.ConsoleRefresh());
  });

  await check("Layouts tab: add a layout; bad JSON and format problems are shown in plain words", async () => {
    await admin.click('[data-tab="layouts"]'); await admin.waitForTimeout(300);
    await admin.click("#add-layout"); await admin.waitForTimeout(200);
    await admin.fill("#l-name", "Browser check layout"); await admin.selectOption("#l-orient", "portrait");
    await admin.click("#dlg-ok"); await admin.waitForTimeout(1200);
    assert(await admin.isVisible("#layout-detail") && (await admin.textContent("#layout-title")) === "Browser check layout", "opened");
    await admin.fill("#layout-json", "{ not json");
    await admin.click("#layout-check"); await admin.waitForTimeout(400);
    assert((await admin.textContent("#layout-results")).includes("That isn't valid JSON"), "bad JSON");
    await admin.fill("#layout-json", JSON.stringify({ format: 1, orientation: "portrait", grid: { cols: 12, rows: 24 }, blocks: [{ id: "a", type: "banner", at: { col: 1, row: 1, w: 13, h: 1 } }] }));
    await admin.click("#layout-check"); await admin.waitForTimeout(600);
    const t = await admin.textContent("#layout-results");
    assert(t.includes("problem") && t.includes('"type" must be one of'), t);
  });

  await check("Layouts tab: preview draws it, the overflow guardrail warns, Publish asks, Publish anyway publishes", async () => {
    const doc = JSON.parse(JSON.stringify(DOC));
    doc.blocks.find((b) => b.id === "more").content.items.push(...Array.from({ length: 14 }, (_, i) => ({ name: `Extra item ${i + 1}`, price: "$1.00" })));
    await admin.fill("#layout-json", JSON.stringify(doc, null, 2));
    await admin.click("#layout-preview"); await admin.waitForTimeout(4500);
    const frame = admin.frameLocator("#layout-iframe");
    assert(await frame.locator(".b").count() > 0, "the preview drew blocks");
    assert((await admin.textContent("#layout-results")).includes(`block "more"`), "overflow warned");
    await admin.click("#layout-publish"); await admin.waitForTimeout(1500);
    assert(await admin.isVisible("#layout-anyway"), "Publish anyway offered");
    await admin.click("#layout-anyway"); await admin.waitForTimeout(1500);
    assert((await admin.textContent("#layout-versions")).includes("published anyway"), await admin.textContent("#layout-versions"));
  });

  await check("Layouts tab: a clean change publishes as the next version; Roll back brings an old one back as a new version", async () => {
    await admin.fill("#layout-json", JSON.stringify(DOC, null, 2));
    await admin.fill("#layout-note", "clean");
    await admin.click("#layout-publish"); await admin.waitForTimeout(5000);
    const v = await admin.textContent("#layout-versions");
    assert(/2\s*· live/.test(v) && v.includes("clean"), v);
    await admin.click('[data-rollback="1"]'); await admin.waitForTimeout(1500);
    assert(/3\s*· live/.test(await admin.textContent("#layout-versions")) && (await admin.textContent("#layout-versions")).includes("Rolled back to version 1"), await admin.textContent("#layout-versions"));
  });

  await check("Layouts tab: a layout a screen shows can't be removed, in plain words", async () => {
    await admin.click("#layout-back"); await admin.waitForTimeout(300);
    await admin.click(`[data-open-layout="${lay.id}"]`); await admin.waitForTimeout(800);
    await admin.click("#layout-remove"); await admin.waitForTimeout(800);
    assert(/is shown on 1 screen/.test(await admin.textContent("#toast, .toast").catch(() => "")) || (await sb(`layouts?id=eq.${lay.id}&select=id`)).data.length === 1, "still there");
  });
  await admin.close();

  await check("an owner sees their layout screen, but no Layouts tab", async () => {
    const p = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    await signIn(p, "leighann@barber.test", "owner-pass");
    assert(await p.locator("#tab-layouts").isHidden(), "no Layouts tab");
    assert((await p.textContent("#screen-rows")).includes("Layout: Donut Joe's Pelham"), "the layout screen is listed");
    await p.close();
  });

  await check("the directory display still works after the shared code: a touch screen's tap opens a company's card", async () => {
    await sb(`screens?id=eq.${landscape.id}`, { method: "PATCH", body: JSON.stringify({ touch: true, screen_inches: 13.3 }) });
    const p = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await p.goto(`${B}/?screen=${landscape.key}&view=1`); await p.waitForTimeout(2500);
    await p.click(".tenant >> nth=0"); await p.waitForTimeout(400);
    assert(await p.isVisible("#card"), "card opened");
    await sb(`screens?id=eq.${landscape.id}`, { method: "PATCH", body: JSON.stringify({ touch: false, screen_inches: null }) });
    await p.close();
  });

  await check("the editor's live preview still draws the directory (as the owner's editor)", async () => {
    const p = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await signIn(p, "editor@barber.test", "editor-pass");
    await p.goto(`${B}/edit.html?d=${landscape.directory_id}`); await p.waitForTimeout(3000);
    const n = await p.frameLocator("iframe").locator(".tenant").count();
    assert(n > 0, `${n} tenants in the preview`);
    await p.close();
  });

  await check("the technician page says Orientation", async () => {
    const html = readFileSync(new URL("../public/tech.html", import.meta.url), "utf8");
    assert(html.includes("<h2>Orientation</h2>") && html.includes("Save orientation") && !/>Layout</.test(html), "tech.html");
  });
  void otherOrg;
} finally {
  await browser.close();
  srv.kill(); old?.kill();
}
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
