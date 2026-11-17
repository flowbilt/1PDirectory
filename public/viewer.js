// "See Your WayTuGo in Action" (DP-14, V1): the viewer waytugo.com embeds. The visitor's choices draw the real
// directory screen (index.html?preview=1) with invented content (viewer-sample.mjs). Once they've built something,
// the visit is kept without a name (/api/viewer); "Request a Quote" hands the configuration to the page that embeds
// this one, whose own inquiry form sends it. Messages to that page (only to WayTuGo's and 1Point's sites):
//   { source: "waytugo-viewer", type: "height", px }                  the page's height, to size the frame
//   { source: "waytugo-viewer", type: "event", name, kind }           viewer_start, viewer_type_selected,
//                                                                     viewer_preview_shown, viewer_quote_started
//   { source: "waytugo-viewer", type: "quote", visit, code, summary, config }
// and from it: { source: "waytugo-site", type: "quote-sent", visit }   its form was sent (kept with the visit)
//
// V5 (DP-15, Scot's "Full-Screen Preview, Save/Share & Engagement Tracking"):
//   * the visit is kept from the moment the page loads (viewer.html's first script makes it, and its code and counts
//     stay in this tab's storage, so a reload carries on the same visit), with what happened (VISIT_EVENTS), counted;
//   * an edit counts once per control the visitor actually changed, when they finish with it ("change", not each key);
//   * See My Directory / See My Menu Board: the screen full size, with Request a Quote, Save / Share and Back to Viewer;
//     the choices are kept as a snapshot each time it opens; Save / Share makes a PNG here (viewer-snap.mjs);
//   * more messages to the page:
//   { source: "waytugo-viewer", type: "event", name, kind }   also viewer_initialized, configuration_edited (the first),
//        full_preview_opened/closed, directory_image_downloaded, directory_share_initiated/completed,
//        quote_form_opened, quote_submitted
//   { source: "waytugo-viewer", type: "full", open }           please make the frame fill the window (or put it back)
//   and from it: { source: "waytugo-site", type: "full-ready" } done (the frame fills the window)
import { normalizeConfig, sampleDirectory, sampleRows, summary, typeSamples, menuDraft, menuRows, imageName, KINDS, LIMITS, SLIDER_MAX, MENU_LOOKS } from "/viewer-sample.mjs";
import { makePicture } from "/viewer-snap.mjs";

const $ = (id) => document.getElementById(id);
const form = $("controls"), frame = $("pv"), box = $("screen");
const ALLOWED = [/^https:\/\/(www\.)?waytugo\.com$/, /^https:\/\/(www\.)?1pointusa\.com$/, /^https:\/\/[a-z0-9-]+(--[a-z0-9-]+)?\.netlify\.app$/, /^http:\/\/localhost(:\d+)?$/];
const embedded = window.parent !== window;
const parentOrigin = (() => {
  if (!embedded) return null;
  const o = location.ancestorOrigins?.[0] || (() => { try { return new URL(document.referrer).origin; } catch { return ""; } })();
  return ALLOWED.some((re) => re.test(o)) ? o : null;
})();
const tell = (msg) => { if (parentOrigin) window.parent.postMessage({ source: "waytugo-viewer", ...msg }, parentOrigin); };

