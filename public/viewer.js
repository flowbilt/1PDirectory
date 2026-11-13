// "See Your WayTuGo in Action" (DP-14, V1): the viewer waytugo.com embeds. The visitor's choices draw the real
// directory screen (index.html?preview=1) with invented content (viewer-sample.mjs). Once they've built something,
// the visit is kept without a name (/api/viewer); "Request a Quote" hands the configuration to the page that embeds
// this one, whose own inquiry form sends it. Messages to that page (only to WayTuGo's and 1Point's sites):
//   { source: "waytugo-viewer", type: "height", px }                  the page's height, to size the frame
//   { source: "waytugo-viewer", type: "event", name, kind }           viewer_start, viewer_type_selected,
//                                                                     viewer_preview_shown, viewer_quote_started
//   { source: "waytugo-viewer", type: "quote", visit, code, summary, config }
// and from it: { source: "waytugo-site", type: "quote-sent", visit }   its form was sent (kept with the visit)
import { normalizeConfig, sampleDirectory, sampleRows, summary, typeSamples, KINDS, LIMITS, SLIDER_MAX } from "/viewer-sample.mjs";

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

function choices() {
  const f = new FormData(form), n = Number(f.get("tenants"));
  const pic = (k) => (!f.has(k) ? "off" : own[k] ? "own" : "sample");
  return normalizeConfig({ v: 2, kind: f.get("kind"), name: f.get("name"), subtitle: f.get("subtitle"), tenants: n, shape: f.get("shape"),
    weather: f.has("weather"), qr: f.has("qr"), places: f.has("places"), contacts: f.has("contacts"), news: f.has("news"),
    look: f.get("look"), logo: pic("logo"), photo: pic("photo"), rows: typed.slice(0, n), type: f.get("type") || "" });
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
    const c = choices();
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
  draw(); keep();
});
window.addEventListener("resize", fit);

// ── Request a Quote: the configuration to the page's own inquiry form (or, on its own, how to reach 1Point)
$("quote").addEventListener("click", () => {
  const c = choices();
  if (V.quote !== "sent") V.quote = "started";
  keep(true);
  tell({ type: "event", name: "viewer_quote_started", kind: c.kind });
  if (parentOrigin) tell({ type: "quote", visit: V.id, code, summary: summary(c), config: c });
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
