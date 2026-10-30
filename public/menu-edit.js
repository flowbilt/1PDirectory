// The menu editor (DP-12, round E2a; supabase/32-menus.sql, public/menu-format.mjs). Desktop first; the phone version
// is a later round of its own.
//   /menu-edit.html?m=<menu id>
// The customer edits the lists WayTuGo built into their boards: items (name, description, price, picture, tags, link),
// Sold out today, Hide, the order, a price over a whole list, hours, the announcement and the bottom line. List
// headings, sizes and places are the layout's (1Point). Each list has room for a set number of entries ("12 of 16");
// past that is a menu expansion, from 1Point. Save checks the rules, then draws every board on this menu with the
// changes and refuses a save that would make a list run out of its box; then it goes live at once (menu_save, as the
// signed-in user, so the database decides who may). Every save is kept, with who made it; Restore puts one back.
// E2b: on a list WayTuGo has set up with dates and times, each entry has a When (first and last day, days, times) and
// says whether it's on now; Preview full size opens the board with the changes in its own window; every board on the
// menu is checked as the customer types (hidden checker frames), and a list that won't fit is marked at once.
// E2c: Your pictures: the account's own pictures (upload, rename, remove one that isn't on the boards; the room per
// account, "12 of 100"); an item's picture is chosen in a picker with thumbnails, where a new one can be uploaded too
// (/api/pictures). Restoring a save whose picture has since been removed brings the item back without it, and says so.
// E2d (DP-13): Board look: for each board whose layout offers choices (the chalkboard: House or Chalkboard, chalk colours
// from six for titles, prices and accents, Sign-writer or Chalk hand lettering, the wooden frame, and options such as
// "Show the coffee bar"), the customer (and WayTuGo) picks them here; they're saved with the menu (content.boards),
// shown in the preview at once, checked for fit like any change, and kept in History.
import { checkMenuContent, menuChanges, newEntryId, capOf, shownEntries, describeWhen, entryStatus, menuPictureKeys, ITEM_TAGS, FIELD_LABEL } from "/menu-format.mjs";
import { shrink, asDataUrl, niceName } from "/picture-shrink.mjs";
import { zonedNow, checkLayout, boardChoice, offersChoice, LOOKS, CHALK, CHALK_NAMES, CHALK_ROLES, LETTERING } from "/layout-format.mjs";
const nowHere = () => zonedNow(Date.now(), E.tz);