// The visit: its code, how long it's been looked at (while the page is showing), how much was changed. V5: made by
// viewer.html's first script as the page loads (window.__wtg), with its counts; kept in this tab's storage (S)
window.__wtgStarted = true;
const S = window.__wtg || { id: crypto.randomUUID(), t: Date.now(), ev: { viewer_page_loaded: 1 }, seconds: 0, changes: 0, quote: null, failures: 0, initMs: null };
const saveS = () => { try { sessionStorage.setItem("wtg-viewer-visit", JSON.stringify(S)); } catch { /* this tab only */ } };
const V = { id: S.id, shownSince: document.visibilityState === "visible" ? Date.now() : 0, seconds: S.seconds || 0, changes: S.changes || 0, quote: S.quote || null, kept: "", previewTold: false, inited: false, edited: false, touched: false };
const q = new URLSearchParams(location.search);
const source = Object.fromEntries(["page", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].map((k) => [k, (q.get(k) || "").slice(0, 200)]).filter(([, v]) => v));
const load = window.__wtgLoad || null;   // V5: the waytugo.com page load that opened this (its script says so)
const code = V.id.slice(0, 8).toUpperCase();
const seconds = () => Math.min(7200, Math.round(V.seconds + (V.shownSince ? (Date.now() - V.shownSince) / 1000 : 0)));
/** V5: something happened: counted with the visit, and (most) told to the page */
function ev(name, { page = true } = {}) {
  S.ev[name] = Math.min(10000, (S.ev[name] || 0) + 1); saveS();
  if (page) tell({ type: "event", name, kind: choices().kind });
}
/** V5: an edit: a control the visitor changed, counted once when they finish with it (the page hears of the first) */
function edited() { ev("configuration_edited", { page: !V.edited }); V.edited = true; V.touched = true; }

// V2: what the visitor typed over the sample tenants (kept for all 20, so a row comes back when the slider does), and
// their own logo and photo: in this page only, as pictures shrunk in the browser; never sent anywhere
const typed = Array.from({ length: SLIDER_MAX }, () => ({ name: "", suite: "" }));
const own = { logo: null, photo: null };   // { url, name }
// V5: the full-screen view: open, the frame filled by the page (true full screen or the page's own), the picture made
const F = { open: false, parentFull: false, native: false, visible: null, io: null, pic: null, file: null, url: "", making: null };

// V4: the menu board: WayTuGo's template shops and their boards (read live), the board drawn now, the items typed over
// its samples
const M = { templates: null, boards: new Map(), payload: null, typed: Array.from({ length: LIMITS.items }, () => ({ name: "", price: "" })) };
const boardOf = (id) => M.templates?.flatMap((t) => t.boards.map((b) => ({ ...b, shop: t.name }))).find((b) => b.id === id) || null;

function choices() {
  const f = new FormData(form), n = Number(f.get("tenants")), kind = f.get("kind");
  const pic = (k) => (!f.has(k) ? "off" : own[k] ? "own" : "sample");
  const menu = kind === "menu", b = menu ? boardOf(f.get("board") || "") : null;
  return normalizeConfig({ v: 2, kind, name: f.get("name"), subtitle: menu ? "" : f.get("subtitle"), tenants: n,
    // a menu board's shape is its own, unless it turns
    shape: menu && b && !b.turns ? b.orientation : f.get("shape"),
    weather: f.has("weather"), qr: f.has("qr"), places: f.has("places"), contacts: f.has("contacts"), news: f.has("news"),
    look: menu ? f.get("mlook") || b?.looks?.[0] || "house" : f.get("look"), logo: pic("logo"), photo: menu ? "off" : pic("photo"),
    rows: menu ? [] : typed.slice(0, n), type: f.get("type") || "",
    ...(menu ? { board: b?.id || "", items: M.typed.slice(0, $("items").children.length) } : {}) });
}

// ── V2: the tenant rows, one per tenant on the slider, the sample's name and suite as placeholders
const rowsEl = $("rows");
let rowsFor = "";
function renderRows() {
  const c = choices(), list = sampleRows({ ...c, rows: [] });
  // V3: a new location type changes only the placeholders; what the visitor typed stays as it is
  if (rowsEl.children.length === list.length && rowsFor === c.type) return;
  if (rowsEl.children.length === list.length) {
    list.forEach((r, i) => { const row = rowsEl.children[i]; row.children[0].placeholder = r.sample; row.children[1].placeholder = r.sampleSuite; });
    rowsFor = c.type; return;
  }
  rowsFor = c.type;
  rowsEl.innerHTML = list.map((r, i) => `<div class="vw-row" data-i="${i}">`
    + `<input data-row="name" maxlength="${LIMITS.name}" placeholder="${esc(r.sample)}" value="${esc(typed[i].name)}" aria-label="Tenant ${i + 1} name">`
    + `<input data-row="suite" maxlength="${LIMITS.suite}" placeholder="${esc(r.sampleSuite)}" value="${esc(typed[i].suite)}" aria-label="Tenant ${i + 1} suite"></div>`).join("");
}
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
rowsEl.addEventListener("input", (e) => {
  const i = Number(e.target.closest(".vw-row")?.dataset.i), k = e.target.dataset.row;
  if (Number.isInteger(i) && typed[i] && (k === "name" || k === "suite")) typed[i][k] = e.target.value;
  showReset();
});
const showReset = () => { $("rows-reset").hidden = !typed.some((r) => r.name || r.suite); };
$("rows-reset").addEventListener("click", () => {
  for (const r of typed) { r.name = ""; r.suite = ""; }
  for (const el of rowsEl.querySelectorAll("input")) el.value = "";
  showReset(); V.changes++; edited(); draw(); keep();
});

