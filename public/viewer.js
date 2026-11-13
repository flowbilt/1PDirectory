// "See Your WayTuGo in Action" (DP-14, V1): the viewer waytugo.com embeds. The visitor's choices draw the real
// directory screen (index.html?preview=1) with invented content (viewer-sample.mjs). Once they've built something,
// the visit is kept without a name (/api/viewer); "Request a Quote" hands the configuration to the page that embeds
// this one, whose own inquiry form sends it. Messages to that page (only to WayTuGo's and 1Point's sites):
//   { source: "waytugo-viewer", type: "height", px }                  the page's height, to size the frame
//   { source: "waytugo-viewer", type: "event", name, kind }           viewer_start, viewer_type_selected,
//                                                                     viewer_preview_shown, viewer_quote_started
//   { source: "waytugo-viewer", type: "quote", visit, code, summary, config }
// and from it: { source: "waytugo-site", type: "quote-sent", visit }   its form was sent (kept with the visit)
import { normalizeConfig, sampleDirectory, sampleRows, summary, typeSamples, menuDraft, menuRows, KINDS, LIMITS, SLIDER_MAX, MENU_LOOKS } from "/viewer-sample.mjs";

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

// The visit: its code, how long it's been looked at (while the page is showing), how much was changed
const V = { id: crypto.randomUUID(), shownSince: document.visibilityState === "visible" ? Date.now() : 0, seconds: 0, changes: 0, quote: null, kept: "", previewTold: false };
const q = new URLSearchParams(location.search);
const source = Object.fromEntries(["page", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].map((k) => [k, (q.get(k) || "").slice(0, 200)]).filter(([, v]) => v));
const code = V.id.slice(0, 8).toUpperCase();
const seconds = () => Math.min(7200, Math.round(V.seconds + (V.shownSince ? (Date.now() - V.shownSince) / 1000 : 0)));

// V2: what the visitor typed over the sample tenants (kept for all 20, so a row comes back when the slider does), and
// their own logo and photo: in this page only, as pictures shrunk in the browser; never sent anywhere
const typed = Array.from({ length: SLIDER_MAX }, () => ({ name: "", suite: "" }));
const own = { logo: null, photo: null };   // { url, name }

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
  showReset(); V.changes++; draw(); keep();
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
    tick.checked = true; show(); V.changes++; draw(); keep();
  });
  box.querySelector("[data-drop]").addEventListener("click", () => { own[k] = null; show(); V.changes++; draw(); keep(); });
}

// ── the preview: the screen at its real size (1920 × 1080 or 1080 × 1920), scaled to fit
function fit() {
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
  showItemsReset(); V.changes++; draw(); keep();
});

// ── keeping the visit (from its first change; a few seconds after the last; and when the page is left)
let keepT = 0;
function body() { return JSON.stringify({ id: V.id, config: choices(), seconds: seconds(), changes: V.changes, quote: V.quote, source }); }
function keep(now = false) {
  clearTimeout(keepT);
  if (!V.changes && !V.quote) return;
  const send = () => { const b = body(); if (b === V.kept) return; V.kept = b; fetch("/api/viewer", { method: "POST", body: b, headers: { "Content-Type": "application/json" }, keepalive: true }).catch(() => {}); };
  if (now) send(); else keepT = setTimeout(send, 5000);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (V.shownSince) { V.seconds += (Date.now() - V.shownSince) / 1000; V.shownSince = 0; }
    if (V.changes || V.quote) { const b = body(); if (b !== V.kept) { V.kept = b; navigator.sendBeacon?.("/api/viewer", new Blob([b], { type: "application/json" })); } }
  } else V.shownSince = Date.now();
});

form.addEventListener("input", (e) => {
  if (e.target.type === "file") return;
  V.changes++;
  if (e.target.name === "kind") tell({ type: "event", name: "viewer_type_selected", kind: e.target.value });
  if (e.target.name === "kind" && e.target.value === "menu") loadTemplates();   // V4: the sample menus, the first time
  draw(); keep();
});
window.addEventListener("resize", fit);

// ── Request a Quote: the configuration to the page's own inquiry form (or, on its own, how to reach 1Point)
$("quote").addEventListener("click", () => {
  const c = choices();
  if (V.quote !== "sent") V.quote = "started";
  keep(true);
  tell({ type: "event", name: "viewer_quote_started", kind: c.kind });
  const b = c.kind === "menu" ? boardOf(c.board) : null;   // V4: the summary names the sample board
  if (parentOrigin) tell({ type: "quote", visit: V.id, code, summary: summary(c, { boardName: b ? b.name.replace(/^[^:]*:\s*/, "") : "" }), config: c });
  else { $("code").textContent = code; $("direct").hidden = false; }
});
window.addEventListener("message", (e) => {
  if (e.origin !== parentOrigin || e.data?.source !== "waytugo-site") return;
  if (e.data.type === "quote-sent" && e.data.visit === V.id) { V.quote = "sent"; keep(true); }
});

// ── the page's height, for the frame that holds it
if (parentOrigin) {
  let last = 0;
  new ResizeObserver(() => { const px = Math.ceil(document.documentElement.scrollHeight); if (px !== last) { last = px; tell({ type: "height", px }); } }).observe(document.body);
}
// Each visit starts from the defaults (a building directory, landscape): browsers otherwise bring back a reload's choices
form.reset();
renderRows();
window.addEventListener("pageshow", (e) => { if (e.persisted) { form.reset(); for (const r of typed) { r.name = ""; r.suite = ""; } own.logo = own.photo = null; rowsEl.innerHTML = ""; renderRows(); V.changes = 0; draw(); } });
tell({ type: "event", name: "viewer_start", kind: choices().kind });
fit();
window.Viewer = { visit: V, choices, KINDS, typed, own };   // for the browser checks