const { esc, toast, since } = window.UI;
const $ = (id) => document.getElementById(id);
const MENU_ID = new URLSearchParams(location.search).get("m") || "";
const DAYS = ["M", "T", "W", "T", "F", "S", "S"], DAYNAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const E = { me: null, admin: false, menu: null, spec: null, saved: null, draft: null, boards: [], pics: [], revs: [], tz: "America/Chicago",
  menuBase: "https://waytugo.com/m/", frameReady: false, waiters: [], reportWaiter: null, lastReport: null, board: null,
  openWhen: new Set(), full: null, checkers: [], nofit: new Map(), checkGen: 0,
  picRoom: 100, picChange: false, renaming: null, picTarget: null };
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
  const [layouts, props] = await Promise.all([
    Auth.db(`layouts?menu_id=eq.${MENU_ID}&select=id,name,orientation,published_version,menu_code&order=name.asc`),
    Auth.db(`properties?org_id=eq.${m.org_id}&select=id,name,timezone&order=name.asc`).catch(() => []),
    loadPics(),
  ]);
  const live = layouts.filter((l) => l.published_version);
  const versions = live.length ? await Auth.db(`layout_versions?layout_id=in.(${live.map((l) => l.id).join(",")})&select=layout_id,version,doc`) : [];
  const screens = live.length ? await Auth.db(`screens?layout_id=in.(${live.map((l) => l.id).join(",")})&select=layout_id,property_id`).catch(() => []) : [];
  E.boards = live.map((l) => {
    const sc = screens.find((s) => s.layout_id === l.id && s.property_id);
    const prop = props.find((p) => p.id === sc?.property_id) || props[0] || null;
    const doc = versions.find((v) => v.layout_id === l.id && v.version === l.published_version)?.doc || null;
    return { ...l, doc, checked: doc ? checkLayout(doc).doc : null, prop };   // E2d: checked, for its looks and options
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
  out.boards = clone(content?.boards || {});   // E2d
  return out;
}

// ── Drawing the lists ──
const pickPic = (L, e, i) => {
  const pic = E.pics.find((p) => `img:${p.key}` === e.image);
  const name = pic ? esc(pic.name || pic.key) : e.image ? `<span class="me-pic-missing">${esc(e.image.slice(4))}: removed. Choose another.</span>` : `<span class="sub">No picture</span>`;
  return `<div class="me-pic">${pic ? `<img src="/img/${esc(pic.path)}" alt="">` : `<span class="me-nopic"></span>`}<span class="me-pic-name">${name}</span>
    <button type="button" class="ghost me-pic-btn" data-pick aria-label="Choose the picture for item ${i + 1}">${e.image ? "Change" : "Choose…"}</button></div>`;
};
const textBox = (L, f, e, i, wide) => {
  const cap = capOf(L, f), v = e[f] || "";
  const label = `${FIELD_LABEL[f]} for ${L.kind === "items" ? `item ${i + 1}` : "this entry"}`;
  return f === "body"
    ? `<textarea data-f="${f}" maxlength="${cap}" rows="2" aria-label="${esc(label)}" placeholder="${esc(FIELD_LABEL[f])}">${esc(v)}</textarea>`
    : `<input data-f="${f}" maxlength="${cap}" value="${esc(v)}" aria-label="${esc(label)}" placeholder="${esc(FIELD_LABEL[f])}${f === "price" ? " e.g. $4.49" : ""}" class="me-${f}${wide ? " wide" : ""}">`;
};
// E2b: an entry's When, on a list with dates and times
function whenHtml(L, e) {
  if (!L.schedule) return "";
  const w = e.when || {}, open = E.openWhen.has(`${L.key}:${e.id}`), st = entryStatus(e, nowHere());
  const cls = !st ? "" : st === "On now" ? "on" : "off";
  return `<div class="me-when"><span class="me-when-sum">When: <strong>${esc(describeWhen(e.when && Object.keys(e.when).length ? e.when : null))}</strong>${st ? ` <span class="me-status ${cls}">${esc(st)}</span>` : ""}</span>
    <button type="button" class="ghost me-when-btn" data-when-toggle aria-expanded="${open}">${open ? "Done" : "Change"}</button>
    ${open ? `<div class="me-when-panel">
      <label class="me-time">First day <input type="date" data-wf="dfrom" value="${esc(w.dates?.from || "")}"></label>
      <label class="me-time">Last day <input type="date" data-wf="dto" value="${esc(w.dates?.to || "")}"></label>
      <div class="me-days" role="group" aria-label="Days (none ticked: every day)">${DAYS.map((d, k) => `<label class="me-day" title="${DAYNAMES[k]}"><input type="checkbox" data-wday="${k + 1}"${(w.days || []).includes(k + 1) ? " checked" : ""}><span>${d}</span></label>`).join("")}</div>
      <label class="me-time">From <input type="time" data-wf="tfrom" value="${esc(w.from || "")}"></label>
      <label class="me-time">To <input type="time" data-wf="tto" value="${esc(w.to || "")}"></label>
      <button type="button" class="ghost" data-when-clear>Always</button>
      <p class="hint">Leave out what doesn't matter: no days ticked is every day; no times is all day. It shows only while all of it is true, by the shop's clock.</p></div>` : ""}</div>`;
}
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
    <div class="me-fields">${cells.join("")}${whenHtml(L, e)}</div>
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
      ${e.id ? whenHtml(L, e) : ""}
      <label class="check inline"><input type="checkbox" data-sw="hidden"${e.hidden ? " checked" : ""}> Hide</label></div>`;
  } else {
    body = `<ol class="me-rows">${es.map((e, i) => (L.kind === "hours" ? hoursRow(L, e, i, n) : itemRow(L, e, i, n))).join("")}</ol>
      ${n ? "" : `<p class="hint">Nothing on this list yet: the board leaves its box out until something is added.</p>`}
      <div class="me-add"><button type="button" class="ghost" data-add${full ? " disabled" : ""}>${L.kind === "hours" ? "Add a line of hours" : "Add an item"}</button>
      ${full ? `<span class="hint">This list is full (${n} of ${L.room}). More room is a menu expansion: ask WayTuGo.</span>` : ""}</div>`;
  }
  const top = [
    L.groupPrice ? `<div class="field me-gp"><label>Price for the whole list <span class="hint">e.g. $1.89 each</span></label><input data-list-f="price" maxlength="24" value="${esc(C.price || "")}"></div>` : "",
    L.note ? `<div class="field me-gp"><label>Line under the hours <span class="hint">optional</span></label><input data-list-f="note" maxlength="80" value="${esc(C.note || "")}"></div>` : "",
  ].join("");
  const nofit = E.nofit.get(L.key);
  return `<section class="panel me-list${nofit ? " nofit" : ""}" data-key="${esc(L.key)}">
    <div class="panel-head"><h2>${esc(L.name)} ${count}</h2></div>
    <p class="me-nofit" role="status"${nofit ? "" : " hidden"}>${nofit ? esc(nofitText(nofit)) : ""}</p>
    ${L.hint ? `<p class="hint">${esc(L.hint)}</p>` : ""}${top}${body}</section>`;
}
// ── Board look (E2d): a board's look and options, from the presets its layout offers ──
function lookHtml(b) {
  const doc = b.checked, ch = boardChoice(doc, E.draft.boards?.[b.id]), mine = E.draft.boards?.[b.id] && Object.keys(E.draft.boards[b.id]).length;
  const looks = doc.theme.looks || ["house"], chalk = ch.look === "chalkboard";
  const radio = (name, val, label, on) => `<label class="me-choice${on ? " is-on" : ""}"><input type="radio" name="${esc(name)}" data-look-f="${esc(name.split(":")[0])}" value="${esc(val)}"${on ? " checked" : ""}> ${esc(label)}</label>`;
  const swatches = (role) => `<div class="me-swatches" role="radiogroup" aria-label="${esc(CHALK_ROLES[role])} chalk">${Object.entries(CHALK).map(([k, hex]) =>
    `<label class="me-swatch${ch.chalk[role] === k ? " is-on" : ""}" title="${esc(CHALK_NAMES[k])}"><input type="radio" name="chalk-${role}:${b.id}" data-look-f="chalk" data-role="${role}" value="${k}"${ch.chalk[role] === k ? " checked" : ""}>`
    + `<span style="background:${hex}"></span><em>${esc(CHALK_NAMES[k])}</em></label>`).join("")}</div>`;
  return `<section class="panel me-look" data-board="${esc(b.id)}">
    <div class="panel-head"><h2>Board look <span class="sub">· ${esc(b.name)}</span></h2></div>
    <p class="hint">Choose how this board looks. Every choice here is made to read well on the board; the preview shows it before you save.</p>
    ${looks.length > 1 ? `<div class="me-look-row"><span class="me-look-label">Look</span>${looks.map((l) => radio(`look:${b.id}`, l, LOOKS[l], ch.look === l)).join("")}</div>` : ""}
    ${chalk ? Object.keys(CHALK_ROLES).map((r) => `<div class="me-look-row"><span class="me-look-label">${esc(CHALK_ROLES[r])}</span>${swatches(r)}</div>`).join("")
      + `<div class="me-look-row"><span class="me-look-label">Lettering</span>${Object.entries(LETTERING).map(([k, lbl]) => radio(`lettering:${b.id}`, k, lbl, ch.chalk.lettering === k)).join("")}</div>`
      + `<div class="me-look-row"><span class="me-look-label">Frame</span><label class="check inline"><input type="checkbox" data-look-f="frame"${ch.chalk.frame ? " checked" : ""}> Wooden frame around the board</label></div>` : ""}
    ${(doc.options || []).length ? `<div class="me-look-row"><span class="me-look-label">Show</span>${doc.options.map((o) => `<label class="check inline"><input type="checkbox" data-look-f="option" data-opt="${esc(o.key)}"${ch.options[o.key] ? " checked" : ""}> ${esc(o.label)}</label>`).join("")}</div>` : ""}
    ${mine ? `<button type="button" class="ghost" data-look-reset>Back to WayTuGo's design</button>` : ""}
  </section>`;
}
function drawLists() {
  $("lists").innerHTML = `<p class="hint me-intro">Change what's on your boards here. The layout, headings, colours and sizes are set by WayTuGo; ask WayTuGo to change them, or for more room on a list.</p>`
    + E.boards.filter((b) => b.checked && offersChoice(b.checked)).map(lookHtml).join("")
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
// ── The character count (after E2b; Scot: a box at its limit just stopped taking letters, with nothing said) ──
// Near a box's limit (80% of it) a small count shows under the box; at the limit it says why it stops.
const chars = document.createElement("div");
chars.className = "me-chars"; chars.hidden = true; chars.setAttribute("role", "status"); chars.setAttribute("aria-live", "polite");
document.body.appendChild(chars);
function showChars(el) {
  const max = Number(el?.getAttribute?.("maxlength")) || 0;
  if (!max || !(el.matches("input:not([type]), input[type=text], textarea"))) { chars.hidden = true; return; }
  const n = el.value.length;
  if (n < Math.floor(max * 0.8)) { chars.hidden = true; return; }
  chars.textContent = n >= max ? `${max} of ${max} · the most this box holds on the board` : `${n} of ${max}`;
  chars.classList.toggle("full", n >= max);
  const r = el.getBoundingClientRect();
  // under the box, or above it when the box is near the bottom of the window
  chars.style.left = `${Math.round(r.left)}px`; chars.style.top = `${Math.round(r.bottom + 28 > window.innerHeight ? r.top - 26 : r.bottom + 4)}px`;
  chars.hidden = false;
}
$("lists").addEventListener("focusin", (ev) => showChars(ev.target));
$("lists").addEventListener("focusout", () => { chars.hidden = true; });
window.addEventListener("scroll", () => { if (!chars.hidden) showChars(document.activeElement); }, { passive: true });

/** One part of an entry's When, from the editor's boxes (an empty box takes that part out) */
function setWhen(e, part, v) {
  const w = e.when || {};
  if (part === "dfrom" || part === "dto") { const d = { ...(w.dates || {}) }; const k = part === "dfrom" ? "from" : "to"; if (v) d[k] = v; else delete d[k]; if (Object.keys(d).length) w.dates = d; else delete w.dates; }
  if (part === "tfrom" || part === "tto") { const k = part === "tfrom" ? "from" : "to"; if (v) w[k] = v; else delete w[k]; }
  if (Object.keys(w).length) e.when = w; else delete e.when;
}
/** The When line's words and its On now / Starts … label, without redrawing (so typing keeps its place) */
function refreshWhen(t, L, e) {
  const box = t.closest(".me-when"); if (!box) return;
  const st = entryStatus(e, nowHere());
  box.querySelector(".me-when-sum").innerHTML = `When: <strong>${esc(describeWhen(e.when && Object.keys(e.when).length ? e.when : null))}</strong>${st ? ` <span class="me-status ${st === "On now" ? "on" : "off"}">${esc(st)}</span>` : ""}`;
}
$("lists").addEventListener("input", (ev) => {
  showChars(ev.target);
  const t = ev.target, { L, C, e } = entryAt(t);
  if (!L) return;
  if (t.dataset.wf && e) { setWhen(e, t.dataset.wf, t.value); refreshWhen(t, L, e); dirty(); schedulePreview(); return; }
  if (t.dataset.listF) { C[t.dataset.listF] = t.value; if (!t.value) delete C[t.dataset.listF]; }
  else if (e && t.dataset.f) { if (t.value) e[t.dataset.f] = t.value; else delete e[t.dataset.f]; }
  dirty(); schedulePreview();
});
$("lists").addEventListener("change", (ev) => {
  const t = ev.target, { L, e } = entryAt(t);
  if (!L || !e) return;
  if (t.dataset.tag) { const s = new Set(e.tags || []); t.checked ? s.add(t.dataset.tag) : s.delete(t.dataset.tag); e.tags = [...s]; if (!e.tags.length) delete e.tags; }
  if (t.dataset.wday) { const w = e.when || {}; const s = new Set(w.days || []); t.checked ? s.add(Number(t.dataset.wday)) : s.delete(Number(t.dataset.wday)); w.days = [...s].sort(); if (!w.days.length) delete w.days; e.when = w; refreshWhen(t, L, e); }
  if (t.dataset.wf) { refreshWhen(t, L, e); }
  if (t.dataset.day) { const s = new Set(e.days || []); t.checked ? s.add(Number(t.dataset.day)) : s.delete(Number(t.dataset.day)); e.days = [...s].sort(); }
  if (t.dataset.sw === "sold") { if (t.checked) e.soldOut = today(); else delete e.soldOut; t.closest(".me-row")?.classList.toggle("is-sold", t.checked); }
  if (t.dataset.sw === "hidden") { if (t.checked) e.hidden = true; else delete e.hidden; t.closest(".me-row")?.classList.toggle("is-hidden", t.checked); }
  dirty(); schedulePreview();
});
$("lists").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b || b.disabled) return;
  const { L, C, i } = entryAt(b); if (!L) return;
  if (b.dataset.pick !== undefined) { const e = C.entries[i]; if (e) openPicker(L, e); return; }
  if (b.dataset.whenToggle !== undefined || b.dataset.whenClear !== undefined) {
    const e = C.entries[i] || (L.kind === "text" ? C.entries[0] : null); if (!e) return;
    const k = `${L.key}:${e.id}`;
    if (b.dataset.whenClear !== undefined) { delete e.when; E.openWhen.delete(k); } else if (E.openWhen.has(k)) E.openWhen.delete(k); else E.openWhen.add(k);
    drawLists();
    if (E.openWhen.has(k)) $("lists").querySelector(`.me-list[data-key="${CSS.escape(L.key)}"] [data-i="${i < 0 ? 0 : i}"] [data-wf="dfrom"]`)?.focus();
  } else if (b.dataset.add !== undefined) {
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

// E2d: a board's look and options
$("lists").addEventListener("change", (ev) => {
  const t = ev.target, sec = t.closest(".me-look"); if (!sec || !t.dataset.lookF) return;
  const id = sec.dataset.board, b = E.boards.find((x) => x.id === id); if (!b) return;
  E.draft.boards ||= {};
  const c = E.draft.boards[id] = { ...(E.draft.boards[id] || {}) };
  const f = t.dataset.lookF;
  if (f === "look") c.look = t.value;
  else if (f === "chalk") c.chalk = { ...(c.chalk || {}), [t.dataset.role]: t.value };
  else if (f === "lettering") c.lettering = t.value;
  else if (f === "frame") c.frame = t.checked;
  else if (f === "option") c.options = { ...(c.options || {}), [t.dataset.opt]: t.checked };
  showBoard(id); drawLists(); schedulePreview();
});
$("lists").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-look-reset]"); if (!btn) return;
  const id = btn.closest(".me-look").dataset.board;
  delete E.draft.boards[id]; showBoard(id); drawLists(); schedulePreview();
});
/** The preview turns to the board being changed */
function showBoard(id) { if ($("board-pick").value !== id && E.boards.some((b) => b.id === id)) { $("board-pick").value = id; $("phone-line").innerHTML = phoneLine(E.boards.find((b) => b.id === id)); } }

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
        if (k === "when" && (!v || !Object.keys(v).length)) continue;
        x[k] = typeof v === "string" && k !== "open" && k !== "close" && k !== "soldOut" && k !== "image" && k !== "id" ? v.trim() : v;
      }
      return x;
    }).filter((x) => Object.keys(x).some((k) => !["id", "hidden", "soldOut", "days", "when"].includes(k) && x[k] !== "") || (L.kind === "hours" && (x.days || []).length));
    const o = { entries };
    if (C.price?.trim()) o.price = C.price.trim();
    if (C.note?.trim()) o.note = C.note.trim();
    if (entries.length || o.price || o.note) out.lists[L.key] = o;
  }
  // E2d: the boards' looks, each only with what was chosen (nothing chosen: the layout's own design)
  const boards = {};
  for (const [id, b] of Object.entries(content.boards || {})) {
    const x = {};
    if (b?.look) x.look = b.look;
    if (b?.chalk && Object.keys(b.chalk).length) x.chalk = { ...b.chalk };
    if (b?.lettering) x.lettering = b.lettering;
    if (typeof b?.frame === "boolean") x.frame = b.frame;
    if (b?.options && Object.keys(b.options).length) x.options = { ...b.options };
    if (Object.keys(x).length) boards[id] = x;
  }
  if (Object.keys(boards).length) out.boards = boards;
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
  if (ev.origin !== location.origin) return;
  // E2b: the full-size window, when it's (re)loaded, gets the board as it stands
  if (E.full && ev.source === E.full) { if (ev.data?.type === "layout-ready") sendFull(); return; }
  const ck = E.checkers.find((c) => c.frame.contentWindow === ev.source);
  if (ck) {
    if (ev.data?.type === "layout-ready") { ck.ready = true; ck.waiters.splice(0).forEach((f) => f()); }
    if (ev.data?.type === "layout-report") { ck.report = ev.data; ck.reportWaiter?.(); ck.reportWaiter = null; }
    return;
  }
  if (ev.source !== $("pv").contentWindow) return;
  if (ev.data?.type === "layout-ready") { E.frameReady = true; E.waiters.splice(0).forEach((f) => f()); }
  if (ev.data?.type === "layout-report") { E.lastReport = ev.data; E.reportWaiter?.(); E.reportWaiter = null; }
});
function payload(board, content) {
  const images = Object.fromEntries(E.pics.map((p) => [p.key, { url: `/img/${p.path}`, w: 0, h: 0 }]));
  return { kind: "layout", key: "preview", orientation: board.orientation, layout: { id: board.id, name: board.name, version: board.published_version, doc: board.doc },
    images, menu: { url: E.menuBase + board.menu_code }, lists: { id: E.menu.id, spec: E.spec, content }, look: content.boards?.[board.id] || null,
    propertyName: board.prop?.name || "", timezone: board.prop?.timezone || E.tz, weather: { enabled: false }, poweredBy: true };
}
// E2e (DP-13): the board fits the column's width and the window's height (a portrait board was taller than a laptop's
// window, so its foot was cut off), leaving room under it for the buttons and the first lines of the tabs below
function fitFrame() {
  const b = E.board; if (!b) return;
  const land = b.orientation === "landscape", cw = land ? 1920 : 1080, ch = land ? 1080 : 1920;
  const box = $("pv-box"); box.classList.toggle("landscape", land);
  const col = box.parentElement.clientWidth, border = 20;
  // everything else in the column (its picker, buttons, lines and the tabs' bar), measured, plus room for a few lines
  // of the open tab; the column sits 72 px from the window's top
  const aside = box.closest(".menu-preview");
  const others = [...aside.children].filter((c) => c !== box && !c.matches("[data-side-pane]") && !c.hidden)
    .reduce((h, c) => { const st = getComputedStyle(c); return h + c.getBoundingClientRect().height + (parseFloat(st.marginTop) || 0) + (parseFloat(st.marginBottom) || 0); }, 0);
  const maxH = window.innerWidth > 1000 ? Math.max(240, window.innerHeight - 84 - others - 40) : Infinity;
  const w = Math.min(col, ((maxH - border) * cw) / ch + border);
  box.style.width = `${Math.floor(w)}px`;
  box.style.height = `${Math.round(((Math.floor(w) - border) * ch) / cw + border)}px`;   // the board's own shape inside the 10 px frame
  const f = $("pv"); f.style.width = `${cw}px`; f.style.height = `${ch}px`; f.style.transform = `scale(${box.clientWidth / cw})`;
}
// Your pictures and History, as tabs under the preview
document.querySelector(".me-side-tabs").addEventListener("click", (e) => {
  const t = e.target.closest("[data-side]"); if (!t) return;
  for (const b of document.querySelectorAll("[data-side]")) b.setAttribute("aria-selected", String(b === t));
  for (const p of document.querySelectorAll("[data-side-pane]")) p.hidden = p.dataset.sidePane !== t.dataset.side;
});
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
  sendFull(); scheduleCheck();
  const over = await draw(b, tidy(E.draft));
  $("pv-note").innerHTML = over.length
    ? `<span class="warn">${esc(listNames(over))} no longer fit${over.length === 1 ? "s" : ""} on this board. Shorten what's written there.</span>`
    : "As the board will show it, with your changes, before you save.";
}
const listNames = (keys) => [...new Set(keys)].map((k) => `"${E.spec.lists.find((l) => l.key === k)?.name || k}"`).join(", ");
// ── Preview full size (E2b): the board with the changes in its own window, following them as they're typed ──
const pickedBoard = () => E.boards.find((x) => x.id === $("board-pick").value) || E.boards[0];
function sendFull() {
  const b = pickedBoard();
  if (!E.full || E.full.closed || !b) return;
  E.full.postMessage({ type: "layout-draft", data: payload(b, tidy(E.draft)) }, location.origin);
  E.full.postMessage({ type: "layout-room", on: $("show-room").checked }, location.origin);
}
$("full").addEventListener("click", () => {
  if (E.full && !E.full.closed) { E.full.focus(); sendFull(); return; }
  E.full = window.open("/board.html?preview=1", "waytugo-full-preview", "popup,width=1280,height=760");
  if (!E.full) toast("Your browser blocked the window. Allow pop-ups for this site, then try again.", true);
});

