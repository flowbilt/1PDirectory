// "See Your WayTuGo in Action" (DP-14, V1): the viewer waytugo.com embeds. The visitor's choices draw the real
// directory screen (index.html?preview=1) with invented content (viewer-sample.mjs). Once they've built something,
// the visit is kept without a name (/api/viewer); "Request a Quote" hands the configuration to the page that embeds
// this one, whose own inquiry form sends it. Messages to that page (only to WayTuGo's and 1Point's sites):
//   { source: "waytugo-viewer", type: "height", px }                  the page's height, to size the frame
//   { source: "waytugo-viewer", type: "event", name, kind }           viewer_start, viewer_type_selected,
//                                                                     viewer_preview_shown, viewer_quote_started
//   { source: "waytugo-viewer", type: "quote", visit, code, summary, config }
// and from it: { source: "waytugo-site", type: "quote-sent", visit }   its form was sent (kept with the visit)
import { normalizeConfig, sampleDirectory, summary, KINDS } from "/viewer-sample.mjs";

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

function choices() {
  const f = new FormData(form);
  return normalizeConfig({ kind: f.get("kind"), name: f.get("name"), subtitle: f.get("subtitle"), tenants: Number(f.get("tenants")), shape: f.get("shape"),
    weather: f.has("weather"), qr: f.has("qr"), places: f.has("places"), contacts: f.has("contacts"), news: f.has("news") });
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
    $("hint").textContent = c.kind === "touch" ? "It's live: tap a company for its card, or a letter to jump. Names, suites and phone numbers are invented." : "Names, suites and phone numbers are invented for this preview.";
    fit();
    frame.contentWindow?.postMessage({ type: "draft", data: sampleDirectory(c) }, location.origin);
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
window.addEventListener("pageshow", (e) => { if (e.persisted) { form.reset(); V.changes = 0; draw(); } });
tell({ type: "event", name: "viewer_start", kind: choices().kind });
fit();
window.Viewer = { visit: V, choices, KINDS };   // for the browser checks
