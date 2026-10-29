// Browser checks (DP-11, round E1a; before this they were run ad hoc in each chat). Starts the local test server
// (tests/test-server.mjs, with the fake Supabase), drives Chromium with Playwright, and ends with "N/N passed".
//
//   node tests/browser-checks.mjs                       # the layout page, the console's Layouts tab, Orientation
//   node tests/browser-checks.mjs --compare <public>    # also: directory screens drawn exactly as by another copy of
//                                                       # public/ (e.g. the previous chat's), element by element
// Needs Playwright with Chromium (require("playwright")); about a minute.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PORT = 8931, OLD_PORT = 8932, B = `http://localhost:${PORT}`;
const compareDir = process.argv.includes("--compare") ? process.argv[process.argv.indexOf("--compare") + 1] : null;
const DOC = JSON.parse(readFileSync(new URL("../layouts/donut-joes-pelham.json", import.meta.url), "utf8"));
const CHALK1 = JSON.parse(readFileSync(new URL("../layouts/donut-joes-chalkboard-32.json", import.meta.url), "utf8"));
const CHALK2 = JSON.parse(readFileSync(new URL("../layouts/donut-joes-chalkboard-32-lists.json", import.meta.url), "utf8"));

let pass = 0, total = 0;
// SHOTS=<folder>: also save screenshots of the menu editor and the board (for looking at, not checked)
const SHOTS = process.env.SHOTS || "";
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }).catch(() => {}); };
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
    assert(await p.evaluate(() => getComputedStyle(document.documentElement).touchAction) === "none", "a screen still ignores pinch");
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

  // ── Pictures (E1b) ──
  const picDir = mkdtempSync(join(tmpdir(), "pics-"));
  copyFileSync(new URL("./fixtures/picture.png", import.meta.url), join(picDir, "maple-bacon.png"));
  copyFileSync(new URL("./fixtures/picture.jpg", import.meta.url), join(picDir, "Shop Front.jpg"));
  await check("Pictures: uploading through the console shrinks to WebP, gives each a key from its file name, and shows it", async () => {
    await admin.setInputFiles("#pics-file", [join(picDir, "maple-bacon.png"), join(picDir, "Shop Front.jpg")]);
    await admin.waitForFunction(() => /2 uploaded/.test(document.getElementById("pics-progress").textContent), null, { timeout: 15000 });
    const t = await admin.textContent("#pics-progress");
    assert(t.includes("img:maple-bacon") && t.includes("img:shop-front"), t);
    // the grid redraws just after the progress line says so (DP-12: this raced once in a run with --compare)
    await admin.waitForFunction(() => document.querySelectorAll("#pics-grid .pic").length === 2, null, { timeout: 5000 }).catch(() => {});
    assert(await admin.locator("#pics-grid .pic").count() === 2, "two pictures listed");
    await admin.locator("#pics-grid").scrollIntoViewIfNeeded(); await admin.waitForTimeout(800);   // they load lazily
    const loaded = await admin.$$eval("#pics-grid img", (imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0));
    assert(loaded, "the pictures load from /img/");
    const rows = (await sb("layout_images?select=key,mime,width,path")).data;
    assert(rows.length === 2 && rows.every((r) => r.mime === "image/webp" && r.width === 320 && /\.webp$/.test(r.path)), JSON.stringify(rows));
  });

  await check("Pictures: the preview draws them, a rotator takes turns, text straight on a photo is warned about", async () => {
    const doc = { format: 1, orientation: "portrait", grid: { cols: 12, rows: 24 }, blocks: [
      { id: "hero", type: "rotator", at: { col: 1, row: 1, w: 12, h: 10 }, content: { seconds: 4, items: [
        { image: "img:maple-bacon", caption: "Maple Bacon", price: "$1.89" }, { image: "img:shop-front", caption: "Come see us" }] } },
      { id: "over", type: "text", at: { col: 2, row: 2, w: 6, h: 3 }, layer: 1, style: { size: "xl" }, content: { title: "On the photo" } },
      { id: "logo", type: "logo", at: { col: 1, row: 12, w: 6, h: 3 }, content: { image: "img:shop-front", text: "Shop" } }] };
    await admin.fill("#layout-json", JSON.stringify(doc, null, 2));
    await admin.click("#layout-preview"); await admin.waitForTimeout(4000);
    assert((await admin.textContent("#layout-results")).includes("sits straight on the picture"), await admin.textContent("#layout-results"));
    const frame = admin.frameLocator("#layout-iframe");
    const first = await frame.locator('[data-id="hero"] .rot-slide.on').getAttribute("data-slide");
    const ok = await frame.locator('[data-id="hero"] img').evaluateAll((imgs) => imgs.length === 2 && imgs.every((i) => i.complete && i.naturalWidth > 0));
    assert(ok, "both slides' pictures loaded");
    assert(await frame.locator('[data-id="logo"].has-img img').count() === 1, "the logo is the picture");
    let next = first;
    for (let i = 0; i < 12 && next === first; i++) { await admin.waitForTimeout(500); next = await frame.locator('[data-id="hero"] .rot-slide.on').getAttribute("data-slide"); }
    assert(first !== next && ["0", "1"].includes(next), `slides ${first} then ${next} within 6 seconds`);
  });

  await check("Pictures: a missing one is a problem; one the draft uses can't be removed; an unused one can", async () => {
    await admin.fill("#layout-json", JSON.stringify({ format: 1, orientation: "portrait", grid: { cols: 12, rows: 24 }, blocks: [
      { id: "p", type: "photo", at: { col: 1, row: 1, w: 12, h: 8 }, content: { image: "img:maple-bacon" } }] }));
    await admin.click("#layout-check"); await admin.waitForTimeout(800);   // clean, so kept as the draft
    await admin.fill("#layout-json", JSON.stringify({ format: 1, orientation: "portrait", grid: { cols: 12, rows: 24 }, blocks: [
      { id: "p", type: "photo", at: { col: 1, row: 1, w: 12, h: 8 }, content: { image: "img:maple-bacon" } },
      { id: "q", type: "photo", at: { col: 1, row: 9, w: 12, h: 8 }, content: { image: "img:not-here" } }] }));
    await admin.click("#layout-check"); await admin.waitForTimeout(800);
    assert((await admin.textContent("#layout-results")).includes(`There's no picture "not-here"`), await admin.textContent("#layout-results"));
    const ids = Object.fromEntries((await sb("layout_images?select=id,key")).data.map((r) => [r.key, r.id]));
    await admin.click(`[data-pic-delete="${ids["maple-bacon"]}"]`); await admin.waitForTimeout(1000);
    assert((await sb("layout_images?select=id")).data.length === 2, "the one in the draft stays");
    await admin.click(`[data-pic-delete="${ids["shop-front"]}"]`); await admin.waitForTimeout(1000);
    const left = (await sb("layout_images?select=key")).data.map((r) => r.key);
    assert(left.length === 1 && left[0] === "maple-bacon", JSON.stringify(left));
    await admin.fill("#layout-json", JSON.stringify(DOC, null, 2)); await admin.click("#layout-check"); await admin.waitForTimeout(600);
  });

  // ── Take this menu with you (E1c) ──
  const MENU_DOC = { format: 1, orientation: "portrait", grid: { cols: 12, rows: 24 }, viewing: { inches: 43, metres: 2 },
    theme: { palette: { bg: "#fff7ec", ink: "#2b1a12" }, fonts: { display: "Fraunces", body: "Instrument Sans" } }, blocks: [
      { id: "logo", type: "logo", at: { col: 1, row: 1, w: 12, h: 3 }, content: { image: "img:maple-bacon", text: "Browser shop" } },
      { id: "menu", type: "items", at: { col: 1, row: 4, w: 12, h: 10 }, style: { size: "l" }, content: { heading: "Donuts", items: [
        { name: "Maple Bacon", price: "$1.89", link: "https://example.com/maple-bacon" }, { name: "Glazed", price: "$1.29" }] } },
      { id: "code", type: "qr", at: { col: 4, row: 15, w: 6, h: 7 }, style: { align: "center" }, content: {} }] };
  let menuCode = "";
  await check("Take this menu with you: the QR block draws the layout's own code; the console shows its address once published", async () => {
    await admin.fill("#layout-json", JSON.stringify(MENU_DOC, null, 2));
    await admin.click("#layout-preview"); await admin.waitForTimeout(4000);
    const frame = admin.frameLocator("#layout-iframe");
    assert(await frame.locator('[data-id="code"] .qr-code svg').count() === 1, "the preview draws the QR code");
    await admin.click("#layout-publish"); await admin.waitForTimeout(1500);
    if (await admin.isVisible("#layout-anyway")) { await admin.click("#layout-anyway"); await admin.waitForTimeout(1500); }
    menuCode = (await sb(`layouts?name=eq.Browser%20check%20layout&select=menu_code`)).data[0].menu_code;
    await admin.waitForFunction((c) => document.getElementById("layout-menu").textContent.includes(`waytugo.com/m/${c}`), menuCode, { timeout: 8000 });
    assert((await admin.getAttribute("#layout-menu a", "target")) === "_blank", "opens in a new tab");
  });

  await check("Take this menu with you: the phone page as designed, links in a new tab, See the board draws the board; the open is counted", async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const res = await phone.goto(`${B}/m/${menuCode}`); await phone.waitForTimeout(800);
    assert(res.status() === 200, `status ${res.status()}`);
    assert(await phone.locator("header img.logo").evaluate((i) => i.complete && i.naturalWidth > 0), "the logo picture loads");
    const link = phone.locator('a[href="https://example.com/maple-bacon"]');
    assert(await link.count() === 1 && (await link.getAttribute("target")) === "_blank", "Maple Bacon links out in a new tab");
    assert(await phone.locator(".qr-code, .b-clock").count() === 0, "no QR code or clock on the phone");
    const bodyFont = await phone.evaluate(() => getComputedStyle(document.querySelector(".head")).fontFamily);
    assert(/Fraunces/.test(bodyFont), `the layout's display font: ${bodyFont}`);
    assert(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scrolling");
    await phone.click(".board summary"); await phone.waitForTimeout(3500);
    const board = phone.frameLocator(".board iframe");
    assert(await board.locator(".b").count() >= 3 && await board.locator('[data-id="code"] .qr-code svg').count() === 1, "See the board draws the board, with its QR code");
    // a phone, not a lobby screen: pinch-zoom and touches aren't locked (Scot, 2026-10-28: nothing reacted on an iPhone)
    assert(await board.locator("html").evaluate((h) => getComputedStyle(h).touchAction) === "auto", "pinch-zoom works in See the board");
    assert((await phone.getAttribute('.board a[target="_blank"]', "href")).endsWith(`/board.html?menu=${menuCode}`), "Open it full screen");
    const full = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await full.goto(`${B}/board.html?menu=${menuCode}`); await full.waitForTimeout(2500);
    assert(await full.locator(".b").count() >= 3 && await full.evaluate(() => getComputedStyle(document.body).touchAction) === "auto", "full screen draws the board, zoomable");
    await full.close();
    await phone.close();
    await admin.click("#layout-back"); await admin.waitForTimeout(300);
    await admin.click(`[data-open-layout="${(await sb("layouts?name=eq.Browser%20check%20layout&select=id")).data[0].id}"]`); await admin.waitForTimeout(1500);
    assert(/opened 1 time in the last 30 days \(1 in all\)/.test(await admin.textContent("#layout-menu")), await admin.textContent("#layout-menu"));
    await admin.fill("#layout-json", JSON.stringify(DOC, null, 2)); await admin.click("#layout-check"); await admin.waitForTimeout(600);
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
  // ── Menus (DP-12, round E2a): the customer's lists, one set for every board and the phone menu ──
  const COUNTER = JSON.parse(readFileSync(new URL("../layouts/donut-joes-counter-55.json", import.meta.url), "utf8"));
  for (const k of ["donut-joes-logo", "maple-bacon", "apple-fritter", "cinnamon-rolls", "smokey-joes", "blue-raspberry-bolt", "pumpkin-spice-cake", "gift-cards"])
    await sb("layout_images", { method: "POST", body: JSON.stringify({ org_id: home.org_id, key: k, name: k.replace(/-/g, " "), path: `${home.org_id}/${k}-1a2b3c4d.webp`, mime: "image/webp", width: 800, height: 600, bytes: 50000 }) });
  const [counter] = (await sb("layouts", { method: "POST", body: JSON.stringify({ org_id: home.org_id, name: "Counter board", family: "menu", orientation: "landscape" }) })).data;
  const ROOMS = { hero: 7, hours: 2, donuts: 16, pastries: 7, coffee: 8, energy: 5, fall: 4, "take-home": 4 };
  let menuId = null;
  const boss = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  boss.on("dialog", (d) => d.accept());
  await signIn(boss, "scot@1pointusa.com", "admin-pass");
  const theMenu = async () => (await sb(`menus?id=eq.${menuId}&select=*`)).data[0];
  const listOf = async (key) => (await theMenu()).content.lists[key];

  await check("Make lists from this layout (1Point): each list proposed with its room; the blocks point at the new menu's lists", async () => {
    await boss.click('[data-tab="layouts"]'); await boss.waitForTimeout(300);
    await boss.click(`[data-open-layout="${counter.id}"]`); await boss.waitForTimeout(900);
    await boss.fill("#layout-json", JSON.stringify(COUNTER, null, 2));
    await boss.click("#layout-check"); await boss.waitForTimeout(800);
    assert(/No problems|warning/.test(await boss.textContent("#layout-results")), await boss.textContent("#layout-results"));
    await boss.click("#menu-make"); await boss.waitForTimeout(500);
    const offered = await boss.$$eval("[data-mk]", (xs) => xs.map((x) => [x.dataset.mk, x.checked]));
    assert(offered.find(([k]) => k === "donuts")?.[1] && offered.find(([k]) => k === "fall-pic") && !offered.find(([k]) => k === "fall-pic")[1], `offered ${JSON.stringify(offered)}`);
    for (const [k, n] of Object.entries(ROOMS)) await boss.fill(`[data-room="${k}"]`, String(n));
    await boss.click("#dlg-ok"); await boss.waitForTimeout(1500);
    const [l] = (await sb(`layouts?id=eq.${counter.id}&select=menu_id,draft`)).data;
    menuId = l.menu_id;
    const m = await theMenu();
    assert(m && m.org_id === home.org_id && m.rev === 1 && m.customer_edit, JSON.stringify(m));
    const rooms = Object.fromEntries(m.spec.lists.map((x) => [x.key, x.room]));
    for (const [k, n] of Object.entries(ROOMS)) assert(rooms[k] === n, `room ${k} ${rooms[k]}`);
    assert(m.content.lists.donuts.entries.length === 12 && m.content.lists.donuts.price === "$1.89 each" && m.content.lists.energy.price === "$4.99", "content");
    const donuts = l.draft.blocks.find((b) => b.id === "donuts");
    assert(donuts.content.list === "donuts" && !donuts.content.items && donuts.content.heading === "Handmade every morning", JSON.stringify(donuts.content));
    assert(!l.draft.blocks.find((b) => b.id === "fall-pic").content.list, "the lone photo stays the layout's");
    assert((await boss.inputValue("#layout-json")).includes('"list": "donuts"'), "the JSON shows the lists");
    assert((await boss.textContent("#layout-menu-box")).includes("Its lists come from"), await boss.textContent("#layout-menu-box"));
  });

  await check("Layouts tab: preview and publish the board on its lists; the screen draws them", async () => {
    await boss.click("#layout-preview"); await boss.waitForTimeout(2500);
    const n = await boss.frameLocator("#layout-iframe").locator('[data-id="donuts"] .item:not(.ghost)').count();
    assert(n === 12, `${n} donuts in the preview`);
    assert(await boss.frameLocator("#layout-iframe").locator('[data-id="donuts"] .item.ghost').count() === 4, "the room kept as 4 empty rows");
    await boss.click("#layout-publish"); await boss.waitForTimeout(1500);
    if (await boss.isVisible("#layout-anyway")) { await boss.click("#layout-anyway"); await boss.waitForTimeout(1500); }
    const [l] = (await sb(`layouts?id=eq.${counter.id}&select=published_version`)).data;
    assert(l.published_version === 1, JSON.stringify(l));
    await sb(`screens?id=eq.${landscape.id}`, { method: "PATCH", body: JSON.stringify({ directory_id: null, layout_id: counter.id, property_id: home.id }) });
    const p = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await p.goto(`${B}/board.html?screen=${landscape.key}&view=1`); await p.waitForTimeout(2500);
    const t = await p.textContent('[data-id="coffee"]');
    assert(t.includes("Cold Brew") && t.includes("$4.29"), t);
    assert((await p.textContent('[data-id="energy"]')).includes("$4.99"), "the list price on the chips");
    await p.close();
  });

  await check("room-sized text: adding donuts up to the room never changes the others' size; sold out today is struck, hidden left out", async () => {
    const size = async () => {
      const p = await browser.newPage({ viewport: { width: 960, height: 540 } });
      await p.goto(`${B}/board.html?screen=${landscape.key}&view=1`); await p.waitForTimeout(2500);
      const r = await p.evaluate(() => ({ fs: getComputedStyle(document.querySelector('[data-id="donuts"] .item-name')).fontSize, names: [...document.querySelectorAll('[data-id="donuts"] .item:not(.ghost) .item-name')].map((x) => x.textContent), sold: [...document.querySelectorAll('[data-id="donuts"] .item.sold .item-name')].map((x) => x.textContent) }));
      await p.close(); return r;
    };
    const before = await size();
    const m = await theMenu(), today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const es = m.content.lists.donuts.entries;
    es.push({ id: "add001", name: "Lemon Curd" }, { id: "add002", name: "Boston Cream" }, { id: "add003", name: "Secret Test Donut", hidden: true });
    es[1].soldOut = today;
    await sb(`menus?id=eq.${menuId}`, { method: "PATCH", body: JSON.stringify({ content: m.content }) });
    const after = await size();
    assert(before.fs === after.fs, `text ${before.fs} then ${after.fs}`);
    assert(after.names.length === 14 && after.names.some((x) => x.includes("Boston Cream")) && !after.names.some((x) => x.includes("Secret")), after.names.join(", "));
    assert(after.sold.length === 1 && after.sold[0].startsWith(es[1].name), JSON.stringify(after.sold));
    const r = await (await fetch(`${B}/api/screen?key=${landscape.key}`)).json();
    assert(!JSON.stringify(r.lists).includes("Secret Test Donut"), "a hidden item never leaves the site");
  });

  const owner = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  owner.on("dialog", (d) => d.accept());
  await signIn(owner, "leighann@barber.test", "owner-pass");

  await check("the owner's console: a Menus tab and Edit menu on the layout screen; the editor shows each list with its room", async () => {
    assert(await owner.locator("#tab-menus").isVisible(), "Menus tab");
    assert(await owner.locator(`a[href="/menu-edit.html?m=${menuId}"]`).first().isVisible(), "Edit menu on the screen's row");
    await owner.click('[data-tab="menus"]'); await owner.waitForTimeout(300);
    assert((await owner.textContent("#menu-rows")).includes("Counter board"), "boards listed");
    await owner.goto(`${B}/menu-edit.html?m=${menuId}`); await owner.waitForTimeout(3000);
    const counts = await owner.$$eval(".me-list", (xs) => xs.map((x) => [x.dataset.key, x.querySelector(".me-count")?.textContent || ""]));
    assert(counts.find(([k]) => k === "donuts")[1] === "15 of 16" && counts.find(([k]) => k === "energy")[1] === "4 of 5", JSON.stringify(counts));
    assert(await owner.isHidden("#readonly") && await owner.isDisabled("#save"), "editable, nothing to save yet");
    assert((await owner.textContent("#lists")).includes("set by WayTuGo"), "says the layout is 1Point's");
    const pv = await owner.frameLocator("#pv").locator('[data-id="coffee"]').textContent();
    assert(pv.includes("Cold Brew"), "the preview draws the board");
    await shot(owner, "menu-editor");
  });

  await check("menu editor: change a price, add an item, sold out today, hide; Save goes live with who did it", async () => {
    const coffee = owner.locator('.me-list[data-key="coffee"]');
    await coffee.locator('.me-row[data-i="4"] input[data-f="price"]').fill("$4.49");
    await coffee.locator("[data-add]").click();
    await coffee.locator('.me-row[data-i="6"] input[data-f="name"]').fill("Iced Chai");
    await coffee.locator('.me-row[data-i="6"] input[data-f="price"]').fill("$4.79");
    await coffee.locator('.me-row[data-i="0"] [data-sw="sold"]').check();
    await coffee.locator('.me-row[data-i="2"] [data-sw="hidden"]').check();
    await owner.waitForTimeout(800);
    assert((await owner.textContent("#saved-line")) === "Unsaved changes", "unsaved");
    const pv = await owner.frameLocator("#pv").locator('[data-id="coffee"]').textContent();
    assert(pv.includes("Iced Chai") && !pv.includes("Sugar-Free"), `the preview follows before saving: ${pv}`);
    await owner.click("#save"); await owner.waitForTimeout(3500);
    assert(await owner.isHidden("#save-problems"), await owner.textContent("#save-problems"));
    const c = await listOf("coffee");
    assert(c.entries.find((e) => e.name === "Cold Brew").price === "$4.49" && c.entries.find((e) => e.name === "Iced Chai")?.price === "$4.79", JSON.stringify(c.entries));
    assert(c.entries[0].soldOut && c.entries[2].hidden, "sold out and hidden kept");
    const [r] = (await sb(`menu_revisions?menu_id=eq.${menuId}&select=rev,by_name,by_1point&order=rev.desc&limit=1`)).data;
    assert(r.by_name === "Leigh Ann" && !r.by_1point, JSON.stringify(r));
    const hist = await owner.textContent("#history");
    assert(hist.includes("Coffee bar · Cold Brew: price $4.29 → $4.49") && hist.includes("Coffee bar: added Iced Chai") && hist.includes("Leigh Ann"), hist.slice(0, 400));
    const p = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await p.goto(`${B}/board.html?screen=${landscape.key}&view=1`); await p.waitForTimeout(2500);
    const t = await p.textContent('[data-id="coffee"]');
    assert(t.includes("Iced Chai") && t.includes("$4.49") && !t.includes("Sugar-Free"), t);
    await shot(p, "board-after-save");
    await p.close();
  });

  await check("menu editor: a full list takes no more (the menu expansion line), and the database refuses past the room too", async () => {
    const energy = owner.locator('.me-list[data-key="energy"]');
    await energy.locator("[data-add]").click();
    await energy.locator('.me-row[data-i="4"] input[data-f="name"]').fill("Grape Gust");
    assert(await energy.locator("[data-add]").isDisabled(), "Add greyed at 5 of 5");
    assert((await energy.textContent()).includes("This list is full (5 of 5). More room is a menu expansion: ask WayTuGo."), "the line");
    assert(await energy.locator('input[data-f="name"]').first().getAttribute("maxlength") === "25", "the box's cap");
    await owner.click("#save"); await owner.waitForTimeout(3000);
    assert((await listOf("energy")).entries.length === 5, "saved at the room");
    const m = await theMenu();
    const err = await owner.evaluate(async ({ id, rev }) => {
      const es = Array.from({ length: 6 }, (_, i) => ({ id: `over${i}`, name: `Drink ${i}` }));
      try { await Auth.db("rpc/menu_save", { method: "POST", body: { p_menu: id, p_base_rev: rev, p_content: { lists: { energy: { entries: es } } } } }); return "saved"; } catch (e) { return e.message; }
    }, { id: menuId, rev: m.rev });
    assert(/room for 5.*menu expansion: ask WayTuGo/.test(err), err);
  });

  await check("menu editor: a list that wouldn't fit the board isn't saved; the owner is told what to shorten; 1Point can save anyway", async () => {
    const m = await theMenu();
    m.spec.lists.find((x) => x.key === "pastries").caps.name = 80;
    await sb(`menus?id=eq.${menuId}`, { method: "PATCH", body: JSON.stringify({ spec: m.spec }) });
    await owner.reload(); await owner.waitForTimeout(3000);
    const rows = owner.locator('.me-list[data-key="pastries"] .me-row');
    for (let i = 0; i < 6; i++) await rows.nth(i).locator('input[data-f="name"]').fill(`An extremely long pastry name ${i} that goes on and on for the whole box`);
    await owner.click("#save"); await owner.waitForTimeout(6000);
    const msg = await owner.textContent("#save-problems");
    assert(/wouldn't fit on the board.*"Pastries & Smokey Joes" on Counter board/.test(msg) && !msg.includes("Save anyway"), msg);
    await shot(owner, "menu-editor-refused");
    assert(!(await listOf("pastries")).entries.some((e) => e.name.startsWith("An extremely")), "not saved");
    await owner.click("#undo"); await owner.waitForTimeout(500);
    await boss.goto(`${B}/menu-edit.html?m=${menuId}`); await boss.waitForTimeout(3000);
    const brow = boss.locator('.me-list[data-key="pastries"] .me-row');
    for (let i = 0; i < 6; i++) await brow.nth(i).locator('input[data-f="name"]').fill(`An extremely long pastry name ${i} that goes on and on for the whole box`);
    await boss.click("#save"); await boss.waitForTimeout(6000);
    await boss.click("#save-anyway"); await boss.waitForTimeout(3000);
    const r = (await sb(`menu_revisions?menu_id=eq.${menuId}&select=rev,by_1point&order=rev.desc&limit=1`)).data[0];
    assert((await listOf("pastries")).entries[0].name.startsWith("An extremely") && r.by_1point, "1Point saved anyway");
  });

  await check("History: Restore brings an earlier save back as a new save; two people at once: the later save is refused, saying who", async () => {
    await boss.reload(); await boss.waitForTimeout(3000);
    const revs = (await sb(`menu_revisions?menu_id=eq.${menuId}&select=rev&order=rev.desc`)).data.map((r) => r.rev);
    await boss.click(`[data-restore="${revs[1]}"]`); await boss.waitForTimeout(2500);
    const top = (await sb(`menu_revisions?menu_id=eq.${menuId}&select=rev,restored_from&order=rev.desc&limit=1`)).data[0];
    assert(top.restored_from === revs[1] && !(await listOf("pastries")).entries[0].name.startsWith("An extremely"), JSON.stringify(top));
    // the owner's page is from before that restore
    await owner.locator('.me-list[data-key="donuts"] input[data-list-f="price"]').fill("$1.99 each");
    await owner.click("#save"); await owner.waitForTimeout(4000);
    const msg = await owner.textContent("#save-problems");
    assert(/Not saved: Someone else saved this menu after you opened it \(Scot/.test(msg), msg);
    await owner.reload(); await owner.waitForTimeout(3000);
    await owner.locator('.me-list[data-key="donuts"] input[data-list-f="price"]').fill("$1.99 each");
    await owner.click("#save"); await owner.waitForTimeout(4000);
    assert((await listOf("donuts")).price === "$1.99 each", "saved after reloading");
  });

  await check("hours, the announcement and the bottom line are the customer's too; the phone menu shows the lists (nothing hidden)", async () => {
    await owner.locator('.me-list[data-key="party"] input[data-f="title"]').fill("Giant Birthday Donut $42.99");
    await owner.locator('.me-list[data-key="hours"] .me-row[data-i="0"] [data-day="1"]').check({ force: true });
    await owner.locator('.me-list[data-key="hours"] input[data-list-f="note"]').fill("I-65 Exit 242");
    await owner.click("#save"); await owner.waitForTimeout(4000);
    assert(await owner.isHidden("#save-problems"), await owner.textContent("#save-problems"));
    assert((await listOf("hours")).entries[0].days.includes(1) && (await listOf("party")).entries[0].title.includes("$42.99"), "saved");
    const [l] = (await sb(`layouts?id=eq.${counter.id}&select=menu_code`)).data;
    const html = await (await fetch(`${B}/m/${l.menu_code}`)).text();
    assert(html.includes("Iced Chai") && html.includes("$1.99 each") && html.includes("$42.99") && !html.includes("Secret Test Donut") && !html.includes("Sugar-Free"), "the phone menu");
    assert(/<li class="item sold">[^]*?Caramel Latte/.test(html), "sold out today marked on the phone");
  });

  await check("customer editing off (a full maintenance plan): the editor is read-only and the database refuses the owner", async () => {
    await sb(`menus?id=eq.${menuId}`, { method: "PATCH", body: JSON.stringify({ customer_edit: false }) });
    await owner.reload(); await owner.waitForTimeout(3000);
    assert(await owner.isVisible("#readonly") && await owner.isDisabled('.me-list[data-key="coffee"] input[data-f="name"] >> nth=0'), "read-only");
    const m = await theMenu();
    const err = await owner.evaluate(async ({ id, rev, content }) => { try { await Auth.db("rpc/menu_save", { method: "POST", body: { p_menu: id, p_base_rev: rev, p_content: content } }); return "saved"; } catch (e) { return e.message; } }, { id: menuId, rev: m.rev, content: m.content });
    assert(/WayTuGo keeps this menu up to date/.test(err), err);
    await sb(`menus?id=eq.${menuId}`, { method: "PATCH", body: JSON.stringify({ customer_edit: true }) });
  });

  await check("List settings (1Point): room changed for a list; below what's in it is refused in plain words; a stranger sees no menu", async () => {
    await boss.goto(`${B}/console.html#layouts`); await boss.waitForTimeout(1500);
    await boss.click(`[data-open-layout="${counter.id}"]`); await boss.waitForTimeout(900);
    await boss.click("#menu-spec"); await boss.waitForTimeout(800);   // since after E2b: a form, one card per list
    const room = boss.locator('.ls-card[data-ls-key="coffee"] [data-ls="room"]');
    await room.fill("3");
    await boss.click("#dlg-ok"); await boss.waitForTimeout(800);
    assert(/Coffee bar.*has room for 3; this has 7/.test(await boss.textContent("#dlg-error")), await boss.textContent("#dlg-error"));
    await room.fill("10");
    await boss.click("#dlg-ok"); await boss.waitForTimeout(1000);
    assert((await theMenu()).spec.lists.find((x) => x.key === "coffee").room === 10, "saved");
    const other = await fetch(`${B}/sb/rest/v1/menus?select=id`, { headers: { apikey: "test-anon-key" } });
    assert((await other.json()).length === 0, "signed out: nothing");
  });
  await check("List settings form: boxes ticked with their most characters, dates and times switched on, a hint; a box in use can't go; JSON only under Advanced", async () => {
    await boss.click("#menu-spec"); await boss.waitForTimeout(800);
    assert(await boss.locator("#dlg.wide .ls-card").count() >= 8, "a card per list, in a wide dialog");
    await shot(boss, "list-settings-form");
    assert(!(await boss.isVisible("#spec-json")), "the JSON is behind Advanced");
    const pastries = boss.locator('.ls-card[data-ls-key="pastries"]');
    assert(await pastries.locator('[data-ls-cap="line"]').isDisabled(), "a box's most is off until it's ticked");
    await pastries.locator('[data-ls-field="line"]').check();
    await pastries.locator('[data-ls-cap="line"]').fill("40");
    await boss.locator('.ls-card[data-ls-key="take-home"] [data-ls-sw="schedule"]').check();
    await boss.locator('.ls-card[data-ls-key="take-home"] [data-ls="hint"]').fill("Gifts and things to carry out");
    await boss.locator('.ls-card[data-ls-key="coffee"] [data-ls-field="price"]').uncheck();
    await boss.click("#dlg-ok"); await boss.waitForTimeout(800);
    assert(/doesn't fit these settings.*Coffee bar.*no price box/.test(await boss.textContent("#dlg-error")), await boss.textContent("#dlg-error"));
    await boss.locator('.ls-card[data-ls-key="coffee"] [data-ls-field="price"]').check();
    await boss.click("#dlg-ok"); await boss.waitForTimeout(1200);
    const m = await theMenu(), P = m.spec.lists.find((x) => x.key === "pastries"), T = m.spec.lists.find((x) => x.key === "take-home");
    assert(P.fields.includes("line") && P.caps.line === 40 && T.schedule === true && T.hint === "Gifts and things to carry out", JSON.stringify([P, T]));
    await owner.goto(`${B}/menu-edit.html?m=${menuId}`); await owner.waitForTimeout(3000);
    assert(await owner.locator('.me-list[data-key="pastries"] input[data-f="line"]').count() > 0, "the customer gets the new box");
    assert((await owner.textContent('.me-list[data-key="take-home"]')).includes("Gifts and things to carry out") && await owner.locator('.me-list[data-key="take-home"] [data-when-toggle]').count() > 0, "the hint and When");
  });

  await check("the character count: shown near a box's limit, and at the limit it says why typing stops", async () => {
    const box = owner.locator('.me-list[data-key="energy"] .me-row[data-i="0"] input[data-f="name"]');
    const cap = Number(await box.getAttribute("maxlength"));
    await box.fill(""); await box.type("x".repeat(cap - 3));
    assert(await owner.isVisible(".me-chars") && (await owner.textContent(".me-chars")) === `${cap - 3} of ${cap}`, await owner.textContent(".me-chars"));
    const tip = await owner.locator(".me-chars").boundingBox();
    assert(tip && tip.y >= 0 && tip.y + tip.height <= 1000, `on screen: ${JSON.stringify(tip)}`);
    await box.type("xxxxxx");
    assert((await box.inputValue()).length === cap, "stops at the limit");
    assert((await owner.textContent(".me-chars")) === `${cap} of ${cap} · the most this box holds on the board` && await owner.locator(".me-chars.full").count() === 1, await owner.textContent(".me-chars"));
    await shot(owner, "menu-editor-chars");
    await box.fill("Blue Raspberry Bolt"); await owner.waitForTimeout(200);
    assert(await owner.isHidden(".me-chars"), "gone when well under");
    if (await owner.isEnabled("#undo")) { await owner.click("#undo"); await owner.waitForTimeout(400); }
  });

  // ── E2b (DP-12): WayTuGo to customers, specials with dates and times, showWhen, Preview full size, fit while typing, more lists ──
  const LISTS = JSON.parse(readFileSync(new URL("../layouts/donut-joes-counter-55-lists.json", import.meta.url), "utf8"));

  await check("E2b: customers see WayTuGo: the read-only banner, and 1Point's saves marked (WayTuGo) in History", async () => {
    await sb(`menus?id=eq.${menuId}`, { method: "PATCH", body: JSON.stringify({ customer_edit: false }) });
    await owner.reload(); await owner.waitForTimeout(2500);
    assert((await owner.textContent("#readonly")).trim() === "WayTuGo keeps this menu up to date for you. Contact WayTuGo for changes.", await owner.textContent("#readonly"));
    const hist = await owner.textContent("#history");
    assert(hist.includes("(WayTuGo)") && !hist.includes("(1Point)"), hist.slice(0, 300));
    await sb(`menus?id=eq.${menuId}`, { method: "PATCH", body: JSON.stringify({ customer_edit: true }) });
    await owner.goto(`${B}/console.html#menus`); await owner.waitForTimeout(1500);
    assert((await owner.textContent("#menu-rows")).includes("You and WayTuGo"), "the Menus tab");
  });

  await check("E2b: a list with dates: When in the editor (Ended …), saved; the board's fall box gives way to Take some home", async () => {
    const m = await theMenu();
    m.spec.lists.find((x) => x.key === "fall").schedule = true;
    assert((await sb(`menus?id=eq.${menuId}`, { method: "PATCH", body: JSON.stringify({ spec: m.spec }) })).status < 300, "spec");
    await sb("rpc/layout_publish", { method: "POST", body: JSON.stringify({ p_layout: counter.id, p_doc: LISTS, p_checks: {}, p_overridden: false, p_note: "E2b lists board", p_by: null }) });
    await owner.goto(`${B}/menu-edit.html?m=${menuId}`); await owner.waitForTimeout(3000);
    const fall = owner.locator('.me-list[data-key="fall"]');
    const n = await fall.locator(".me-row").count();
    for (let i = 0; i < n; i++) {
      await fall.locator(`.me-row[data-i="${i}"] [data-when-toggle]`).click(); await owner.waitForTimeout(150);
      await fall.locator(`.me-row[data-i="${i}"] [data-wf="dfrom"]`).fill("2026-09-15");
      await fall.locator(`.me-row[data-i="${i}"] [data-wf="dto"]`).fill("2026-10-01");
    }
    const sum = await fall.locator('.me-row[data-i="0"] .me-when-sum').textContent();
    assert(/Sep 15 – Oct 1/.test(sum) && /Ended Oct 1/.test(sum), sum);
    await shot(owner, "menu-editor-when");
    await owner.click("#save"); await owner.waitForTimeout(5000);
    assert(await owner.isHidden("#save-problems"), await owner.textContent("#save-problems"));
    assert((await listOf("fall")).entries.every((e) => e.when?.dates?.to === "2026-10-01"), JSON.stringify((await listOf("fall")).entries));
    const p = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await p.goto(`${B}/board.html?screen=${landscape.key}&view=1`); await p.waitForTimeout(3000);
    const vis = await p.evaluate(() => Object.fromEntries(["fall", "fall-pic", "take-home", "take-home-pic"].map((id) => [id, !document.querySelector(`[data-id="${id}"]`).hidden])));
    assert(!vis.fall && !vis["fall-pic"] && vis["take-home"] && vis["take-home-pic"], JSON.stringify(vis));
    await p.close();
  });

  await check("E2b: a special switches on by itself when its time comes (11:00), with no save", async () => {
    const m = await theMenu();
    m.content.lists.fall.entries.push({ id: "lunch1", name: "Lunch combo", price: "$8.99", when: { from: "11:00", to: "14:00" } });
    const p = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await p.clock.install({ time: new Date("2026-12-03T10:58:30-06:00") });
    await p.goto(`${B}/board.html?preview=1`); await p.waitForTimeout(500);
    await p.evaluate((d) => window.postMessage({ type: "layout-draft", data: d }, location.origin),
      { kind: "layout", key: "preview", orientation: "landscape", layout: { id: null, name: "x", version: null, doc: LISTS }, images: {}, menu: { url: "" }, lists: { spec: m.spec, content: m.content }, timezone: "America/Chicago", weather: { enabled: false }, poweredBy: true });
    await p.waitForTimeout(1500);
    const shown = () => p.evaluate(() => !document.querySelector('[data-id="fall"]').hidden && document.querySelector('[data-id="fall"]').textContent.includes("Lunch combo"));
    assert(!(await shown()), "not before 11");
    await p.clock.fastForward("02:00"); await p.waitForTimeout(1500);
    assert(await shown(), "on at 11");
    assert(await p.evaluate(() => document.querySelector('[data-id="take-home"]').hidden), "and Take some home steps aside");
    await p.close();
  });

  await check("E2b: Preview full size opens the board in its own window and follows the changes as they're typed", async () => {
    await owner.reload(); await owner.waitForTimeout(3000);
    const [pop] = await Promise.all([owner.context().waitForEvent("page"), owner.click("#full")]);
    await pop.waitForLoadState(); await pop.waitForTimeout(2500);
    assert((await pop.textContent('[data-id="coffee"]')).includes("Iced Chai"), "the board");
    await owner.locator('.me-list[data-key="coffee"] .me-row[data-i="6"] input[data-f="name"]').fill("Iced Chai Latte");
    await pop.waitForTimeout(2000);
    assert((await pop.textContent('[data-id="coffee"]')).includes("Iced Chai Latte"), "follows the typing");
    await shot(pop, "preview-full-size");
    await pop.close();
    await owner.click("#undo"); await owner.waitForTimeout(500);
  });

  await check("E2b: fit while typing: a list that won't fit on a board is marked at once, before Save, and clears when fixed", async () => {
    const rows = owner.locator('.me-list[data-key="pastries"] .me-row');
    for (let i = 0; i < 6; i++) await rows.nth(i).locator('input[data-f="name"]').fill(`An extremely long pastry name ${i} that goes on and on for the whole box`);
    await owner.waitForTimeout(4000);
    const sec = owner.locator('.me-list[data-key="pastries"]');
    assert(await sec.evaluate((x) => x.classList.contains("nofit")), "marked");
    assert((await sec.locator(".me-nofit").textContent()).includes("Doesn't fit on Counter board"), await sec.locator(".me-nofit").textContent());
    await shot(owner, "menu-editor-nofit");
    await owner.click("#undo"); await owner.waitForTimeout(4000);
    assert(!(await sec.evaluate((x) => x.classList.contains("nofit"))), "cleared");
  });

  await check("sold out today takes no room (Scot): every item of the tightest lists ticked sold out still fits, at the same size", async () => {
    await owner.goto(`${B}/menu-edit.html?m=${menuId}&fresh=${Date.now()}`); await owner.waitForTimeout(3500);
    const size = () => owner.frameLocator("#pv").locator("body").evaluate(() => JSON.stringify(["pastries", "fall", "coffee"].map((k) => {
      const el = document.querySelector(`[data-id="${k}"] .item-name`), list = document.querySelector(`[data-id="${k}"] .items-list`);
      return el && list ? [k, getComputedStyle(el).fontSize, list.scrollHeight] : [k, null];
    })));
    // the fall box as on Scot's board: three items in a small box
    const fall = owner.locator('.me-list[data-key="fall"]');
    const want = [["Pumpkin Spice Cake", "$1.89"], ["Caramel Apple", "$1.89"], ["Pumpkin Spice Latte", "$4.99"]];
    while (await fall.locator(".me-row").count() < 3) await fall.locator("[data-add]").click();
    for (const [i, [n, pr]] of want.entries()) { await fall.locator(`.me-row[data-i="${i}"] input[data-f="name"]`).fill(n); await fall.locator(`.me-row[data-i="${i}"] input[data-f="price"]`).fill(pr); }
    await owner.waitForTimeout(4500);
    assert(!(await owner.$$eval(".me-list.nofit", (xs) => xs.length)), "fits before ticking");
    const before = await size();
    for (const key of ["pastries", "fall", "coffee"]) {
      const boxes = owner.locator(`.me-list[data-key="${key}"] [data-sw="sold"]`);
      for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check();
    }
    await owner.waitForTimeout(4500);
    const marked = await owner.$$eval(".me-list.nofit", (xs) => xs.map((x) => x.dataset.key));
    assert(!marked.length, `marked as not fitting: ${marked}`);
    assert(await size() === before, `the size changed: ${before} -> ${await size()}`);
    // nothing is added beside the name (that's what wrapped "Pumpkin Spice Cake" onto a second line in a narrow box)
    const r = await owner.frameLocator("#pv").locator('[data-id="pastries"] .item.sold').first().evaluate((li) => {
      const row = li.querySelector(".item-row").getBoundingClientRect(), mark = li.querySelector(".sold-mark").getBoundingClientRect();
      const ms = getComputedStyle(li.querySelector(".sold-mark")), price = li.querySelector(".item-price");
      return { solid: ms.backgroundColor === "rgb(200, 16, 46)" && ms.opacity === "1", priceHidden: !price || getComputedStyle(price).visibility === "hidden",
        inline: li.querySelectorAll(".item-name .tag.sold-out").length, inside: mark.left >= row.left - 1 && mark.right <= row.right + 1, oneLine: li.querySelector(".item-row").offsetHeight < 2.2 * parseFloat(getComputedStyle(li).fontSize) };
    });
    assert(r.solid && r.priceHidden && !r.inline && r.inside && r.oneLine, JSON.stringify(r));   // 2.21.1: solid red, the price under it hidden
    await shot(owner, "menu-editor-all-sold-out");
    await owner.click("#undo"); await owner.waitForTimeout(1500);
  });
  // ── Customers' own pictures (E2c) ──
  copyFileSync(new URL("./fixtures/picture.jpg", import.meta.url), join(picDir, "Pumpkin Spice.jpg"));
  copyFileSync(new URL("./fixtures/picture.png", import.meta.url), join(picDir, "Spare one.png"));
  copyFileSync(new URL("./fixtures/picture.webp", import.meta.url), join(picDir, "Apple Cider.webp"));
  const picRows = async () => (await sb(`layout_images?org_id=eq.${home.org_id}&select=id,key,name,path`)).data;
  await check("E2c: Your pictures: the owner uploads (shrunk to WebP), N of 100, each says whether it's on the boards", async () => {
    await owner.goto(`${B}/menu-edit.html?m=${menuId}&fresh=${Date.now()}`); await owner.waitForTimeout(3000);
    const n0 = (await picRows()).length;
    assert((await owner.textContent("#pics-count")).includes(`${n0} of 100`), await owner.textContent("#pics-count"));
    await owner.setInputFiles("#pics-file", [join(picDir, "Pumpkin Spice.jpg"), join(picDir, "Spare one.png")]);
    await owner.waitForFunction(() => /2 uploaded/.test(document.getElementById("pics-progress").textContent), null, { timeout: 15000 });
    const rows = await picRows();
    const ps = rows.find((r) => r.key === "pumpkin-spice"), sp = rows.find((r) => r.key === "spare-one");
    assert(ps && sp && /\.webp$/.test(ps.path), JSON.stringify(rows.map((r) => r.key)));
    assert((await owner.textContent("#pics-count")).includes(`${n0 + 2} of 100`), "count follows");
    const card = owner.locator(`.my-pic[data-id="${ps.id}"]`);
    assert((await card.textContent()).includes("Not on the boards") && await card.locator("[data-pic-remove]").count() === 1, await card.textContent());
    const onBoard = (await theMenu()).content.lists.hero.entries[0].image.slice(4);
    const used = owner.locator(`.my-pic[data-id="${rows.find((r) => r.key === onBoard).id}"]`);
    assert((await used.textContent()).includes("On the boards now") && await used.locator("[data-pic-remove]").count() === 0, "one on the boards has no Remove");
    await shot(owner, "menu-editor-pictures");
  });
  await check("E2c: the picker: thumbnails, find by name, choose; Save puts it on the board; Rename keeps what the menu says", async () => {
    const hero = owner.locator('.me-list[data-key="hero"]');
    await hero.locator('.me-row[data-i="0"] [data-pick]').click();
    assert(await owner.isVisible("#pic-dialog"), "the picker opens");
    await owner.fill("#pic-search", "pumpk");
    const found = await owner.locator("#pic-choices [data-choose]").evaluateAll((bs) => bs.map((x) => x.dataset.choose));
    assert(found.includes("pumpkin-spice") && found.every((k) => k.startsWith("pumpkin")), `found by name: ${found}`);
    await shot(owner, "menu-editor-picker");
    await owner.click('#pic-choices [data-choose="pumpkin-spice"]');
    assert(!(await owner.isVisible("#pic-dialog")), "closed");
    assert((await hero.locator('.me-row[data-i="0"] .me-pic-name').textContent()).includes("Pumpkin Spice"), "shown on the row");
    await owner.click("#save"); await owner.waitForTimeout(4000);
    assert(await owner.isHidden("#save-problems"), await owner.textContent("#save-problems"));
    assert((await theMenu()).content.lists.hero.entries[0].image === "img:pumpkin-spice", "saved");
    const ps = (await picRows()).find((r) => r.key === "pumpkin-spice");
    await owner.locator(`.my-pic[data-id="${ps.id}"] [data-pic-rename]`).click();
    await owner.fill(".my-pic-in", "Pumpkin spice (fall)"); await owner.keyboard.press("Enter"); await owner.waitForTimeout(1200);
    assert((await picRows()).find((r) => r.id === ps.id).name === "Pumpkin spice (fall)", "renamed");
    assert((await owner.locator(`.my-pic[data-id="${ps.id}"]`).textContent()).includes("On the boards now"), "still on the boards");
  });
  await check("E2c: Upload a new picture from the picker chooses it; removing one checks it's gone from storage; one on the boards can't go", async () => {
    const hero = owner.locator('.me-list[data-key="hero"]');
    await hero.locator('.me-row[data-i="0"] [data-pick]').click();
    await owner.setInputFiles("#pic-dlg-file", join(picDir, "Apple Cider.webp"));
    await owner.waitForFunction(() => !document.getElementById("pic-dialog").open, null, { timeout: 15000 });
    assert((await hero.locator('.me-row[data-i="0"] .me-pic-name').textContent()).includes("Apple Cider"), "the new one is chosen");
    await owner.click("#save"); await owner.waitForTimeout(4000);
    assert((await theMenu()).content.lists.hero.entries[0].image === "img:apple-cider", "saved");
    // the spare: never used; removed, and its file is gone
    const sp = (await picRows()).find((r) => r.key === "spare-one");
    assert((await fetch(`${B}/img/${sp.path}`)).status === 200, "the file is there first");
    await owner.locator(`.my-pic[data-id="${sp.id}"] [data-pic-remove]`).click(); await owner.waitForTimeout(1500);
    assert((await owner.textContent(".toast")).includes("Checked: it's gone from storage"), await owner.textContent(".toast"));
    assert(!(await picRows()).some((r) => r.id === sp.id) && (await fetch(`${B}/img/${sp.path}`)).status === 404, "row and file gone");
    // the one on the boards: refused by the site too
    const ac = (await picRows()).find((r) => r.key === "apple-cider");
    const err = await owner.evaluate(async (id) => { try { await Auth.api("/api/pictures", { method: "POST", body: { action: "delete", id } }); return "removed"; } catch (e) { return e.message; } }, ac.id);
    assert(/is on the boards now/.test(err), err);
  });
  await check("E2c: a picture only an old save used can go; Restoring that save brings the item back without it, and says so", async () => {
    const ps = (await picRows()).find((r) => r.key === "pumpkin-spice");
    await owner.reload(); await owner.waitForTimeout(3000);
    const card = owner.locator(`.my-pic[data-id="${ps.id}"]`);
    assert((await card.textContent()).includes("Not on the boards"), await card.textContent());
    await card.locator("[data-pic-remove]").click(); await owner.waitForTimeout(1500);
    assert(!(await picRows()).some((r) => r.id === ps.id) && (await fetch(`${B}/img/${ps.path}`)).status === 404, "removed");
    const revs = (await sb(`menu_revisions?menu_id=eq.${menuId}&select=rev,content&order=rev.desc`)).data;
    const old = revs.find((r) => r.content.lists.hero?.entries[0]?.image === "img:pumpkin-spice");
    await owner.click(`[data-restore="${old.rev}"]`); await owner.waitForTimeout(2500);
    assert(/came back without a picture, because its picture was removed since/.test(await owner.textContent(".toast")), await owner.textContent(".toast"));
    const e0 = (await theMenu()).content.lists.hero.entries[0];
    assert(!e0.image, JSON.stringify(e0));
    assert((await owner.locator('.me-list[data-key="hero"] .me-row[data-i="0"] [data-pick]').textContent()).includes("Choose"), "the row offers Choose…");
    // put a picture back, as it was
    await owner.locator('.me-list[data-key="hero"] .me-row[data-i="0"] [data-pick]').click();
    await owner.click('#pic-choices [data-choose="apple-cider"]'); await owner.click("#save"); await owner.waitForTimeout(4000);
  });
  await check("E2c: Accounts (1Point): room for pictures, and Check storage compares the account's files with its pictures", async () => {
    await boss.goto(`${B}/console.html?fresh=${Date.now()}#accounts`); await boss.waitForTimeout(1500);
    await boss.click(`[data-edit-org="${home.org_id}"]`); await boss.waitForTimeout(500);
    assert(await boss.inputValue("#a-pics") === "100", "room shown");
    await boss.click("#a-check"); await boss.waitForTimeout(1500);
    const out = await boss.textContent("#a-check-out");
    assert(/\d+ pictures?, \d+ files? in storage\./.test(out) && /Missing files?/.test(out), out);   // the seeded pictures have no files
    await shot(boss, "accounts-check-storage");
    await boss.fill("#a-pics", "150"); await boss.click("#dlg-ok"); await boss.waitForTimeout(1200);
    assert((await sb(`organizations?id=eq.${home.org_id}&select=picture_room`)).data[0].picture_room === 150, "saved");
  });
  await check("E2b: Add lists from this layout (1Point): a second board on the same menu; a key already there gets -2", async () => {
    const [chalk] = (await sb("layouts", { method: "POST", body: JSON.stringify({ org_id: home.org_id, name: "Chalkboard check", family: "menu", orientation: "portrait" }) })).data;
    await boss.goto(`${B}/console.html?fresh=${Date.now()}#layouts`); await boss.waitForTimeout(1500);   // a new address, so the page reloads
    await boss.click(`[data-open-layout="${chalk.id}"]`); await boss.waitForTimeout(900);
    await boss.selectOption("#menu-pick", menuId); await boss.click("#menu-use"); await boss.waitForTimeout(1200);
    await boss.fill("#layout-json", JSON.stringify({ format: 1, orientation: "portrait", grid: { cols: 12, rows: 24 }, blocks: [
      { id: "donuts", type: "items", at: { col: 1, row: 1, w: 12, h: 8 }, content: { heading: "Today", items: [{ name: "Glazed" }, { name: "Maple" }] } }] }));
    await boss.click("#menu-make"); await boss.waitForTimeout(1200);
    assert((await boss.textContent("#dlg-title")).startsWith("Add lists to"), await boss.textContent("#dlg-title"));
    await boss.click("#dlg-ok"); await boss.waitForTimeout(1500);
    const m = await theMenu();
    assert(m.spec.lists.some((x) => x.key === "donuts-2") && m.content.lists["donuts-2"].entries.length === 2, m.spec.lists.map((x) => x.key).join());
    const [l] = (await sb(`layouts?id=eq.${chalk.id}&select=menu_id,draft`)).data;
    assert(l.menu_id === menuId && l.draft.blocks[0].content.list === "donuts-2", JSON.stringify(l.draft.blocks[0].content));
  });
  // ── E2d (DP-13): the Donut Joe's 32" portrait chalkboard on the counter board's menu ──
  const [chalkLay] = (await sb("layouts", { method: "POST", body: JSON.stringify({ org_id: home.org_id, name: "Donut Joe's chalkboard", family: "menu", orientation: "portrait" }) })).data;
  const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
  const CH = { white: "#f3f1e8", yellow: "#f6dd6b", pink: "#f4a7c1", blue: "#9fd3f0", green: "#a9df9c", orange: "#f6b46a" };
  const boardPage = async (extra = "&view=1") => { const p = await browser.newPage({ viewport: { width: 540, height: 960 } }); await p.goto(`${B}/board.html?screen=${portrait.key}${extra}`); await p.waitForTimeout(3000); return p; };

  await check("E2d: the chalkboard in the console: Use this menu, Add lists (Today's specials room 6, the chalk note), step 2 checks clean on the menu, published", async () => {
    await boss.goto(`${B}/console.html?fresh=${Date.now()}#layouts`); await boss.waitForTimeout(1500);
    await boss.click(`[data-open-layout="${chalkLay.id}"]`); await boss.waitForTimeout(900);
    await boss.selectOption("#menu-pick", menuId); await boss.click("#menu-use"); await boss.waitForTimeout(1200);
    await boss.fill("#layout-json", JSON.stringify(CHALK1, null, 2));
    await boss.click("#menu-make"); await boss.waitForTimeout(1200);
    const offered = await boss.$$eval("[data-mk]", (xs) => xs.map((x) => x.dataset.mk));
    assert(offered.join() === "specials,note", `offered ${offered}`);
    await boss.fill('[data-room="specials"]', "6");
    await boss.click("#dlg-ok"); await boss.waitForTimeout(1500);
    const m = await theMenu();
    assert(m.spec.lists.find((x) => x.key === "specials")?.room === 6 && m.content.lists.note.entries[0].title === "Made fresh every morning since 2009", m.spec.lists.map((x) => x.key).join());
    await boss.fill("#layout-json", JSON.stringify(CHALK2, null, 2));
    await boss.click("#layout-check"); await boss.waitForTimeout(800);
    const res = await boss.textContent("#layout-results");
    assert(/No problems/.test(res), res);
    await boss.click("#layout-publish"); await boss.waitForTimeout(1500);
    if (await boss.isVisible("#layout-anyway")) { await boss.click("#layout-anyway"); await boss.waitForTimeout(1500); }
    const [l] = (await sb(`layouts?id=eq.${chalkLay.id}&select=published_version`)).data;
    assert(l.published_version === 1, JSON.stringify(l));
    await sb(`screens?id=eq.${portrait.id}`, { method: "PATCH", body: JSON.stringify({ directory_id: null, layout_id: chalkLay.id, property_id: home.id }) });
  });

  await check("E2d: the screen draws the Chalkboard look: slate, chalk colours for titles and prices, Pacifico and Bebas Neue, the grain on the lettering, no frame, nothing overflowing", async () => {
    const p = await boardPage();
    const r = await p.evaluate(() => {
      const g = (sel) => document.querySelector(sel), cs = (sel) => getComputedStyle(g(sel));
      return { chalk: g("#stage").classList.contains("look-chalk"), framed: g("#stage").classList.contains("framed"), bg: cs(".board").backgroundImage + cs(".board").backgroundColor,
        head: cs('[data-id="specials"] .items-head').color, price: cs('[data-id="specials"] .item-price').color, mask: cs('[data-id="specials"] .b-in').maskImage || cs('[data-id="specials"] .b-in').webkitMaskImage,
        photoMask: cs('[data-id="hero"] .b-in').maskImage || "none", pac: document.fonts.check('40px "Pacifico"'), bebas: document.fonts.check('40px "Bebas Neue"'),
        item: cs('[data-id="specials"] .item-name').fontFamily, coffee: g('[data-id="coffee"]').hidden, specials: g('[data-id="specials"]').hidden, over: window.LayoutBoard.fitAll().overflow };
    });
    assert(r.chalk && !r.framed && r.bg.includes("rgb(42, 50, 48)"), JSON.stringify(r));
    assert(r.head === rgb(CH.yellow) && r.price === rgb(CH.pink), `${r.head} ${r.price}`);
    assert(/^url\(/.test(r.mask) && r.photoMask === "none", `grain ${String(r.mask).slice(0, 30)} / ${r.photoMask}`);
    assert(r.pac && r.bebas && /Bebas Neue/.test(r.item), JSON.stringify(r));
    assert(r.coffee && !r.specials, "the coffee bar off by default");
    assert(r.over.length === 0, `overflow ${r.over}`);
    await shot(p, "chalkboard"); await p.close();
  });

  await check("E2d: the owner's Board look in the menu editor: House, Chalkboard, chalk colours, lettering, frame, the coffee bar; the preview follows; Save goes live, in History", async () => {
    await owner.goto(`${B}/menu-edit.html?m=${menuId}`); await owner.waitForTimeout(3500);
    const look = owner.locator(`.me-look[data-board="${chalkLay.id}"]`);
    assert(await look.isVisible(), "a Board look panel for the chalkboard");
    assert(await owner.locator(".me-look").count() === 1, "only for a board that offers choices (not the counter board)");
    const pvStage = async () => owner.frameLocator("#pv").locator("#stage").getAttribute("class");
    await look.locator('input[data-look-f="look"][value="house"]').check(); await owner.waitForTimeout(1800);
    assert(await owner.inputValue("#board-pick") === chalkLay.id, "the preview turns to the board being changed");
    assert(!/look-chalk/.test(await pvStage()), "House in the preview");
    assert(await look.locator('[data-look-f="chalk"]').count() === 0, "no chalk colours on House");
    await look.locator('input[data-look-f="look"][value="chalkboard"]').check(); await owner.waitForTimeout(500);
    await owner.locator(`input[name="chalk-titles:${chalkLay.id}"][value="green"]`).check({ force: true }); await owner.waitForTimeout(300);
    await owner.locator(`input[name="chalk-prices:${chalkLay.id}"][value="orange"]`).check({ force: true }); await owner.waitForTimeout(300);
    await owner.locator(`.me-look input[data-look-f="lettering"][value="hand"]`).check(); await owner.waitForTimeout(300);
    await owner.locator('.me-look input[data-look-f="frame"]').check(); await owner.waitForTimeout(300);
    await owner.locator('.me-look input[data-opt="coffee-bar"]').check(); await owner.waitForTimeout(2000);
    const st = await pvStage();
    assert(/look-chalk/.test(st) && /framed/.test(st) && /lettering-hand/.test(st), st);
    const coffee = await owner.frameLocator("#pv").locator('[data-id="coffee"]').isVisible();
    const head = await owner.frameLocator("#pv").locator('[data-id="specials-coffee"] .items-head').evaluate((e) => getComputedStyle(e).color);
    assert(coffee && head === rgb(CH.green), `coffee ${coffee}, titles ${head}`);
    await shot(owner, "board-look");
    await owner.click("#save"); await owner.waitForTimeout(3500);
    const m = await theMenu();
    assert(JSON.stringify(m.content.boards?.[chalkLay.id]) === JSON.stringify({ look: "chalkboard", chalk: { titles: "green", prices: "orange" }, lettering: "hand", frame: true, options: { "coffee-bar": true } }), JSON.stringify(m.content.boards));
    const hist = await owner.textContent("#history");
    assert(hist.includes("Board look (Donut Joe's chalkboard): titles chalk (as designed) → green") && hist.includes("coffee bar (as designed) → on"), hist.slice(0, 400));
    const p = await boardPage();
    const r = await p.evaluate(() => ({ framed: document.querySelector("#stage").classList.contains("framed"), coffee: !document.querySelector('[data-id="coffee"]').hidden,
      caveat: document.fonts.check('40px "Caveat Brush"'), price: getComputedStyle(document.querySelector('[data-id="specials-coffee"] .item-price')).color, over: window.LayoutBoard.fitAll().overflow }));
    assert(r.framed && r.coffee && r.caveat && r.price === rgb(CH.orange) && !r.over.length, JSON.stringify(r));
    await shot(p, "chalkboard-chosen"); await p.close();
    // Back to WayTuGo's design: the layout's own again (unsaved until Save)
    await owner.click("[data-look-reset]"); await owner.waitForTimeout(1500);
    assert(!/framed/.test(await pvStage()) && !(await owner.isDisabled("#save")), "back to the design, waiting for Save");
    await owner.click("#undo"); await owner.waitForTimeout(800);
  });

  await check("E2d (Scot): SOLD OUT on a name that wraps sits beside its last line, not across both", async () => {
    const m = await theMenu(), today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const capWas = m.spec.lists.find((x) => x.key === "specials").caps?.name;
    m.spec.lists.find((x) => x.key === "specials").caps = { ...(m.spec.lists.find((x) => x.key === "specials").caps || {}), name: 60 };   // room for a long name
    await sb(`menus?id=eq.${menuId}`, { method: "PATCH", body: JSON.stringify({ spec: m.spec }) });
    const e = m.content.lists.specials.entries[1];
    const was = { name: e.name, soldOut: e.soldOut };
    Object.assign(e, { name: "Pumpkin Spice Cake with Cream Cheese Icing", soldOut: today });
    await sb(`menus?id=eq.${menuId}`, { method: "PATCH", body: JSON.stringify({ content: m.content }) });
    try {
      for (const look of ["chalkboard", "house"]) {
        const mm = await theMenu(); mm.content.boards[chalkLay.id].look = look;
        await sb(`menus?id=eq.${menuId}`, { method: "PATCH", body: JSON.stringify({ content: mm.content }) });
        const p = await boardPage();
        const r = await p.evaluate(() => {
          const row = document.querySelector('[data-id="specials-coffee"] .item.sold .item-row');
          const range = document.createRange(); range.selectNodeContents(row.querySelector(".item-name"));
          const lines = [...range.getClientRects()].filter((x) => x.width > 2);
          const mark = row.querySelector(".sold-mark").getBoundingClientRect();
          const first = lines[0], last = lines[lines.length - 1];
          return { n: new Set(lines.map((x) => Math.round(x.top))).size, markMid: mark.top + mark.height / 2, lastMid: last.top + last.height / 2, firstBottom: first.bottom, lh: last.height };
        });
        assert(r.n >= 2, `${look}: the name should wrap (${r.n} line)`);
        assert(Math.abs(r.markMid - r.lastMid) < r.lh * 0.35 && r.markMid > r.firstBottom, `${look}: ${JSON.stringify(r)}`);
        await p.close();
      }
    } finally {
      const mm = await theMenu(); Object.assign(mm.content.lists.specials.entries[1], was); if (!was.soldOut) delete mm.content.lists.specials.entries[1].soldOut;
      mm.content.boards[chalkLay.id].look = "chalkboard";
      await sb(`menus?id=eq.${menuId}`, { method: "PATCH", body: JSON.stringify({ content: mm.content }) });
      const ms = await theMenu(); ms.spec.lists.find((x) => x.key === "specials").caps.name = capWas;
      await sb(`menus?id=eq.${menuId}`, { method: "PATCH", body: JSON.stringify({ spec: ms.spec }) });
    }
  });

  await check("E2d: the chalk texture's speed: a real screen measures its draw and frame rate (CPU slowed 6x): the grain stays on; on a Pi whose frames run slow, it's dropped and the screen says so", async () => {
    const run = async (rate, slowFrames) => {
      const ctx = await browser.newContext({ viewport: { width: 540, height: 960 } });
      // a slow Pi: every frame about 60 ms apart (16 a second)
      if (slowFrames) await ctx.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (f) => raf((t) => setTimeout(() => f(performance.now()), 60)); });
      const p = await ctx.newPage();
      const cdp = await ctx.newCDPSession(p);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
      await p.goto(`${B}/board.html?screen=${portrait.key}`);
      await p.waitForFunction(() => window.LayoutBoard?.report?.fps != null, null, { timeout: 90000 });
      const r = await p.evaluate(() => ({ ...window.LayoutBoard.report, cls: document.querySelector("#stage").className }));
      await ctx.close(); return r;
    };
    const ok = await run(6, false);
    assert(ok.look === "chalkboard" && ok.grain === "on" && ok.fps >= 25 && ok.ms > 0 && !/no-grain/.test(ok.cls) && Array.isArray(ok.overflow), JSON.stringify(ok));
    const slow = await run(1, true);
    assert(slow.fps < 25 && slow.grain === "dropped" && /no-grain/.test(slow.cls), JSON.stringify(slow));
    console.log(`       measured: CPU 6x slower: drawn in ${ok.ms} ms, ${ok.fps} fps, grain on; slow frames: ${slow.fps} fps, grain dropped`);
  });

  await sb(`screens?id=eq.${portrait.id}`, { method: "PATCH", body: JSON.stringify({ layout_id: lay.id, property_id: home.id }) });

  await owner.close(); await boss.close();
  await sb(`screens?id=eq.${landscape.id}`, { method: "PATCH", body: JSON.stringify({ layout_id: null, property_id: null, directory_id: landscape.directory_id }) });
  void otherOrg;
} finally {
  await browser.close();
  srv.kill(); old?.kill();
}
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
