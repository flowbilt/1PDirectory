// The console's Viewer tab (DP-14, V1; 1Point only): visits to "See Your WayTuGo in Action" on waytugo.com, kept
// without a name by supabase/48-viewer.sql. View redraws a visit exactly as the visitor saw it, from its choices, with
// the same sample content (viewer-sample.mjs) on the real directory screen.
import { normalizeConfig, sampleDirectory, summary, menuDraft, KINDS, TYPES, MENU_LOOKS } from "/viewer-sample.mjs";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let rows = [];

const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const spent = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`);
const from = (src) => {
  const s = src || {}, ad = [s.utm_source, s.utm_medium, s.utm_campaign].filter(Boolean).join(" / ");
  return ad || s.page || "";
};
const extras = (c) => (c.kind === "menu" ? [MENU_LOOKS[c.look], c.logo === "sample" && "Logo", c.logo === "own" && "Own logo"] : [c.weather && "Weather", c.news && "News", c.contacts && "Contacts", c.qr && "QR", c.places && "Places",
  // V2: the look, and the logo and photo (their own isn't kept: View shows the placeholder in its place)
  c.look === "light" && "Light", c.logo === "sample" && "Logo", c.logo === "own" && "Own logo", c.photo === "sample" && "Photo", c.photo === "own" && "Own photo"]).filter(Boolean).join(", ") || "None";
const typedIn = (c) => (c.rows || []).filter((r) => r.name || r.suite).length;

// V3: the location type the visitor chose (self-chosen; "Not specified" when none)
const typeOf = (c) => (c.type && TYPES[c.type]) || "Not specified";
// An engaged visit: at least 30 seconds and 3 changes (every kept visit changed something at least once)
export const ENGAGED = { seconds: 30, changes: 3 };
const engaged = (r) => r.seconds >= ENGAGED.seconds && r.changes >= ENGAGED.changes;
const sourceOf = (src) => { const s = src || {}; return [s.utm_source, s.utm_medium].filter(Boolean).join(" / ") || (s.page ? `${s.page} (no ad)` : "(direct)"); };

/** The visits grouped by one key: visits, engaged, average time, quotes started and sent */
export function breakdown(list, keyOf) {
  const g = new Map();
  for (const r of list) {
    const k = keyOf(r), x = g.get(k) || { key: k, visits: 0, engaged: 0, seconds: 0, quotes: 0, sent: 0 };
    x.visits++; x.engaged += engaged(r) ? 1 : 0; x.seconds += r.seconds || 0; x.quotes += r.quote ? 1 : 0; x.sent += r.quote === "sent" ? 1 : 0;
    g.set(k, x);
  }
  return [...g.values()].sort((a, b) => b.visits - a.visits || a.key.localeCompare(b.key));
}
function breakdownHtml(title, list) {
  return `<div class="viewer-bd"><h3>${esc(title)}</h3><table class="grid compact"><thead><tr><th></th><th>Visits</th><th>Engaged</th><th>Avg time</th><th>Quotes</th></tr></thead><tbody>${list.map((x) =>
    `<tr><td>${esc(x.key)}</td><td>${x.visits}</td><td>${x.engaged}</td><td>${esc(spent(Math.round(x.seconds / x.visits)))}</td><td>${x.quotes}${x.sent ? ` <span class="sub">(${x.sent} sent)</span>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
}

/** V3: the visits as a CSV (for comparing with Google and Meta ads); no more than the console shows */
export function toCsv(list) {
  const cell = (v) => { const t = String(v ?? ""); return /[",\n\r]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? "'" : "") + t.replace(/"/g, '""')}"` : t; };
  const head = ["code", "started", "location_type", "display", "building_name", "tenants", "typed_in", "screen", "look", "logo", "photo", "extras", "seconds", "changes", "engaged", "quote",
    "page", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "menu_board", "items_typed_in"];
  const lines = list.map((r) => {
    const c = normalizeConfig(r.config), s = r.source || {};
    return [r.id.slice(0, 8).toUpperCase(), r.started_at, c.type ? TYPES[c.type] : "Not specified", KINDS[c.kind], c.name, c.tenants, (c.rows || []).filter((x) => x.name || x.suite).length,
      c.shape, c.look || "", c.logo || "", c.photo || "", extras(c), r.seconds, r.changes, engaged(r) ? "yes" : "no", r.quote || "",
      s.page, s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term,
      c.kind === "menu" ? boardName(c.board) : "", c.kind === "menu" ? (c.items || []).filter((x) => x.name || x.price).length : ""].map(cell).join(",");
  });
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}

// V4: the template boards' names, for menu board visits (a board no longer offered says so)
let boardNames = null;
async function loadBoards() {
  if (boardNames) return;
  try { const r = await fetch("/api/viewer-boards", { cache: "no-store" }); boardNames = new Map((await r.json()).templates.flatMap((t) => t.boards.map((b) => [b.id, `${t.name}: ${b.name.replace(/^[^:]*:\s*/, "")}`]))); }
  catch { boardNames = new Map(); }
}
const boardName = (id) => boardNames?.get(id) || (id ? "a board no longer offered" : "");

async function load() {
  await loadBoards();
  const days = Number($("viewer-days").value);
  const since = days ? `&started_at=gte.${new Date(Date.now() - days * 864e5).toISOString()}` : "";
  try {
    rows = await Auth.db(`viewer_visits?select=*${since}&order=started_at.desc&limit=500`);
  } catch (e) { $("viewer-rows").innerHTML = `<tr><td colspan="11" class="error">Couldn't load the visits: ${esc(e.message)}</td></tr>`; return; }
  render();
}
function render() {
  const started = rows.filter((r) => r.quote).length, sent = rows.filter((r) => r.quote === "sent").length;
  $("viewer-summary").textContent = `${rows.length} visit${rows.length === 1 ? "" : "s"} · ${started} asked for a quote${sent ? ` (${sent} sent the form)` : ""}`;
  $("viewer-breakdown").innerHTML = rows.length ? breakdownHtml("By location type", breakdown(rows, (r) => typeOf(normalizeConfig(r.config))))
    + breakdownHtml("By ad source", breakdown(rows, (r) => sourceOf(r.source)))
    + `<p class="hint">Engaged: ${ENGAGED.seconds} seconds or more and ${ENGAGED.changes} or more changes. Location types are what visitors chose, not verified.</p>` : "";
  $("viewer-rows").innerHTML = rows.length ? rows.map((r) => {
    const c = normalizeConfig(r.config);
    return `<tr data-id="${esc(r.id)}">
      <td>${esc(when(r.started_at))}<div class="sub">${esc(r.id.slice(0, 8).toUpperCase())}</div></td>
      <td>${esc(KINDS[c.kind])}</td><td>${c.type ? esc(TYPES[c.type]) : '<span class="muted">Not specified</span>'}</td><td>${c.name ? esc(c.name) : '<span class="muted">(no name)</span>'}${c.subtitle ? `<div class="sub">${esc(c.subtitle)}</div>` : ""}</td>
      <td>${c.kind === "menu" ? `<span class="sub">${esc(boardName(c.board))}</span>${(c.items || []).length ? `<div class="sub">${c.items.filter((x) => x.name || x.price).length} items typed in</div>` : ""}`
        : `${c.tenants}${typedIn(c) ? `<div class="sub">${typedIn(c)} typed in</div>` : ""}`}</td><td>${c.shape === "portrait" ? "Portrait" : "Landscape"}</td><td>${esc(extras(c))}</td>
      <td>${esc(spent(r.seconds))}<div class="sub">${r.changes} change${r.changes === 1 ? "" : "s"}</div></td>
      <td>${esc(from(r.source)) || '<span class="muted">—</span>'}</td>
      <td>${r.quote ? `<span class="viewer-quote ${esc(r.quote)}">${r.quote === "sent" ? "Sent" : "Started"}</span>` : ""}</td>
      <td class="actions"><button type="button" class="ghost" data-view>View</button> <button type="button" class="ghost danger" data-remove>Remove</button></td></tr>`;
  }).join("") : `<tr><td colspan="11" class="muted">No visits yet in this period.</td></tr>`;
}

// View: the visitor's preview, redrawn
function view(r) {
  const c = normalizeConfig(r.config), land = c.shape === "landscape", W = land ? 1920 : 1080, H = land ? 1080 : 1920;
  $("viewer-dlg-title").textContent = c.name || "(no name)";
  $("viewer-dlg-line").textContent = `${summary(c, { boardName: c.kind === "menu" ? boardName(c.board) : "" })} · code ${r.id.slice(0, 8).toUpperCase()} · ${when(r.started_at)}`;
  const dlg = $("viewer-dlg"), box = $("viewer-dlg-screen"), f = $("viewer-dlg-frame");
  dlg.showModal();
  const s = Math.min((box.parentElement.clientWidth - 16) / W, (window.innerHeight * 0.7) / H);
  Object.assign(box.style, { width: `${Math.round(W * s)}px`, height: `${Math.round(H * s)}px` });
  Object.assign(f.style, { width: `${W}px`, height: `${H}px`, transform: `scale(${s})` });
  if (c.kind === "menu") {   // V4: the template board, with the visitor's choices laid over it (their own logo: the placeholder)
    f.onload = async () => {
      try { const r = await fetch(`/api/viewer-boards?board=${encodeURIComponent(c.board)}`); if (!r.ok) throw new Error(String(r.status));
        f.contentWindow.postMessage({ type: "layout-draft", data: menuDraft(await r.json(), c) }, location.origin); }
      catch { $("viewer-dlg-line").textContent += " · this sample board isn't offered any more, so it can't be redrawn"; }
    };
    f.src = "/board.html?preview=1";
    return;
  }
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
$("viewer-csv").addEventListener("click", () => {
  const a = document.createElement("a"), days = $("viewer-days").value;
  a.href = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv" }));
  a.download = `waytugo-viewer-visits-${days === "0" ? "all" : `${days}-days`}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("viewer-dlg").addEventListener("close", () => { $("viewer-dlg-frame").src = "about:blank"; });

window.ConsoleViewer = { show: load };
if (location.hash === "#viewer" && !document.getElementById("panel-viewer").hidden) load();