// ── V2: their own logo or building photo, shrunk here (a logo keeps its clear background) and kept in this page only
function shrink(file, maxW, keepClear) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const w = Math.min(maxW, img.naturalWidth || maxW), h = Math.round(((img.naturalHeight || maxW) * w) / (img.naturalWidth || maxW));
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
      resolve(cv.toDataURL(keepClear ? "image/png" : "image/jpeg", 0.86));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("not a picture")); };
    img.src = url;
  });
}
for (const box of document.querySelectorAll(".vw-pic")) {
  const k = box.dataset.pic, input = box.querySelector("input[type=file]"), tick = box.querySelector(`input[name="${k}"]`);
  const show = () => { box.querySelector(".vw-pic-name").textContent = own[k] ? own[k].name : ""; box.querySelector("[data-drop]").hidden = !own[k]; };
  box.querySelector("[data-own]").addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files?.[0]; input.value = "";
    if (!file) return;
    try { own[k] = { url: await shrink(file, k === "logo" ? 900 : 1600, k === "logo"), name: file.name.slice(0, 60) }; }
    catch { box.querySelector(".vw-pic-name").textContent = "That file isn't a picture we can show."; return; }
    tick.checked = true; show(); V.changes++; edited(); draw(); keep();
  });
  box.querySelector("[data-drop]").addEventListener("click", () => { own[k] = null; show(); V.changes++; edited(); draw(); keep(); });
}

// ── the preview: the screen at its real size (1920 × 1080 or 1080 × 1920), scaled to fit
function fit() {
  if (F.open) { layoutFull(); return; }   // V5: the full-screen view places the screen itself
  const c = choices(), land = c.shape === "landscape", W = land ? 1920 : 1080, H = land ? 1080 : 1920;
  // Embedded, the frame grows to fit this page, so its height can't size the preview (it would grow with it): the
  // visitor's own screen does, within 900 px
  const tall = embedded ? Math.min(window.screen?.availHeight || 900, 1100) : window.innerHeight;
  const avail = box.parentElement.clientWidth - 20, maxH = Math.min(900, Math.max(320, tall * (window.innerWidth <= 860 ? 0.62 : 0.8)));
  const s = Math.min(avail / W, maxH / H);
  box.style.width = `${Math.round(W * s)}px`; box.style.height = `${Math.round(H * s)}px`;
  box.style.marginLeft = box.style.marginRight = "auto";
  Object.assign(frame.style, { width: `${W}px`, height: `${H}px`, transform: `scale(${s})` });
}
let drawT = 0;
function draw() {
  clearTimeout(drawT);
  drawT = setTimeout(() => {
    const c = choices(), menu = c.kind === "menu";
    form.dataset.kind = c.kind;
    // the preview: the directory screen, or (V4) the board page
    const want = menu ? "/board.html?preview=1" : "/index.html?preview=1";
    if (frame.getAttribute("src") !== want) { frame.setAttribute("src", want); return; }   // drawn again when it's loaded
    if (menu) {
      const b = boardOf(c.board);
      $("shape-field").hidden = !!b && !b.turns;
      form.elements.name.placeholder = M.payload?.brand?.name ? `e.g. ${M.payload.brand.name}` : "e.g. Main Street Grill";
      $("hint").textContent = "A sample menu from WayTuGo: the items and prices are examples. Your board is made from your own menu.";
      fit();
      if (M.payload) frame.contentWindow?.postMessage({ type: "layout-draft", data: menuDraft(M.payload, c, { ownLogo: own.logo?.url || "" }) }, location.origin);
      seeLabel(c);
      if (V.changes > 0 && !V.previewTold) { V.previewTold = true; tell({ type: "event", name: "viewer_preview_shown", kind: c.kind }); }
      return;
    }
    $("shape-field").hidden = false;
    $("tenants-out").textContent = String(c.tenants);
    renderRows();
    const ts = typeSamples(c.type);   // V3: the name box's example follows the location type (only its placeholder)
    form.elements.name.placeholder = ts ? `e.g. ${ts.building.replace(/^Your /, "Sample ")}` : "e.g. Landmark Business Center";
    $("hint").textContent = c.kind === "touch" ? "It's live: tap a company for its card, or a letter to jump. Names, suites and phone numbers are invented." : "Names, suites and phone numbers are invented for this preview.";
    fit();
    frame.contentWindow?.postMessage({ type: "draft", data: sampleDirectory(c, { ownLogo: own.logo?.url || "", ownPhoto: own.photo?.url || "" }) }, location.origin);
    seeLabel(c);
    initialized();
    if (V.changes > 0 && !V.previewTold) { V.previewTold = true; tell({ type: "event", name: "viewer_preview_shown", kind: c.kind }); }
  }, 120);
}
frame.addEventListener("load", draw);
// V4: the board page says when it's ready for its board
window.addEventListener("message", (e) => { if (e.origin === location.origin && e.source === frame.contentWindow && e.data?.type === "layout-ready") draw(); });

