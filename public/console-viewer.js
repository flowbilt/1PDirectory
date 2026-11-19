// The console's Viewer tab (DP-14, V1; 1Point only): visits to "See Your WayTuGo in Action" on waytugo.com, kept
// without a name by supabase/48-viewer.sql. View redraws a visit exactly as the visitor saw it, from its choices, with
// the same sample content (viewer-sample.mjs) on the real directory screen.
//
// V5 (DP-15, Scot's "Full-Screen Preview, Save/Share & Engagement Tracking"): visits are kept from the moment the page
// loads (54-viewer-events.sql), with what happened (events), the device and browser as categories, and the choices each
// time the full-screen view opened (snapshots, which View can redraw). waytugo.com's page also says when it loads
// (viewer_page_loads), so a load with no visit shows who left before the viewer started. Here: where visitors drop off
// (the funnel), by ad source, by device and browser, and by location type; the list shows visits where something was
// built unless "Show page loads too" is ticked. V5e: background loads apart, and the steps counted among visitors who
// stayed 3 seconds or more. Engaged: 30 seconds and 2 real edits (Scot, 2026-11-16: "Yes"); visits
// kept before V5 keep their old rule (30 seconds and 3 changes).
import { normalizeConfig, sampleDirectory, summary, menuDraft, KINDS, TYPES, MENU_LOOKS } from "/viewer-sample.mjs";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let rows = [], loads = [];