// ── Fit while typing (E2b): each board on the menu drawn in a hidden frame of its own, checked after each change ──
function makeCheckers() {
  const box = $("checkers");
  E.checkers = E.boards.map((b) => {
    const frame = document.createElement("iframe");
    frame.title = `Fit check: ${b.name}`; frame.tabIndex = -1; frame.src = "/board.html?preview=1";
    box.appendChild(frame);
    return { board: b, frame, ready: false, waiters: [], report: null, reportWaiter: null };
  });
}
async function checkOne(ck, content) {
  if (!ck.ready) await new Promise((res) => { ck.waiters.push(res); setTimeout(res, 8000); });
  const got = new Promise((res) => { ck.reportWaiter = res; setTimeout(res, 6000); });
  ck.report = null;
  ck.frame.contentWindow.postMessage({ type: "layout-draft", data: payload(ck.board, content) }, location.origin);
  await got;
  const bound = new Map((ck.board.doc.blocks || []).filter((b) => b.content?.list).map((b) => [b.id, b.content.list]));
  return (ck.report?.overflow || []).filter((id) => bound.has(id)).map((id) => bound.get(id));
}
/** Checks every board; returns Map(list key -> [board names]) of the lists that don't fit, and marks them in the editor */
async function checkAll(content = tidy(E.draft)) {
  const gen = ++E.checkGen;
  const results = await Promise.all(E.checkers.map((ck) => checkOne(ck, content).then((keys) => ({ ck, keys }))));
  const map = new Map();
  for (const { ck, keys } of results) for (const k of keys) map.set(k, [...(map.get(k) || []), ck.board.name]);
  if (gen === E.checkGen) { E.nofit = map; markNofit(); }
  return map;
}
const nofitText = (boards) => `Doesn't fit on ${[...new Set(boards)].join(" and ")}: shorten what's written here, or hide an item.`;
function markNofit() {
  for (const sec of $("lists").querySelectorAll(".me-list")) {
    const b = E.nofit.get(sec.dataset.key), msg = sec.querySelector(".me-nofit");
    sec.classList.toggle("nofit", !!b);
    if (msg) { msg.hidden = !b; msg.textContent = b ? nofitText(b) : ""; }
  }
}
let checkTimer = null;
function scheduleCheck() { clearTimeout(checkTimer); checkTimer = setTimeout(() => checkAll().catch(() => {}), 700); }