// ── V4: the menu board ──
// V4b (Scot's templates: several shops' boards share one menu, "WayTuGo Templates: menu"): one dropdown of every
// template board, by the board's own name (1Point's), A to Z; its size and shape after it when the name doesn't say
async function loadTemplates() {
  if (M.templates) return;
  const sel = $("board");
  try {
    const r = await fetch("/api/viewer-boards"); if (!r.ok) throw new Error(String(r.status));
    M.templates = (await r.json()).templates.filter((t) => t.boards?.length);
  } catch { M.templates = null; sel.innerHTML = `<option value="">The sample menus aren't available right now</option>`; return; }
  const boards = M.templates.flatMap((t) => t.boards).sort((a, b) => a.name.localeCompare(b.name));
  if (!boards.length) { sel.innerHTML = `<option value="">No sample menus yet: ask us for one</option>`; return; }
  sel.innerHTML = boards.map((b) => `<option value="${esc(b.id)}">${esc(boardLabel(b))}</option>`).join("");
  boardChosen();
}
const boardLabel = (b) => {
  const name = b.name.replace(/^[^:]*:\s*/, ""), inches = Number(b.inches) && !new RegExp(`\\b${b.inches}\\b`).test(name) ? `${b.inches}″ ` : "";
  return `${name} · ${inches}${b.turns ? "landscape or portrait" : b.orientation}`;
};
async function boardChosen() {
  const b = boardOf($("board").value); if (!b) return;
  // its looks, as the template offers them (its first is how WayTuGo designed it)
  const was = new FormData(form).get("mlook");
  $("mlooks").style.setProperty("--n", String(b.looks.length));
  $("mlooks").innerHTML = b.looks.filter((l) => MENU_LOOKS[l]).map((l, i) => `<label><input type="radio" name="mlook" value="${l}"${(was ? was === l : i === 0) || (!b.looks.includes(was) && i === 0) ? " checked" : ""}><span>${MENU_LOOKS[l]}</span></label>`).join("");
  $("mlook-field").hidden = b.looks.length < 2;
  $("mlook-note").textContent = b.looks.includes("light") && b.looks.includes("dark") ? "A real board can change between them by itself at sunrise and sunset." : "";
  if (!M.boards.has(b.id)) {
    try { const r = await fetch(`/api/viewer-boards?board=${encodeURIComponent(b.id)}`); if (!r.ok) throw new Error(String(r.status)); M.boards.set(b.id, await r.json()); }
    catch { return; }
  }
  M.payload = M.boards.get(b.id);
  renderItems(); draw();
}
$("board").addEventListener("change", boardChosen);
// the items to type over: the board's main list's first ones, the samples as placeholders (what was typed stays)
function renderItems() {
  const list = menuRows(M.payload), box = $("items");
  box.innerHTML = list.map((r, i) => `<div class="vw-row" data-i="${i}">`
    + `<input data-item="name" maxlength="${LIMITS.item}" placeholder="${esc(r.name)}" value="${esc(M.typed[i].name)}" aria-label="Item ${i + 1}">`
    + `<input data-item="price" maxlength="${LIMITS.price}" placeholder="${esc(r.price || "price")}" value="${esc(M.typed[i].price)}" aria-label="Item ${i + 1} price"></div>`).join("");
  showItemsReset();
}
$("items").addEventListener("input", (e) => {
  const i = Number(e.target.closest(".vw-row")?.dataset.i), k = e.target.dataset.item;
  if (Number.isInteger(i) && M.typed[i] && (k === "name" || k === "price")) M.typed[i][k] = e.target.value;
  showItemsReset();
});
const showItemsReset = () => { $("items-reset").hidden = !M.typed.some((r) => r.name || r.price); };
$("items-reset").addEventListener("click", () => {
  for (const r of M.typed) { r.name = ""; r.price = ""; }
  for (const el of $("items").querySelectorAll("input")) el.value = "";
  showItemsReset(); V.changes++; edited(); draw(); keep();
});