const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const spent = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`);
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "—");
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

// V5: what a visit did. Visits kept before V5 have no events: they were kept only once something was built, so they
// count as started and edited, and nothing else is known about them.
const isV5 = (r) => !!r.events && Object.keys(r.events).length > 0;
const n = (r, k) => Number(r.events?.[k] || 0);
export function did(r) {
  const v5 = isV5(r);
  return {
    v5, loads: v5 ? Math.max(1, n(r, "viewer_page_loaded")) : 1,
    started: v5 ? n(r, "viewer_initialized") > 0 : true,
    edits: v5 ? n(r, "configuration_edited") : null,
    edited: v5 ? n(r, "configuration_edited") > 0 : true,
    full: n(r, "full_preview_opened"), downloaded: n(r, "directory_image_downloaded"), shareStarted: n(r, "directory_share_initiated"), shared: n(r, "directory_share_completed"),
    emailed: n(r, "directory_email_sent"),   // V5b
    quoteOpened: !!r.quote || n(r, "quote_form_opened") > 0, quoteSent: r.quote === "sent" || n(r, "quote_submitted") > 0,
    failed: n(r, "viewer_error") > 0,
    // V5e: a background load (the page loaded off screen and was never seen); visits from before V5e count as seen
    background: n(r, "viewer_loaded_unseen") > 0 && n(r, "viewer_seen") === 0,
  };
}
/** V5e: a visitor who stayed 3 seconds or more (or did something): the base for the funnel's percentages. Visits from
 *  before V5 count as stayed (they were kept only once something was built). */
export const STAYED_MS = 3000;
export function stayed(r) {
  const d = did(r);
  if (!d.v5) return true;
  if (d.background) return false;
  const span = Date.parse(r.updated_at || r.started_at) - Date.parse(r.started_at);
  return (r.seconds || 0) * 1000 >= STAYED_MS || span >= STAYED_MS || d.edits > 0 || d.full > 0 || d.quoteOpened;
}
const saved = (d) => d.downloaded > 0 || d.shareStarted > 0 || d.emailed > 0;
/** Something was built or looked at closely: the list's default */
export const built = (r) => { const d = did(r); return !d.v5 || d.edited || d.full > 0 || d.quoteOpened; };

// An engaged visit: 30 seconds or more and 2 or more real edits (V5); before V5, 30 seconds and 3 changes
export const ENGAGED = { seconds: 30, edits: 2, changes: 3 };
export const engaged = (r) => r.seconds >= ENGAGED.seconds && (isV5(r) ? did(r).edits >= ENGAGED.edits : r.changes >= ENGAGED.changes);
const sourceOf = (src) => { const s = src || {}; return [s.utm_source, s.utm_medium].filter(Boolean).join(" / ") || (s.page ? `${s.page} (no ad)` : "(direct)"); };
const DEVICES = { phone: "Phone", tablet: "Tablet", desktop: "Desktop" }, BROWSERS = { facebook: "Facebook browser", instagram: "Instagram browser", other: "" };
const deviceOf = (r) => (r.device ? [DEVICES[r.device], BROWSERS[r.browser]].filter(Boolean).join(" · ") : "Not known");

/** The funnel for a list of visits (and, for the ad sources, the waytugo.com page loads with the same source) */
// V5e: every step after "stayed" counts only visitors who stayed, and its percentage is of them; background loads are
// counted apart and left out
export function funnel(list, pageLoads = null) {
  const f = { visits: list.length, background: 0, stayed: 0, started: 0, edited: 0, full: 0, saved: 0, shared: 0, quotes: 0, sent: 0, engaged: 0, seconds: 0, failed: 0, failures: 0, pageLoads: pageLoads == null ? null : pageLoads.length, loadsWithout: 0 };
  for (const r of list) {
    const d = did(r);
    f.failed += d.failed ? 1 : 0; f.failures += r.failures > 0 ? 1 : 0;
    if (d.background) { f.background += 1; continue; }
    if (!stayed(r)) continue;
    f.stayed += 1;
    f.started += d.started ? 1 : 0; f.edited += d.edited ? 1 : 0; f.full += d.full > 0 ? 1 : 0; f.saved += saved(d) ? 1 : 0; f.shared += d.shared > 0 ? 1 : 0;
    f.quotes += d.quoteOpened ? 1 : 0; f.sent += d.quoteSent ? 1 : 0; f.engaged += engaged(r) ? 1 : 0; f.seconds += r.seconds || 0;
  }
  if (pageLoads) { const seen = new Set(list.map((r) => r.page_load).filter(Boolean)); f.loadsWithout = pageLoads.filter((l) => !seen.has(l.id)).length; }
  return f;
}

/** The visits grouped by one key, each with its funnel */
export function breakdown(list, keyOf, pageLoads = null) {
  const g = new Map();
  for (const r of list) { const k = keyOf(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  if (pageLoads) for (const l of pageLoads) { const k = keyOf(l); if (!g.has(k)) g.set(k, []); }
  return [...g.entries()].map(([key, l]) => ({ key, ...funnel(l, pageLoads ? pageLoads.filter((x) => keyOf(x) === key) : null) }))
    .sort((a, b) => b.visits - a.visits || (b.pageLoads || 0) - (a.pageLoads || 0) || a.key.localeCompare(b.key));
}
function breakdownHtml(title, list, { pageLoads = false } = {}) {
  const head = `${pageLoads ? "<th>Page loads</th>" : ""}<th>Visits</th><th>Background</th><th>Stayed 3 s+</th><th>Started</th><th>Edited</th><th>Full screen</th><th>Saved or shared</th><th>Quote opened</th><th>Quote sent</th><th>Engaged</th><th>Avg time</th>`;
  const of = (v, x) => `${v} <span class="sub">${pct(v, x.stayed)}</span>`;
  return `<div class="viewer-bd"><h3>${esc(title)}</h3><table class="grid compact"><thead><tr><th></th>${head}</tr></thead><tbody>${list.map((x) =>
    `<tr><td>${esc(x.key)}</td>${pageLoads ? `<td>${x.pageLoads}</td>` : ""}<td>${x.visits}</td><td>${x.background}</td><td>${x.stayed} <span class="sub">${pct(x.stayed, x.visits - x.background)}</span></td>`
    + `<td>${of(x.started, x)}</td><td>${of(x.edited, x)}</td><td>${of(x.full, x)}</td><td>${of(x.saved, x)}</td><td>${of(x.quotes, x)}</td><td>${of(x.sent, x)}</td>`
    + `<td>${x.engaged}</td><td>${x.stayed ? esc(spent(Math.round(x.seconds / x.stayed))) : "—"}</td></tr>`).join("")}</tbody></table></div>`;
}
function funnelHtml(f) {
  const step = (label, v, of, note = "") => `<div class="viewer-step"><div class="viewer-step-n">${v}</div><div class="viewer-step-l">${esc(label)}</div><div class="sub">${of == null ? "&nbsp;" : pct(v, of)}${note}</div></div>`;
  return `<div class="viewer-funnel">${f.pageLoads != null ? step("Page loads on waytugo.com", f.pageLoads, null) : ""}${step("Viewer visits", f.visits, null)}${step("Background loads", f.background, null)}`
    + `${step("Stayed 3 s or more", f.stayed, f.visits - f.background)}${step("Viewer started", f.started, f.stayed)}`
    + `${step("Edited something", f.edited, f.stayed)}${step("Full screen", f.full, f.stayed)}${step("Saved or shared", f.saved, f.stayed)}${step("Quote form opened", f.quotes, f.stayed)}${step("Quote sent", f.sent, f.stayed)}</div>`
    + `<p class="hint"><strong>Stayed 3 s or more</strong> is of the visits that weren't background loads; the steps after it count only those visitors, and their percentages are of them (quick exits, often accidental taps on an ad, would hide the real figures). A <strong>background load</strong> is the page loaded off screen (the browser said it was hidden or being prepared ahead of a tap) and never seen: left out (counted from V5e). ${f.pageLoads ? `<strong>${f.loadsWithout}</strong> page load${f.loadsWithout === 1 ? "" : "s"} on waytugo.com had no viewer visit (the visitor left before the viewer started, or it didn't load). ` : ""}`
    + `${f.failed ? `<strong>${f.failed}</strong> visit${f.failed === 1 ? "" : "s"} where the viewer failed to start in that browser. ` : ""}${f.failures ? `<strong>${f.failures}</strong> visit${f.failures === 1 ? "" : "s"} reported sends that didn't arrive (counted, then sent again). ` : ""}`
    + `Engaged: ${ENGAGED.seconds} seconds or more and ${ENGAGED.edits} or more edits (before V5: ${ENGAGED.changes} changes). Downloads and shares are interest, not leads. Location types are what visitors chose, not verified.</p>`;
}