$("board-pick").addEventListener("change", () => { const b = E.boards.find((x) => x.id === $("board-pick").value); if (b) { $("phone-line").innerHTML = phoneLine(b); previewNow(); } });
$("show-room").addEventListener("change", () => { $("pv").contentWindow?.postMessage({ type: "layout-room", on: $("show-room").checked }, location.origin); sendFull(); });
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
    const map = await checkAll(content);
    const over = [...map].map(([k, boards]) => `${listNames([k])} on ${[...new Set(boards)].join(" and ")}`);
    if (over.length && !anyway) {
      showProblems(`<strong>This wouldn't fit on the board:</strong> ${esc(over.join("; "))}. Shorten the names or descriptions there, or hide an item.`
        + (E.admin ? ` <button type="button" class="ghost" id="save-anyway">Save anyway (1Point)</button>` : ""));
      return;
    }
    $("save").textContent = "Saving…";
    const r = await Auth.db("rpc/menu_save", { method: "POST", body: { p_menu: E.menu.id, p_base_rev: E.menu.rev, p_content: content } });
    E.menu.rev = r.rev;
    E.saved = normalise(content); E.draft = clone(E.saved);
    await Promise.all([loadHistory(), loadPics()]);
    drawLists(); drawHistory(); drawPics();
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
    const lines = prev ? menuChanges(E.spec, prev.content, r.content, 8, Object.fromEntries(E.boards.map((b) => [b.id, b.name]))) : ["The menu's first lists"];
    const restoredNote = r.restored_from ? ` · restored save ${r.restored_from}` : "";
    return `<li><div class="mh-head"><strong>Save ${r.rev}</strong> <span class="sub">${esc(since(r.saved_at))}${r.by_name ? ` · ${esc(r.by_name)}` : ""}${r.by_1point ? " (WayTuGo)" : ""}${restoredNote}</span>
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
    await Promise.all([loadHistory(), loadPics()]); drawLists(); drawHistory(); drawPics(); previewNow();
    const n = r.pictures_cleared || 0;
    toast(`Save ${b.dataset.restore} is back on the boards.${n ? ` ${n} item${n === 1 ? "" : "s"} came back without a picture, because ${n === 1 ? "its picture was" : "their pictures were"} removed since. Choose new ones if you like.` : ""}`);
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
    else $("pv-note").textContent = "Once WayTuGo publishes a board on this menu, it shows here.";
    drawLists(); drawHistory(); drawPics();
    makeCheckers();
    $("full").disabled = !E.boards.length;
    if (E.boards.length) previewNow();
    // the When labels (On now, Starts …) follow the clock
    setInterval(() => { for (const el of $("lists").querySelectorAll(".me-when [data-wf], .me-when-btn")) { const { L, e } = entryAt(el); if (L && e) refreshWhen(el, L, e); } }, 60000);
  } catch (ex) {
    $("load-error").textContent = ex.message; $("load-error").hidden = false;
  }
})();

// ── Your pictures (E2c): the account's own, from /api/pictures ──
async function loadPics() {
  try {
    const r = await Auth.api("/api/pictures", { method: "POST", body: { action: "list", org_id: E.menu.org_id } });
    E.pics = r.pictures.map((p) => ({ ...p, path: p.url.replace(/^\/img\//, "") }));
    E.picRoom = r.room; E.picChange = r.can_change;
  } catch {
    // before E2c's site is up: the pictures can still be shown and chosen
    E.pics = await Auth.db(`layout_images?org_id=eq.${E.menu.org_id}&select=id,key,name,path,width,height&order=name.asc`).catch(() => []);
    E.picChange = false;
  }
}
function useText(p, unsaved) {
  if (p.use === "menu") return "On the boards now";
  if (p.use === "layout") return "Part of the board's design (WayTuGo's)";
  return unsaved.has(p.key) ? "In your unsaved changes" : "Not on the boards";
}
function drawPics() {
  const n = E.pics.length, change = E.picChange && canEdit();
  $("pics-count").textContent = `· ${n} of ${E.picRoom}`;
  $("pics-upload").hidden = !change || n >= E.picRoom;
  $("pics-note").textContent = n >= E.picRoom
    ? `Your account has ${n} pictures, the most it holds. Remove ones you no longer use, or ask WayTuGo for more room.`
    : "Pictures you add belong to your account and can be used on any of your boards. One on the boards now can't be removed.";
  const unsaved = new Set(menuPictureKeys(tidy(E.draft)));
  $("pics").innerHTML = n ? E.pics.map((p) => {
    const editing = E.renaming === p.id;
    return `<li class="my-pic" data-id="${esc(p.id)}"><img src="/img/${esc(p.path)}" alt="" loading="lazy">
      <div class="my-pic-body">${editing
        ? `<input class="my-pic-in" maxlength="80" value="${esc(p.name)}" aria-label="New name for ${esc(p.name)}"><span class="my-pic-acts"><button type="button" class="primary" data-pic-save>Save</button><button type="button" class="ghost" data-pic-cancel>Cancel</button></span>`
        : `<span class="my-pic-name" title="${esc(p.name)}">${esc(p.name || p.key)}</span><span class="sub">${esc(useText(p, unsaved))}</span>`}</div>
      ${change && !editing ? `<span class="my-pic-acts"><button type="button" class="ghost" data-pic-rename>Rename</button>${p.use ? "" : `<button type="button" class="ghost danger" data-pic-remove>Remove</button>`}</span>` : ""}</li>`;
  }).join("") : `<li class="hint">No pictures yet.${change ? " Upload your own: they're made the right size for the boards." : ""}</li>`;
}
/** Shrinks and uploads files; returns the pictures made. Progress shows in el. */
async function uploadFiles(files, el) {
  el.hidden = false;
  const made = [], failed = [];
  for (const [i, f] of files.entries()) {
    el.textContent = `Uploading ${i + 1} of ${files.length}: ${f.name}…`;
    try {
      const data = await asDataUrl(await shrink(f));
      const r = await Auth.api("/api/pictures", { method: "POST", body: { action: "upload", org_id: E.menu.org_id, name: niceName(f.name), data } });
      made.push(r.picture);
    } catch (ex) { failed.push(`${f.name}: ${ex.message}`); if (/the most it holds/.test(ex.message)) break; }
  }
  await loadPics(); drawPics();
  el.textContent = `${made.length} uploaded.${failed.length ? ` Not uploaded: ${failed.join("; ")}` : ""}`;
  return made;
}
$("pics-file").addEventListener("change", async (ev) => {
  const files = [...ev.target.files]; ev.target.value = "";
  if (files.length) await uploadFiles(files, $("pics-progress"));
});
$("pics").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  const p = E.pics.find((x) => x.id === b.closest("[data-id]")?.dataset.id); if (!p) return;
  if (b.dataset.picRename !== undefined) { E.renaming = p.id; drawPics(); $("pics").querySelector(".my-pic-in")?.select(); return; }
  if (b.dataset.picCancel !== undefined) { E.renaming = null; drawPics(); return; }
  if (b.dataset.picSave !== undefined) { await renamePic(p); return; }
  if (b.dataset.picRemove !== undefined) {
    if (menuPictureKeys(tidy(E.draft)).includes(p.key)) { toast("Your unsaved changes use this picture: choose another picture for those items first.", true); return; }
    if (!confirm(`Remove the picture "${p.name || p.key}"? It's deleted from your account and from storage. This can't be undone.`)) return;
    b.disabled = true; b.textContent = "Removing…";
    try {
      await Auth.api("/api/pictures", { method: "POST", body: { action: "delete", id: p.id } });
      toast(`Removed "${p.name || p.key}". Checked: it's gone from storage.`);
    } catch (ex) { toast(ex.message, true); }
    await loadPics(); drawPics(); drawLists();
  }
});
$("pics").addEventListener("keydown", (ev) => {
  if (!ev.target.classList.contains("my-pic-in")) return;
  if (ev.key === "Enter") { ev.preventDefault(); const p = E.pics.find((x) => x.id === E.renaming); if (p) renamePic(p); }
  if (ev.key === "Escape") { E.renaming = null; drawPics(); }
});
async function renamePic(p) {
  const name = $("pics").querySelector(".my-pic-in")?.value.trim();
  if (!name) { toast("Give the picture a name.", true); return; }
  try { await Auth.api("/api/pictures", { method: "POST", body: { action: "rename", id: p.id, name } }); }
  catch (ex) { toast(ex.message, true); return; }
  E.renaming = null; await loadPics(); drawPics(); drawLists();
}