// ── keeping the visit (V5: from the page's load; a few seconds after the last change; at once for what matters; and
// when the page is left). A send that fails is tried once more, then counted ("failures"), so 1Point can see it.
let keepT = 0, snapshot = null;
function body(extra = {}) {
  S.seconds = seconds(); S.changes = V.changes; S.quote = V.quote; saveS();
  // after a reload the form starts afresh: its choices are sent only once the visitor changes something again, so the
  // ones they built before the reload stay the visit's
  const fresh = (S.ev.viewer_page_loaded || 1) > 1 && !V.touched;
  return JSON.stringify({ id: V.id, config: fresh ? null : choices(), seconds: S.seconds, changes: V.changes, quote: V.quote, source, events: S.ev, failures: S.failures || 0,
    ...(S.initMs != null ? { init_ms: S.initMs } : {}), ...(load ? { load } : {}), ...extra });
}
function post(b, retry = true) {
  fetch("/api/viewer", { method: "POST", body: b, headers: { "Content-Type": "application/json" }, keepalive: b.length < 60000 })
    .then((r) => { if (!r.ok && r.status !== 413) throw new Error(String(r.status)); })
    .catch(() => {
      if (retry) { setTimeout(() => post(b, false), 3000); return; }
      S.failures = Math.min(10000, (S.failures || 0) + 1); saveS(); V.kept = "";   // said next time
    });
}
function keep(now = false) {
  clearTimeout(keepT);
  const send = () => {
    const extra = snapshot ? { snapshot } : {};
    const b = body(extra); if (b === V.kept) return; V.kept = b; snapshot = null; post(b);
  };
  if (now) send(); else keepT = setTimeout(send, 5000);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (V.shownSince) { V.seconds += (Date.now() - V.shownSince) / 1000; V.shownSince = 0; }
    const b = body(snapshot ? { snapshot } : {}); snapshot = null;
    if (b !== V.kept) { V.kept = b; if (!navigator.sendBeacon?.("/api/viewer", new Blob([b], { type: "application/json" }))) post(b, false); }
  } else V.shownSince = Date.now();
});
/** V5: the viewer has drawn its first preview: said at once (a visitor who leaves now still counts as having seen it) */
function initialized() {
  if (V.inited) return;
  V.inited = true;
  if (S.initMs == null) { S.initMs = Math.round(performance.now()); }
  ev("viewer_initialized");
  keep(true);
}