/** V3: the visits as a CSV (for comparing with Google and Meta ads); no more than the console shows. V5: what each did */
export function toCsv(list) {
  const cell = (v) => { const t = String(v ?? ""); return /[",\n\r]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? "'" : "") + t.replace(/"/g, '""')}"` : t; };
  const head = ["code", "started", "location_type", "display", "building_name", "tenants", "typed_in", "screen", "look", "logo", "photo", "extras", "seconds", "changes", "engaged", "quote",
    "page", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "menu_board", "items_typed_in",
    "last_active", "device", "browser", "page_loads", "viewer_started", "start_ms", "edits", "full_previews", "downloads", "shares_started", "shares_completed", "emails_sent", "quote_opened", "quote_sent", "snapshots", "send_failures", "viewer_failed", "from_page_load", "seen", "background_load", "stayed_3s"];
  const lines = list.map((r) => {
    const c = normalizeConfig(r.config), s = r.source || {}, d = did(r), none = !r.config;
    return [r.id.slice(0, 8).toUpperCase(), r.started_at, none ? "" : c.type ? TYPES[c.type] : "Not specified", none ? "" : KINDS[c.kind], none ? "" : c.name, none ? "" : c.tenants, none ? "" : (c.rows || []).filter((x) => x.name || x.suite).length,
      none ? "" : c.shape, none ? "" : c.look || "", none ? "" : c.logo || "", none ? "" : c.photo || "", none ? "" : extras(c), r.seconds, r.changes, engaged(r) ? "yes" : "no", r.quote || "",
      s.page, s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term,
      !none && c.kind === "menu" ? boardName(c.board) : "", !none && c.kind === "menu" ? (c.items || []).filter((x) => x.name || x.price).length : "",
      r.updated_at || "", r.device || "", r.browser || "", d.v5 ? d.loads : "", d.started ? "yes" : "no", r.init_ms ?? "", d.edits ?? "", d.full, d.downloaded, d.shareStarted, d.shared, d.emailed,
      d.quoteOpened ? "yes" : "no", d.quoteSent ? "yes" : "no", (r.snapshots || []).length, r.failures || 0, d.failed ? "yes" : "no", r.page_load ? "yes" : "",
      d.v5 && (n(r, "viewer_seen") || n(r, "viewer_loaded_unseen")) ? (n(r, "viewer_seen") ? "yes" : "no") : "", d.background ? "yes" : "no", stayed(r) ? "yes" : "no"].map(cell).join(",");
  });
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}

// V4: the template boards' names, for menu board visits (a board no longer offered says so)
let boardNames = null;
async function loadBoards() {
  if (boardNames) return;
  try { const r = await fetch("/api/viewer-boards", { cache: "no-store" }); boardNames = new Map((await r.json()).templates.flatMap((t) => t.boards.map((b) => [b.id, b.name.replace(/^[^:]*:\s*/, "")]))); }
  catch { boardNames = new Map(); }
}
const boardName = (id) => boardNames?.get(id) || (id ? "a board no longer offered" : "");

async function load() {
  await loadBoards();
  const days = Number($("viewer-days").value);
  const since = days ? new Date(Date.now() - days * 864e5).toISOString() : "";
  try {
    rows = await Auth.db(`viewer_visits?select=*${since ? `&started_at=gte.${since}` : ""}&order=started_at.desc&limit=2000`);
  } catch (e) { $("viewer-rows").innerHTML = `<tr><td colspan="13" class="error">Couldn't load the visits: ${esc(e.message)}</td></tr>`; return; }
  try { loads = await Auth.db(`viewer_page_loads?select=*${since ? `&at=gte.${since}` : ""}&order=at.desc&limit=5000`); }
  catch { loads = null; }   // (before 54-viewer-events.sql is run)
  render();
}
function badges(d, r) {
  return [d.full && `<span class="viewer-did">Full screen${d.full > 1 ? ` ×${d.full}` : ""}</span>`, d.downloaded && '<span class="viewer-did">Downloaded</span>',
    d.shared ? '<span class="viewer-did">Shared</span>' : d.shareStarted && '<span class="viewer-did">Share started</span>',
    d.emailed && `<span class="viewer-did">Emailed${d.emailed > 1 ? ` ×${d.emailed}` : ""}</span>`,
    d.failed && '<span class="viewer-did bad">Viewer failed</span>', d.background && '<span class="viewer-did">Background load</span>',
    d.v5 && !d.background && !stayed(r) && '<span class="viewer-did">Left under 3 s</span>'].filter(Boolean).join(" ");
}
function render() {
  const all = $("viewer-all").checked, shown = all ? rows : rows.filter(built);
  const f = funnel(rows, loads || null);
  $("viewer-summary").textContent = `${rows.length} visit${rows.length === 1 ? "" : "s"} · ${f.stayed} stayed 3 s+ · ${f.edited} edited · ${f.quotes} asked for a quote${f.sent ? ` (${f.sent} sent the form)` : ""}`;
  const withConfig = rows.filter((r) => r.config);
  $("viewer-breakdown").innerHTML = rows.length || loads?.length ? funnelHtml(f)
    + breakdownHtml("By ad source", breakdown(rows, (r) => sourceOf(r.source), loads || null), { pageLoads: !!loads })
    + breakdownHtml("By device and browser", breakdown(rows, deviceOf))
    + breakdownHtml("By location type", breakdown(withConfig, (r) => typeOf(normalizeConfig(r.config)))) : "";
  $("viewer-rows").innerHTML = shown.length ? shown.map((r) => {
    const c = normalizeConfig(r.config), d = did(r), none = !r.config;
    return `<tr data-id="${esc(r.id)}"${built(r) ? "" : ' class="viewer-load-only"'}>
      <td>${esc(when(r.started_at))}<div class="sub">${esc(r.id.slice(0, 8).toUpperCase())}</div>${r.updated_at && Date.parse(r.updated_at) - Date.parse(r.started_at) > 60e3 ? `<div class="sub">last ${esc(when(r.updated_at))}</div>` : ""}</td>
      <td>${none ? '<span class="muted">—</span>' : esc(KINDS[c.kind])}</td><td>${none ? "" : c.type ? esc(TYPES[c.type]) : '<span class="muted">Not specified</span>'}</td>
      <td>${none ? `<span class="muted">${d.failed ? "(the viewer failed to start)" : "(the viewer didn't start)"}</span>` : !built(r) ? '<span class="muted">(looked, built nothing)</span>' : c.name ? esc(c.name) : '<span class="muted">(no name)</span>'}${!none && c.subtitle ? `<div class="sub">${esc(c.subtitle)}</div>` : ""}</td>
      <td>${none ? "" : c.kind === "menu" ? `<span class="sub">${esc(boardName(c.board))}</span>${(c.items || []).length ? `<div class="sub">${c.items.filter((x) => x.name || x.price).length} items typed in</div>` : ""}`
        : `${c.tenants}${typedIn(c) ? `<div class="sub">${typedIn(c)} typed in</div>` : ""}`}</td><td>${none ? "" : c.shape === "portrait" ? "Portrait" : "Landscape"}</td><td>${none ? "" : esc(extras(c))}</td>
      <td>${esc(spent(r.seconds))}<div class="sub">${d.v5 ? `${d.edits} edit${d.edits === 1 ? "" : "s"}` : `${r.changes} change${r.changes === 1 ? "" : "s"}`}</div></td>
      <td>${esc(deviceOf(r))}</td>
      <td>${esc(from(r.source)) || '<span class="muted">—</span>'}</td>
      <td>${badges(d, r)}</td>
      <td>${r.quote ? `<span class="viewer-quote ${esc(r.quote)}">${r.quote === "sent" ? "Sent" : "Started"}</span>` : ""}</td>
      <td class="actions">${none ? "" : '<button type="button" class="ghost" data-view>View</button> '}<button type="button" class="ghost danger" data-remove>Remove</button></td></tr>`;
  }).join("") : `<tr><td colspan="13" class="muted">${rows.length ? "No visits built anything in this period: tick Show page loads too to see the rest." : "No visits yet in this period."}</td></tr>`;
}

// View: the visitor's preview, redrawn; V5: or as it was each time they opened the full-screen view
function view(r, cfg = r.config, label = "") {
  const c = normalizeConfig(cfg), land = c.shape === "landscape", W = land ? 1920 : 1080, H = land ? 1080 : 1920;
  $("viewer-dlg-title").textContent = c.name || "(no name)";
  $("viewer-dlg-line").textContent = `${summary(c, { boardName: c.kind === "menu" ? boardName(c.board) : "" })} · code ${r.id.slice(0, 8).toUpperCase()} · ${when(r.started_at)}${label ? ` · ${label}` : ""}`;
  const snaps = r.snapshots || [];
  $("viewer-dlg-snaps").innerHTML = snaps.length ? `<span class="sub">Full screen opened:</span> <button type="button" class="ghost${label ? "" : " on"}" data-snap="-1">Last choices</button> `
    + snaps.map((s, i) => `<button type="button" class="ghost${label === `full screen at ${when(s.at)}` ? " on" : ""}" data-snap="${i}">${esc(when(s.at))}</button>`).join(" ") : "";
  $("viewer-dlg-snaps").onclick = (e) => { const b = e.target.closest("[data-snap]"); if (!b) return; const i = Number(b.dataset.snap); if (i < 0) view(r); else view(r, snaps[i].config, `full screen at ${when(snaps[i].at)}`); };
  const dlg = $("viewer-dlg"), box = $("viewer-dlg-screen"), f = $("viewer-dlg-frame");
  if (!dlg.open) dlg.showModal();
  const s = Math.min((box.parentElement.clientWidth - 16) / W, (window.innerHeight * 0.66) / H);
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
  if (f.getAttribute("src") === "/index.html?preview=1") f.onload(); else f.src = "/index.html?preview=1";
}

$("viewer-rows").addEventListener("click", async (e) => {
  const tr = e.target.closest("tr[data-id]"); if (!tr) return;
  const r = rows.find((x) => x.id === tr.dataset.id); if (!r) return;
  if (e.target.closest("[data-view]")) view(r);
  if (e.target.closest("[data-remove]")) {
    if (!confirm(`Remove this visit (${r.id.slice(0, 8).toUpperCase()})? Use this for your own test visits.`)) return;
    try {
      await Auth.db(`viewer_visits?id=eq.${r.id}`, { method: "DELETE" });
      if (r.page_load && loads) { await Auth.db(`viewer_page_loads?id=eq.${r.page_load}`, { method: "DELETE" }).catch(() => {}); loads = loads.filter((l) => l.id !== r.page_load); }   // V5: its page load with it
      rows = rows.filter((x) => x.id !== r.id); render();
    }
    catch (err) { alert(`Not removed: ${err.message}`); }
  }
});
$("viewer-days").addEventListener("change", load);
$("viewer-all").addEventListener("change", render);
$("viewer-csv").addEventListener("click", () => {
  const a = document.createElement("a"), days = $("viewer-days").value;
  a.href = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv" }));   // every visit in the period, page loads included
  a.download = `waytugo-viewer-visits-${days === "0" ? "all" : `${days}-days`}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("viewer-dlg").addEventListener("close", () => { $("viewer-dlg-frame").src = "about:blank"; });

// ── V5b: Viewer emails (Email Me a Copy's settings) ──
async function loadMail() {
  let d; try { d = await Auth.api("/api/viewer-email-settings"); } catch (e) { $("vmail-server").textContent = `couldn't load: ${e.message}`; return; }
  const st = d.settings, snd = d.sender;
  $("vmail-on").checked = !!st.enabled; $("vmail-name").value = st.from_name || ""; $("vmail-from").value = st.from_address || ""; $("vmail-reply").value = st.reply_to || ""; $("vmail-limit").value = st.daily_limit || 50;
  $("vmail-server").textContent = snd.server ? `${snd.server}${snd.from ? `, from ${snd.from}` : ""}; set under Pi setup → Alert emails` : "none set up yet: Pi setup → Alert emails";
  $("vmail-note").innerHTML = [d.from ? `Emails go from <strong>${esc(d.from)}</strong>${st.reply_to ? `, replies to <strong>${esc(st.reply_to)}</strong>` : ""}.` : "No From address yet.",
    d.gmail ? "This mail server is Gmail: it sends from the Gmail account's own address, or a <em>Send mail as</em> address set up in that Gmail account; any other From address is replaced with the account's. Use <em>Replies go to</em> for a business address until WayTuGo has its own mail server." : "",
    st.missing ? "Run <code>55-viewer-email.sql</code> in Supabase first." : ""].filter(Boolean).join(" ");
}
$("vmail-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await Auth.api("/api/viewer-email-settings", { method: "POST", body: { action: "save", enabled: $("vmail-on").checked, from_name: $("vmail-name").value, from_address: $("vmail-from").value, reply_to: $("vmail-reply").value, daily_limit: $("vmail-limit").value } });
    $("vmail-out").hidden = false; $("vmail-out").textContent = $("vmail-on").checked ? "Saved. Visitors now see Email me a copy." : "Saved. Email me a copy is off.";
    loadMail();
  } catch (ex) { $("vmail-out").hidden = false; $("vmail-out").textContent = ex.message; }
});
$("vmail-test").addEventListener("click", async () => {
  const out = $("vmail-out"); out.hidden = false; out.textContent = "Sending…";
  try {
    const r = await Auth.api("/api/viewer-email-settings", { method: "POST", body: { action: "test", email: $("vmail-test-to").value } });
    out.textContent = r.ok ? `Sent a test copy to ${r.to}.` : `Not sent: ${r.error}`;
  } catch (ex) { out.textContent = ex.message; }
});

window.ConsoleViewer = { show: () => { load(); loadMail(); } };
if (location.hash === "#viewer" && !document.getElementById("panel-viewer").hidden) { load(); loadMail(); }
