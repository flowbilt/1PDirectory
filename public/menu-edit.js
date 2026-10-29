// The menu editor (DP-12, round E2a; supabase/32-menus.sql, public/menu-format.mjs). Desktop first; the phone version
// is a later round of its own.
//   /menu-edit.html?m=<menu id>
// The customer edits the lists WayTuGo built into their boards: items (name, description, price, picture, tags, link),
// Sold out today, Hide, the order, a price over a whole list, hours, the announcement and the bottom line. List
// headings, sizes and places are the layout's (1Point). Each list has room for a set number of entries ("12 of 16");
// past that is a menu expansion, from 1Point. Save checks the rules, then draws every board on this menu with the
// changes and refuses a save that would make a list run out of its box; then it goes live at once (menu_save, as the
// signed-in user, so the database decides who may). Every save is kept, with who made it; Restore puts one back.
import { checkMenuContent, menuChanges, newEntryId, capOf, shownEntries, ITEM_TAGS, FIELD_LABEL } from "/menu-format.mjs";
import { zonedNow } from "/layout-format.mjs";

const { esc, toast, since } = window.UI;
const $ = (id) => document.getElementById(id);
const MENU_ID = new URLSearchParams(location.search).get("m") || "";
const DAYS = ["M", "T", "W", "T", "F", "S", "S"], DAYNAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const E = { me: null, admin: false, menu: null, spec: null, saved: null, draft: null, boards: [], pics: [], revs: [], tz: "America/Chicago",
  menuBase: "https://waytugo.com/m/", frameReady: false, waiters: [], reportWaiter: null, lastReport: null, board: null };
const canEdit = () => E.admin || (E.menu?.customer_edit && ["org_admin", "org_editor"].includes(E.me?.role));
const today = () => zonedNow(Date.now(), E.tz).date;
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── Load ──
async function load() {
  await Auth.requireSession();
  E.me = await Auth.me();
  E.admin = E.me.role === "platform_admin";
  if (!/^[0-9a-f-]{36}$/.test(MENU_ID)) throw new Error("Open a menu from the console's Menus tab.");
  const [m] = await Auth.db(`menus?id=eq.${MENU_ID}&select=*`);
  if (!m) throw new Error("That menu doesn't exist, or you don't have access to it.");
  E.menu = m; E.spec = m.spec;
  E.saved = normalise(m.content);
  E.draft = clone(E.saved);
  try { const c = await Auth.config(); if (c.menuBase) E.menuBase = c.menuBase; } catch { /* the default */ }
  const [layouts, pics, props] = await Promise.all([
    Auth.db(`layouts?menu_id=eq.${MENU_ID}&select=id,name,orientation,published_version,menu_code&order=name.asc`),
    Auth.db(`layout_images?org_id=eq.${m.org_id}&select=key,name,path&order=name.asc`).catch(() => []),
    Auth.db(`properties?org_id=eq.${m.org_id}&select=id,name,timezone&order=name.asc`).catch(() => []),
  ]);
  E.pics = pics;
  const live = layouts.filter((l) => l.published_version);
  const versions = live.length ? await Auth.db(`layout_versions?layout_id=in.(${live.map((l) => l.id).join(",")})&select=layout_id,version,doc`) : [];
  const screens = live.length ? await Auth.db(`screens?layout_id=in.(${live.map((l) => l.id).join(",")})&select=layout_id,property_id`).catch(() => []) : [];
  E.boards = live.map((l) => {
    const sc = screens.find((s) => s.layout_id === l.id && s.property_id);
    const prop = props.find((p) => p.id === sc?.property_id) || props[0] || null;
    return { ...l, doc: versions.find((v) => v.layout_id === l.id && v.version === l.published_version)?.doc || null, prop };
  }).filter((b) => b.doc);
  E.tz = E.boards[0]?.prop?.timezone || props[0]?.timezone || "America/Chicago";
  await loadHistory();
}
async function loadHistory() {
  E.revs = await Auth.db(`menu_revisions?menu_id=eq.${MENU_ID}&select=rev,content,saved_at,by_name,by_1point,restored_from&order=rev.desc&limit=60`).catch(() => []);
}
/** Every list the spec has, with an entries array, so the editor can draw them all */
function normalise(content) {
  const out = { lists: {} };
  for (const L of E.spec.lists || []) out.lists[L.key] = clone(content?.lists?.[L.key] || { entries: [] });
  for (const L of E.spec.lists || []) out.lists[L.key].entries ||= [];
  return out;
}