// V5: an edit counts when the visitor finishes with a control (a box when they leave it, a slider when they let go, a
// choice when it's made): "change" fires only when the value is really different
form.addEventListener("change", (e) => { if (e.target.type !== "file") { edited(); keep(); } });
form.addEventListener("input", (e) => {
  if (e.target.type === "file") return;
  V.changes++; V.touched = true;
  if (e.target.name === "kind") tell({ type: "event", name: "viewer_type_selected", kind: e.target.value });
  if (e.target.name === "kind" && e.target.value === "menu") loadTemplates();   // V4: the sample menus, the first time
  draw(); keep();
});
window.addEventListener("resize", fit);

// ── Request a Quote: the configuration to the page's own inquiry form (or, on its own, how to reach 1Point). V5: from
// the full-screen view too (it closes first). Opening the form isn't a quote: the page says when its form is sent.
function requestQuote() {
  const c = choices();
  if (V.quote !== "sent") V.quote = "started";
  V.touched = true; ev("quote_form_opened");
  keep(true);
  tell({ type: "event", name: "viewer_quote_started", kind: c.kind });
  const b = c.kind === "menu" ? boardOf(c.board) : null;   // V4: the summary names the sample board
  if (parentOrigin) tell({ type: "quote", visit: V.id, code, summary: summary(c, { boardName: b ? b.name.replace(/^[^:]*:\s*/, "") : "" }), config: c });
  else { $("code").textContent = code; $("direct").hidden = false; $("direct").scrollIntoView({ block: "center" }); }
}
$("quote").addEventListener("click", requestQuote);
window.addEventListener("message", (e) => {
  if (e.origin !== parentOrigin || e.data?.source !== "waytugo-site") return;
  if (e.data.type === "quote-sent" && e.data.visit === V.id) { V.quote = "sent"; ev("quote_submitted"); keep(true); }
  if (e.data.type === "full-ready" && F.open) { F.parentFull = true; layoutFull(); }   // V5: the frame fills the window
});

// ── V5: See My Directory / See My Menu Board: the screen full size, as a finished directory ──
// On its own (not embedded), the view fills this window. Embedded: true full screen where the browser and the page allow
// it (the page's iframe has allow="fullscreen"), otherwise the page is asked to make its frame fill the window
// ({type:"full"}; it answers "full-ready"); until it does (or if it never does), the view covers the part of the frame
// the visitor can see. iPhones and the Facebook and Instagram browsers have no full-screen mode for a page, so the
// page's own way is the one they get.
const seeLabel = (c) => {
  const menu = c.kind === "menu";
  $("see-label").textContent = menu ? "See My Menu Board" : "See My Directory";
  $("see-line").textContent = menu ? "View your menu board full screen." : "View your directory full screen.";
  $("full-title").textContent = menu ? "Your menu board · sample preview" : "Your directory · sample preview";
};
const dims = () => { const land = choices().shape === "landscape"; return { W: land ? 1920 : 1080, H: land ? 1080 : 1920 }; };
/** Where the view goes, in this page's window: all of it, or (embedded, before the page fills the window) the part of
 *  the frame the visitor can see now */