// The picker: thumbnails to choose from, a new one uploaded right here, or no picture
function openPicker(L, e) {
  E.picTarget = { key: L.key, id: e.id };
  $("pic-search").value = "";
  $("pic-dlg-progress").hidden = true;
  $("pic-dlg-upload").hidden = !(E.picChange && canEdit()) || E.pics.length >= E.picRoom;
  $("pic-dialog-title").textContent = `Choose a picture for ${e.name ? `"${e.name}"` : "this item"}`;
  drawChoices();
  $("pic-dialog").showModal();
  $("pic-search").focus();
}
function drawChoices() {
  const q = $("pic-search").value.trim().toLowerCase(), now = pickedEntry()?.image;
  const list = E.pics.filter((p) => !q || (p.name || p.key).toLowerCase().includes(q));
  $("pic-choices").innerHTML = list.length ? list.map((p) => `<li><button type="button" class="pic-choice${now === `img:${p.key}` ? " is-on" : ""}" data-choose="${esc(p.key)}" aria-pressed="${now === `img:${p.key}`}">
      <img src="/img/${esc(p.path)}" alt="" loading="lazy"><span>${esc(p.name || p.key)}</span></button></li>`).join("")
    : `<li class="hint">${E.pics.length ? "No picture by that name." : "No pictures yet: upload one."}</li>`;
}
function pickedEntry() { const t = E.picTarget; return t ? E.draft.lists[t.key]?.entries.find((x) => x.id === t.id) : null; }
function choose(key) {
  const e = pickedEntry(); $("pic-dialog").close();
  if (!e) return;
  if (key) e.image = `img:${key}`; else delete e.image;
  drawLists(); drawPics(); schedulePreview();
}
$("pic-search").addEventListener("input", drawChoices);
$("pic-choices").addEventListener("click", (ev) => { const b = ev.target.closest("[data-choose]"); if (b) choose(b.dataset.choose); });
$("pic-none").addEventListener("click", () => choose(null));
$("pic-cancel").addEventListener("click", () => $("pic-dialog").close());
$("pic-dlg-file").addEventListener("change", async (ev) => {
  const files = [...ev.target.files]; ev.target.value = "";
  if (!files.length) return;
  const [made] = await uploadFiles(files, $("pic-dlg-progress"));
  if (made) choose(made.key); else drawChoices();
});

window.MenuEditor = { get state() { return E; }, tidy: () => tidy(E.draft), shown: (key) => shownEntries(E.spec.lists.find((l) => l.key === key), E.draft.lists[key]) };   // for the browser checks