// ── Drawing the lists ──
const pickPic = (L, e, i) => {
  const opts = [`<option value="">(no picture)</option>`, ...E.pics.map((p) => `<option value="img:${esc(p.key)}"${e.image === `img:${p.key}` ? " selected" : ""}>${esc(p.name || p.key)}</option>`)];
  if (e.image && !E.pics.some((p) => `img:${p.key}` === e.image)) opts.push(`<option value="${esc(e.image)}" selected>${esc(e.image.slice(4))} (missing)</option>`);
  const pic = E.pics.find((p) => `img:${p.key}` === e.image);
  return `<div class="me-pic">${pic ? `<img src="/img/${esc(pic.path)}" alt="">` : `<span class="me-nopic"></span>`}<select data-f="image" aria-label="Picture for item ${i + 1}">${opts.join("")}</select></div>`;
};
const textBox = (L, f, e, i, wide) => {
  const cap = capOf(L, f), v = e[f] || "";
  const label = `${FIELD_LABEL[f]} for ${L.kind === "items" ? `item ${i + 1}` : "this entry"}`;
  return f === "body"
    ? `<textarea data-f="${f}" maxlength="${cap}" rows="2" aria-label="${esc(label)}" placeholder="${esc(FIELD_LABEL[f])}">${esc(v)}</textarea>`
    : `<input data-f="${f}" maxlength="${cap}" value="${esc(v)}" aria-label="${esc(label)}" placeholder="${esc(FIELD_LABEL[f])}${f === "price" ? " e.g. $4.49" : ""}" class="me-${f}${wide ? " wide" : ""}">`;
};
function itemRow(L, e, i, n) {
  const f = L.fields;
  const sold = e.soldOut === today();
  const cells = [];
  for (const x of f) {
    if (x === "image") cells.push(pickPic(L, e, i));
    else if (x === "tags") cells.push(`<div class="me-tags" role="group" aria-label="Tags for item ${i + 1}">${Object.entries(ITEM_TAGS).map(([t, lbl]) => `<label class="me-tag"><input type="checkbox" data-tag="${t}"${(e.tags || []).includes(t) ? " checked" : ""}> ${lbl}</label>`).join("")}</div>`);
    else if (x === "link") cells.push(`<input data-f="link" maxlength="300" value="${esc(e.link || "")}" placeholder="Web link (optional), https://…" aria-label="Web link for item ${i + 1}" class="me-link">`);
    else cells.push(textBox(L, x, e, i));
  }
  return `<li class="me-row${e.hidden ? " is-hidden" : ""}${sold ? " is-sold" : ""}" data-i="${i}">
    <div class="me-fields">${cells.join("")}</div>
    <div class="me-switches">
      <label class="check inline"><input type="checkbox" data-sw="sold"${sold ? " checked" : ""}> Sold out today</label>
      <label class="check inline"><input type="checkbox" data-sw="hidden"${e.hidden ? " checked" : ""}> Hide</label>
    </div>
    <div class="me-move">
      <button type="button" class="icon-btn" data-mv="-1" aria-label="Move item ${i + 1} up"${i === 0 ? " disabled" : ""}>↑</button>
      <button type="button" class="icon-btn" data-mv="1" aria-label="Move item ${i + 1} down"${i === n - 1 ? " disabled" : ""}>↓</button>
      <button type="button" class="icon-btn danger" data-rm aria-label="Remove item ${i + 1}">✕</button>
    </div></li>`;
}
function hoursRow(L, e, i, n) {
  return `<li class="me-row me-hours" data-i="${i}">
    <div class="me-days" role="group" aria-label="Days for line ${i + 1}">${DAYS.map((d, k) => `<label class="me-day" title="${DAYNAMES[k]}"><input type="checkbox" data-day="${k + 1}"${(e.days || []).includes(k + 1) ? " checked" : ""}><span>${d}</span></label>`).join("")}</div>
    <label class="me-time">Opens <input type="time" data-f="open" value="${esc(e.open || "")}"></label>
    <label class="me-time">Closes <input type="time" data-f="close" value="${esc(e.close || "")}"></label>
    <div class="me-move"><button type="button" class="icon-btn" data-mv="-1" aria-label="Move line ${i + 1} up"${i === 0 ? " disabled" : ""}>↑</button>
      <button type="button" class="icon-btn" data-mv="1" aria-label="Move line ${i + 1} down"${i === n - 1 ? " disabled" : ""}>↓</button>
      <button type="button" class="icon-btn danger" data-rm aria-label="Remove line ${i + 1}">✕</button></div></li>`;
}
function listHtml(L) {
  const C = E.draft.lists[L.key], es = C.entries, n = es.length, full = n >= L.room;
  const count = L.kind === "text" ? "" : `<span class="me-count${full ? " full" : ""}">${n} of ${L.room}</span>`;
  let body = "";
  if (L.kind === "text") {
    const e = es[0] || { id: "", hidden: false };
    body = `<div class="me-text" data-i="0">${L.fields.map((f) => (f === "link" ? `<input data-f="link" maxlength="300" value="${esc(e.link || "")}" placeholder="Web link (optional), https://…" aria-label="Web link" class="me-link">` : textBox(L, f, e, 0, true))).join("")}
      <label class="check inline"><input type="checkbox" data-sw="hidden"${e.hidden ? " checked" : ""}> Hide</label></div>`;
  } else {
    body = `<ol class="me-rows">${es.map((e, i) => (L.kind === "hours" ? hoursRow(L, e, i, n) : itemRow(L, e, i, n))).join("")}</ol>
      ${n ? "" : `<p class="hint">Nothing on this list yet: the board leaves its box out until something is added.</p>`}
      <div class="me-add"><button type="button" class="ghost" data-add${full ? " disabled" : ""}>${L.kind === "hours" ? "Add a line of hours" : "Add an item"}</button>
      ${full ? `<span class="hint">This list is full (${n} of ${L.room}). More room is a menu expansion: ask 1Point.</span>` : ""}</div>`;
  }
  const top = [
    L.groupPrice ? `<div class="field me-gp"><label>Price for the whole list <span class="hint">e.g. $1.89 each</span></label><input data-list-f="price" maxlength="24" value="${esc(C.price || "")}"></div>` : "",
    L.note ? `<div class="field me-gp"><label>Line under the hours <span class="hint">optional</span></label><input data-list-f="note" maxlength="80" value="${esc(C.note || "")}"></div>` : "",
  ].join("");
  return `<section class="panel me-list" data-key="${esc(L.key)}">
    <div class="panel-head"><h2>${esc(L.name)} ${count}</h2></div>
    ${L.hint ? `<p class="hint">${esc(L.hint)}</p>` : ""}${top}${body}</section>`;
}
function drawLists() {
  $("lists").innerHTML = `<p class="hint me-intro">Change what's on your boards here. The layout, headings, colours and sizes are set by 1Point; ask 1Point to change them, or for more room on a list.</p>`
    + (E.spec.lists || []).map(listHtml).join("");
  if (!canEdit()) $("lists").querySelectorAll("input, select, textarea, button").forEach((x) => (x.disabled = true));
  dirty();
}