function stage() {
  const all = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  if (!embedded || F.parentFull || F.native) return all;
  const v = F.visible, want = Math.min(window.innerHeight, Math.max(360, (window.screen?.availHeight || 800) * 0.92));
  if (!v || v.height < 40) {   // not measured yet: around the button that was pressed
    const b = $("see").getBoundingClientRect(), top = Math.max(0, Math.min(window.innerHeight - want, b.top + b.height / 2 - want / 2));
    return { left: 0, top, width: window.innerWidth, height: want };
  }
  const h = Math.max(v.height, Math.min(want, window.innerHeight)), top = Math.max(0, Math.min(window.innerHeight - h, v.top + v.height - h));
  return { left: 0, top: v.height >= h ? v.top : top, width: window.innerWidth, height: h };
}
function layoutFull() {
  if (!F.open) return;
  const R = stage(), { W, H } = dims();
  for (const el of [$("full-bg"), $("full")]) Object.assign(el.style, { left: `${R.left}px`, top: `${R.top}px`, width: `${R.width}px`, height: `${R.height}px` });
  const topH = $("full").querySelector(".vw-full-top").offsetHeight, botH = $("full").querySelector(".vw-full-actions").offsetHeight;
  const area = { x: R.left + 12, y: R.top + topH + 6, w: R.width - 24, h: R.height - topH - botH - 12 };
  const s = Math.max(0.05, Math.min(area.w / W, area.h / H)), w = Math.round(W * s), h = Math.round(H * s);
  Object.assign(box.style, { left: `${Math.round(area.x + (area.w - w) / 2)}px`, top: `${Math.round(area.y + (area.h - h) / 2)}px`, width: `${w}px`, height: `${h}px`, marginLeft: "0", marginRight: "0" });
  Object.assign(frame.style, { width: `${W}px`, height: `${H}px`, transform: `scale(${s})` });
  // a landscape screen on an upright phone (or the other way) is small: say so
  const touch = matchMedia("(pointer: coarse)").matches, wrongWay = (W > H) !== (R.width > R.height);
  $("full-turn").hidden = !(touch && wrongWay && s < 0.4);
}
const outside = () => [document.querySelector(".vw-head"), form, document.querySelector(".vw-tag"), document.querySelector(".vw-see"), $("hint")].filter(Boolean);
async function openFull() {
  if (F.open) return;
  F.open = true; F.parentFull = false; F.native = false; F.visible = null;
  const c = choices();
  ev("full_preview_opened"); V.touched = true;
  snapshot = c; keep(true);   // the choices as they are now, kept with the visit
  for (const el of outside()) el.inert = true;
  document.documentElement.classList.add("vw-full-open");
  $("full-bg").hidden = false; $("full").hidden = false; box.classList.add("vw-screen-full");
  frame.tabIndex = 0;
  if (embedded) {
    // the part of the frame the visitor can see, as they scroll (until the page fills the window)
    F.io = new IntersectionObserver((es) => { const r = es[es.length - 1].intersectionRect; F.visible = { top: r.top, height: r.height }; layoutFull(); }, { threshold: Array.from({ length: 51 }, (_, i) => i / 50) });
    F.io.observe(document.body);
  }
  layoutFull();
  $("full-back").focus();
  // true full screen where it's allowed; otherwise the page's own (embedded)
  if (document.fullscreenEnabled && document.documentElement.requestFullscreen) {
    try { await document.documentElement.requestFullscreen({ navigationUI: "hide" }); F.native = true; layoutFull(); return; } catch { /* the page's way */ }
  }
  if (embedded && parentOrigin) tell({ type: "full", open: true });
}
function closeFull({ quiet = false } = {}) {
  if (!F.open) return;
  closeSheet();
  F.open = false;
  F.io?.disconnect(); F.io = null;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  if (embedded && parentOrigin && !F.native) tell({ type: "full", open: false });
  F.native = F.parentFull = false;
  for (const el of outside()) el.inert = false;
  document.documentElement.classList.remove("vw-full-open");
  $("full-bg").hidden = true; $("full").hidden = true; box.classList.remove("vw-screen-full");
  for (const k of ["left", "top"]) box.style[k] = "";
  frame.tabIndex = -1;
  if (!quiet) ev("full_preview_closed");
  keep();
  fit(); tellHeight();
  if (!quiet) $("see").focus();
}
$("see").addEventListener("click", openFull);
$("full-back").addEventListener("click", () => closeFull());
$("full-quote").addEventListener("click", () => { closeFull(); requestQuote(); });
document.addEventListener("fullscreenchange", () => { if (F.open && F.native && !document.fullscreenElement) closeFull(); });   // Esc in true full screen
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !F.open) return;
  if (!$("sheet").hidden) closeSheet(); else closeFull();
});
window.addEventListener("resize", () => { if (F.open) layoutFull(); });

