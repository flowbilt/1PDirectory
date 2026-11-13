// The console's Viewer tab (DP-14, V1; 1Point only): visits to "See Your WayTuGo in Action" on waytugo.com, kept
// without a name by supabase/48-viewer.sql. View redraws a visit exactly as the visitor saw it, from its choices, with
// the same sample content (viewer-sample.mjs) on the real directory screen.
import { normalizeConfig, sampleDirectory, summary, KINDS } from "/viewer-sample.mjs";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let rows = [];

const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const spent = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`);
const from = (src) => {
  const s = src || {}, ad = [s.utm_source, s.utm_medium, s.utm_campaign].filter(Boolean).join(" / ");
  return ad || s.page || "";
};
const extras = (c) => [c.weather && "Weather", c.news && "News", c.contacts && "Contacts", c.qr && "QR", c.places && "Places",
  // V2: the look, and the logo and photo (their own isn't kept: View shows the placeholder in its place)
  c.look === "light" && "Light", c.logo === "sample" && "Logo", c.logo === "own" && "Own logo", c.photo === "sample" && "Photo", c.photo === "own" && "Own photo"].filter(Boolean).join(", ") || "None";
const typedIn = (c) => (c.rows || []).filter((r) => r.name || r.suite).length;

async function load() {
  const days = Number($("viewer-days").value);
  const since = days ? `&started_at=gte.${new Date(Date.now() - days * 864e5).toISOString()}` : "";
  try {
    rows = await Auth.db(`viewer_visits?select=*${since}&order=started_at.desc&limit=500`);
  } catch (e) { $("viewer-rows").innerHTML = `<tr><td colspan="10" class="error">Couldn't load the visits: ${esc(e.message)}</td></tr>`; return; }
  render();
}
function render() {
  const started = rows.filter((r) => r.quote).length, sent = rows.filter((r) => r.quote === "sent").length;
  $("viewer-summary").textContent = `${rows.length} visit${rows.length === 1 ? "" : "s"} · ${started} asked for a quote${sent ? ` (${sent} sent the form)` : ""}`;
  $("viewer-rows").innerHTML = rows.length ? rows.map((r) => {
    const c = normalizeConfig(r.config);
    return `<tr data-id="${esc(r.id)}">
      <td>${esc(when(r.started_at))}<div class="sub">${esc(r.id.slice(0, 8).toUpperCase())}</div></td>
      <td>${esc(KINDS[c.kind])}</td><td>${c.name ? esc(c.name) : '<span class="muted">(no name)</span>'}${c.subtitle ? `<div class="sub">${esc(c.subtitle)}</div>` : ""}</td>
      <td>${c.tenants}${typedIn(c) ? `<div class="sub">${typedIn(c)} typed in</div>` : ""}</td><td>${c.shape === "portrait" ? "Portrait" : "Landscape"}</td><td>${esc(extras(c))}</td>
      <td>${esc(spent(r.seconds))}<div class="sub">${r.changes} change${r.changes === 1 ? "" : "s"}</div></td>
      <td>${esc(from(r.source)) || '<span class="muted">—</span>'}</td>
      <td>${r.quote ? `<span class="viewer-quote ${esc(r.quote)}">${r.quote === "sent" ? "Sent" : "Started"}</span>` : ""}</td>
      <td class="actions"><button type="button" class="ghost" data-view>View</button> <button type="button" class="ghost danger" data-remove>Remove</button></td></tr>`;
  }).join("") : `<tr><td colspan="10" class="muted">No visits yet in this period.</td></tr>`;
}

// View: the visitor's preview, redrawn
function view(r) {
  const c = normalizeConfig(r.config), land = c.shape === "landscape", W = land ? 1920 : 1080, H = land ? 1080 : 1920;
  $("viewer-dlg-title").textContent = c.name || "(no name)";
  $("viewer-dlg-line").textContent = `${summary(c)} · code ${r.id.slice(0, 8).toUpperCase()} · ${when(r.started_at)}`;
  const dlg = $("viewer-dlg"), box = $("viewer-dlg-screen"), f = $("viewer-dlg-frame");
  dlg.showModal();
  const s = Math.min((box.parentElement.clientWidth - 16) / W, (window.innerHeight * 0.7) / H);
  Object.assign(box.style, { width: `${Math.round(W * s)}px`, height: `${Math.round(H * s)}px` });
  Object.assign(f.style, { width: `${W}px`, height: `${H}px`, transform: `scale(${s})` });
  f.onload = () => f.contentWindow.postMessage({ type: "draft", data: sampleDirectory(c) }, location.origin);
  f.src = "/index.html?preview=1";
}

$("viewer-rows").addEventListener("click", async (e) => {
  const tr = e.target.closest("tr[data-id]"); if (!tr) return;
  const r = rows.find((x) => x.id === tr.dataset.id); if (!r) return;
  if (e.target.closest("[data-view]")) view(r);
  if (e.target.closest("[data-remove]")) {
    if (!confirm(`Remove this visit (${r.id.slice(0, 8).toUpperCase()})? Use this for your own test visits.`)) return;
    try { await Auth.db(`viewer_visits?id=eq.${r.id}`, { method: "DELETE" }); rows = rows.filter((x) => x.id !== r.id); render(); }
    catch (err) { alert(`Not removed: ${err.message}`); }
  }
});
$("viewer-days").addEventListener("change", load);
$("viewer-dlg").addEventListener("close", () => { $("viewer-dlg-frame").src = "about:blank"; });

window.ConsoleViewer = { show: load };
if (location.hash === "#viewer" && !document.getElementById("panel-viewer").hidden) load();