// ── Editing ──
function entryAt(el) {
  const sec = el.closest(".me-list"); if (!sec) return {};
  const L = E.spec.lists.find((x) => x.key === sec.dataset.key), C = E.draft.lists[L.key];
  const row = el.closest("[data-i]");
  const i = row ? Number(row.dataset.i) : -1;
  if (L.kind === "text" && !C.entries[0] && row) C.entries[0] = { id: newEntryId() };
  return { L, C, i, e: C.entries[i] };
}
$("lists").addEventListener("input", (ev) => {
  const t = ev.target, { L, C, e } = entryAt(t);
  if (!L) return;
  if (t.dataset.listF) { C[t.dataset.listF] = t.value; if (!t.value) delete C[t.dataset.listF]; }
  else if (e && t.dataset.f) { if (t.value) e[t.dataset.f] = t.value; else delete e[t.dataset.f]; }
  if (t.dataset.f === "image") { drawLists(); return; }
  dirty(); schedulePreview();
});
$("lists").addEventListener("change", (ev) => {
  const t = ev.target, { L, e } = entryAt(t);
  if (!L || !e) return;
  if (t.dataset.tag) { const s = new Set(e.tags || []); t.checked ? s.add(t.dataset.tag) : s.delete(t.dataset.tag); e.tags = [...s]; if (!e.tags.length) delete e.tags; }
  if (t.dataset.day) { const s = new Set(e.days || []); t.checked ? s.add(Number(t.dataset.day)) : s.delete(Number(t.dataset.day)); e.days = [...s].sort(); }
  if (t.dataset.sw === "sold") { if (t.checked) e.soldOut = today(); else delete e.soldOut; t.closest(".me-row")?.classList.toggle("is-sold", t.checked); }
  if (t.dataset.sw === "hidden") { if (t.checked) e.hidden = true; else delete e.hidden; t.closest(".me-row")?.classList.toggle("is-hidden", t.checked); }
  dirty(); schedulePreview();
});
$("lists").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b || b.disabled) return;
  const { L, C, i } = entryAt(b); if (!L) return;
  if (b.dataset.add !== undefined) {
    if (C.entries.length >= L.room) return;
    C.entries.push(L.kind === "hours" ? { id: newEntryId(), days: [], open: "", close: "" } : { id: newEntryId(), name: "" });
    drawLists();
    const rows = $("lists").querySelector(`.me-list[data-key="${CSS.escape(L.key)}"]`).querySelectorAll(".me-row");
    rows[rows.length - 1]?.querySelector("input")?.focus();
  } else if (b.dataset.rm !== undefined) {
    C.entries.splice(i, 1); drawLists();
  } else if (b.dataset.mv) {
    const j = i + Number(b.dataset.mv);
    if (j < 0 || j >= C.entries.length) return;
    [C.entries[i], C.entries[j]] = [C.entries[j], C.entries[i]]; drawLists();
    $("lists").querySelector(`.me-list[data-key="${CSS.escape(L.key)}"] [data-i="${j}"] [data-mv="${b.dataset.mv}"]`)?.focus();
  } else return;
  schedulePreview();
});