// ── V5: Save / Share: a PNG of the screen as it shows now, made here (nothing uploaded); Download Image everywhere,
// Share where the device can share a picture. The visitor's own logo and photo are in it, as on their screen (Scot,
// 2026-11-16: "Agreed"); it goes only where they save or send it.
const SHARE_URL = "https://waytugo.com/waytugo-viewer?utm_source=viewer_share&utm_medium=share";
function sheetMsg(t, bad = false) { const m = $("sheet-msg"); m.textContent = t; m.classList.toggle("bad", bad); }
async function openSheet() {
  $("sheet").hidden = false;
  $("sheet-download").disabled = true; $("sheet-share").disabled = true; $("sheet-share").hidden = true;
  $("sheet").querySelector(".vw-sheet-actions").classList.add("one");
  if (F.url) { URL.revokeObjectURL(F.url); F.url = ""; } $("sheet-img").removeAttribute("src");
  sheetMsg("Making your picture…");
  $("sheet-close").focus();
  const c = choices(), { W, H } = dims();
  const making = F.making = (async () => makePicture(frame.contentDocument, W, H))();
  try {
    const blob = await making;
    if (F.making !== making || $("sheet").hidden) return;
    F.file = new File([blob], imageName(c.name || (c.kind === "menu" ? "menu-board" : "directory")), { type: "image/png" });
    F.url = URL.createObjectURL(blob); $("sheet-img").src = F.url;
    $("sheet-download").disabled = false;
    const canShare = !!(navigator.share && navigator.canShare?.({ files: [F.file] }));
    $("sheet-share").hidden = !canShare; $("sheet-share").disabled = !canShare;
    $("sheet").querySelector(".vw-sheet-actions").classList.toggle("one", !canShare);
    const touch = matchMedia("(pointer: coarse)").matches;
    sheetMsg(`${canShare ? "Ready to download or share." : "Ready to download."}${touch ? " You can also press and hold the picture to save it." : ""}`);
  } catch {
    if (F.making !== making) return;
    sheetMsg("Sorry, this browser couldn't make the picture. A screenshot works too, or try another browser.", true);
  }
}
function closeSheet() {
  if ($("sheet").hidden) return;
  $("sheet").hidden = true; F.making = null;
  if (F.open) $("full-save").focus();
}
$("full-save").addEventListener("click", openSheet);
$("sheet-close").addEventListener("click", closeSheet);
$("sheet-download").addEventListener("click", () => {
  if (!F.file) return;
  const a = document.createElement("a"); a.href = F.url; a.download = F.file.name; document.body.appendChild(a); a.click(); a.remove();
  ev("directory_image_downloaded"); keep(true);
  sheetMsg(`Saved as ${F.file.name}.`);
});
$("sheet-share").addEventListener("click", async () => {
  if (!F.file) return;
  ev("directory_share_initiated"); keep(true);
  try {
    await navigator.share({ files: [F.file], title: "My WayTuGo preview", text: `My WayTuGo preview. See yours at ${SHARE_URL}` });
    ev("directory_share_completed"); keep(true);   // the device says it was sent (where it can tell)
    sheetMsg("Shared.");
  } catch (e) {
    if (e?.name === "AbortError") sheetMsg("Not shared.");
    else sheetMsg("Sharing didn't work here: use Download Image instead.", true);
  }
});

// ── the page's height, for the frame that holds it
let lastHeight = 0;
const tellHeight = () => { if (!parentOrigin || F.open) return; const px = Math.ceil(document.documentElement.scrollHeight); if (px !== lastHeight) { lastHeight = px; tell({ type: "height", px }); } };
if (parentOrigin) new ResizeObserver(tellHeight).observe(document.body);   // (not while the full-screen view is open)
// Each visit starts from the defaults (a building directory, landscape): browsers otherwise bring back a reload's choices
form.reset();
renderRows();
window.addEventListener("pageshow", (e) => { if (e.persisted) { if (F.open) closeFull(); form.reset(); for (const r of typed) { r.name = ""; r.suite = ""; } own.logo = own.photo = null; rowsEl.innerHTML = ""; renderRows(); draw(); } });
tell({ type: "event", name: "viewer_start", kind: choices().kind });
fit();
window.Viewer = { visit: V, state: S, choices, KINDS, typed, own, full: F };   // for the browser checks