/** What a save sends: blank new rows left out, a sold-out mark from another day dropped, empty values left out */
function tidy(content) {
  const out = { lists: {} };
  for (const L of E.spec.lists || []) {
    const C = content.lists[L.key] || { entries: [] };
    const entries = C.entries.map((e) => {
      const x = {};
      for (const [k, v] of Object.entries(e)) {
        if (v === "" || v === undefined || (Array.isArray(v) && !v.length && k !== "days")) continue;
        if (k === "soldOut" && v !== today()) continue;
        x[k] = typeof v === "string" && k !== "open" && k !== "close" && k !== "soldOut" && k !== "image" && k !== "id" ? v.trim() : v;
      }
      return x;
    }).filter((x) => Object.keys(x).some((k) => !["id", "hidden", "soldOut", "days"].includes(k) && x[k] !== "") || (L.kind === "hours" && (x.days || []).length));
    const o = { entries };
    if (C.price?.trim()) o.price = C.price.trim();
    if (C.note?.trim()) o.note = C.note.trim();
    if (entries.length || o.price || o.note) out.lists[L.key] = o;
  }
  return out;
}
const same = () => JSON.stringify(tidy(E.draft)) === JSON.stringify(tidy(E.saved));
function dirty() {
  const changed = !same();
  $("save").disabled = !changed || !canEdit();
  $("undo").disabled = !changed;
  $("saved-line").textContent = changed ? "Unsaved changes" : savedLine();
  document.title = `${changed ? "• " : ""}Edit menu: ${E.menu?.name || ""}`;
}
function savedLine() {
  const r = E.revs[0];
  return r ? `Saved ${since(r.saved_at)}${r.by_name ? ` by ${r.by_name}` : ""}` : "Not saved yet";
}
$("undo").addEventListener("click", () => { if (!confirm("Undo your changes since the last save?")) return; E.draft = clone(E.saved); drawLists(); schedulePreview(); });
window.addEventListener("beforeunload", (ev) => { if (!same()) { ev.preventDefault(); ev.returnValue = ""; } });

// ── Preview: the real board page, given each board with the changes; it reports which blocks overflow ──
window.addEventListener("message", (ev) => {
  if (ev.origin !== location.origin || ev.source !== $("pv").contentWindow) return;
  if (ev.data?.type === "layout-ready") { E.frameReady = true; E.waiters.splice(0).forEach((f) => f()); }
  if (ev.data?.type === "layout-report") { E.lastReport = ev.data; E.reportWaiter?.(); E.reportWaiter = null; }
});
function payload(board, content) {
  const images = Object.fromEntries(E.pics.map((p) => [p.key, { url: `/img/${p.path}`, w: 0, h: 0 }]));
  return { kind: "layout", key: "preview", orientation: board.orientation, layout: { id: board.id, name: board.name, version: board.published_version, doc: board.doc },
    images, menu: { url: E.menuBase + board.menu_code }, lists: { id: E.menu.id, spec: E.spec, content },
    propertyName: board.prop?.name || "", timezone: board.prop?.timezone || E.tz, weather: { enabled: false }, poweredBy: true };
}
function fitFrame() {
  const b = E.board; if (!b) return;
  const land = b.orientation === "landscape", cw = land ? 1920 : 1080, ch = land ? 1080 : 1920;
  const box = $("pv-box"); box.classList.toggle("landscape", land);
  const f = $("pv"); f.style.width = `${cw}px`; f.style.height = `${ch}px`; f.style.transform = `scale(${box.clientWidth / cw})`;
}
async function ensureFrame() {
  if (E.frameReady) return;
  await new Promise((res) => { E.waiters.push(res); $("pv").src = "/board.html?preview=1"; setTimeout(res, 8000); });
}
/** Draws a board with these lists; resolves with the blocks on lists that don't fit their box */
async function draw(board, content) {
  E.board = board; fitFrame(); await ensureFrame();
  const reported = new Promise((res) => { E.reportWaiter = res; setTimeout(res, 6000); });
  E.lastReport = null;
  $("pv").contentWindow.postMessage({ type: "layout-draft", data: payload(board, content) }, location.origin);
  $("pv").contentWindow.postMessage({ type: "layout-room", on: $("show-room").checked }, location.origin);
  await reported;
  const bound = new Map((board.doc.blocks || []).filter((b) => b.content?.list).map((b) => [b.id, b.content.list]));
  return (E.lastReport?.overflow || []).filter((id) => bound.has(id)).map((id) => bound.get(id));
}
let pvTimer = null;
function schedulePreview() { clearTimeout(pvTimer); pvTimer = setTimeout(previewNow, 450); }
async function previewNow() {
  const b = E.boards.find((x) => x.id === $("board-pick").value) || E.boards[0];
  if (!b) return;
  const over = await draw(b, tidy(E.draft));
  $("pv-note").innerHTML = over.length
    ? `<span class="warn">${esc(listNames(over))} no longer fit${over.length === 1 ? "s" : ""} on this board. Shorten what's written there.</span>`
    : "As the board will show it, with your changes, before you save.";
}
const listNames = (keys) => [...new Set(keys)].map((k) => `"${E.spec.lists.find((l) => l.key === k)?.name || k}"`).join(", ");
$("board-pick").addEventListener("change", () => { const b = E.boards.find((x) => x.id === $("board-pick").value); if (b) { $("phone-line").innerHTML = phoneLine(b); previewNow(); } });
$("show-room").addEventListener("change", () => $("pv").contentWindow?.postMessage({ type: "layout-room", on: $("show-room").checked }, location.origin));
window.addEventListener("resize", fitFrame);
const phoneLine = (b) => { const url = E.menuBase + b.menu_code; return `The phone menu (Take this menu with you): <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, ""))}</a> shows what's saved.`; };

// ── Save ──
function showProblems(html) { const el = $("save-problems"); el.innerHTML = html; el.hidden = !html; if (html) el.scrollIntoView({ block: "nearest" }); }
async function save(anyway = false) {
  showProblems("");
  const content = tidy(E.draft);
  const pics = new Set(E.pics.map((p) => p.key));
  const { errors } = checkMenuContent(E.spec, content, { images: pics });
  if (errors.length) { showProblems(`<strong>Fix these first:</strong><ul>${errors.map((x) => `<li><strong>${esc(x.where)}</strong>: ${esc(x.msg)}</li>`).join("")}</ul>`); return; }
  $("save").disabled = true; $("save").textContent = "Checking the boards…";
  try {
    // Every board on this menu, drawn with the changes: a list that runs out of its box isn't saved (1Point may save anyway)
    const over = [];
    for (const b of E.boards) { const o = await draw(b, content); if (o.length) over.push(`${listNames(o)} on ${b.name}`); }
    previewNow();
    if (over.length && !anyway) {
      showProblems(`<strong>This wouldn't fit on the board:</strong> ${esc(over.join("; "))}. Shorten the names or descriptions there, or hide an item.`
        + (E.admin ? ` <button type="button" class="ghost" id="save-anyway">Save anyway (1Point)</button>` : ""));
      return;
    }
    $("save").textContent = "Saving…";
    const r = await Auth.db("rpc/menu_save", { method: "POST", body: { p_menu: E.menu.id, p_base_rev: E.menu.rev, p_content: content } });
    E.menu.rev = r.rev;
    E.saved = normalise(content); E.draft = clone(E.saved);
    await loadHistory();
    drawLists(); drawHistory();
    toast("Saved. Every board on this menu shows it within a minute.");
  } catch (ex) {
    showProblems(`<strong>Not saved:</strong> ${esc(ex.message)}`);
  } finally {
    $("save").textContent = "Save: goes live"; dirty();
  }
}
$("save").addEventListener("click", () => save(false));
$("save-problems").addEventListener("click", (ev) => { if (ev.target.id === "save-anyway" && confirm("Save it although it doesn't fit? The list will be cut off on the board.")) save(true); });

// ── History ──
function drawHistory() {
  const revs = E.revs;
  $("history").innerHTML = revs.length ? revs.map((r, i) => {
    const prev = revs[i + 1];
    const lines = prev ? menuChanges(E.spec, prev.content, r.content, 8) : ["The menu's first lists"];
    const restoredNote = r.restored_from ? ` · restored save ${r.restored_from}` : "";
    return `<li><div class="mh-head"><strong>Save ${r.rev}</strong> <span class="sub">${esc(since(r.saved_at))}${r.by_name ? ` · ${esc(r.by_name)}` : ""}${r.by_1point ? " (1Point)" : ""}${restoredNote}</span>
        ${i === 0 ? `<span class="sub">· on the boards now</span>` : canEdit() ? `<button type="button" class="ghost" data-restore="${r.rev}">Restore</button>` : ""}</div>
      <ul class="mh-lines">${(lines.length ? lines : ["No changes"]).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></li>`;
  }).join("") : `<li class="hint">Not saved yet.</li>`;
}
$("history").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-restore]"); if (!b) return;
  if (!same() && !confirm("You have unsaved changes; restoring replaces them. Go ahead?")) return;
  if (!confirm(`Put save ${b.dataset.restore} back on the boards? It becomes the newest save; nothing is lost.`)) return;
  try {
    const r = await Auth.db("rpc/menu_restore", { method: "POST", body: { p_menu: E.menu.id, p_rev: Number(b.dataset.restore), p_base_rev: E.menu.rev } });
    E.menu.rev = r.rev;
    const [m] = await Auth.db(`menus?id=eq.${MENU_ID}&select=content,rev`);
    E.saved = normalise(m.content); E.draft = clone(E.saved);
    await loadHistory(); drawLists(); drawHistory(); previewNow();
    toast(`Save ${b.dataset.restore} is back on the boards.`);
  } catch (ex) { toast(ex.message, true); }
});

// ── Start ──
(async () => {
  try {
    await load();
    $("heading").textContent = E.menu.name;
    $("readonly").hidden = canEdit();
    $("workspace").hidden = false;
    $("board-pick").innerHTML = E.boards.length ? E.boards.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("") : `<option value="">No board shows this menu yet</option>`;
    if (E.boards[0]) $("phone-line").innerHTML = phoneLine(E.boards[0]);
    else $("pv-note").textContent = "Once 1Point publishes a board on this menu, it shows here.";
    drawLists(); drawHistory();
    if (E.boards.length) previewNow();
  } catch (ex) {
    $("load-error").textContent = ex.message; $("load-error").hidden = false;
  }
})();

window.MenuEditor = { get state() { return E; }, tidy: () => tidy(E.draft), shown: (key) => shownEntries(E.spec.lists.find((l) => l.key === key), E.draft.lists[key]) };   // for the browser checks
