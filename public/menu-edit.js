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
import { checkMenuContent, menuChanges, newEntryId, capOf, shownEntries, describeWhen, entryStatus, menuPictureKeys, ITEM_TAGS, FIELD_LABEL, BRAND_COLOURS, BRAND_FONT_ROLES, BRAND_FONTS, BRAND_NAME_MAX } from "/menu-format.mjs";
import { shrink, asDataUrl, niceName } from "/picture-shrink.mjs";
import { zonedNow, checkLayout, blockShows, readingOrder, boardChoice, offersChoice, applyBrand, contrast, LOOKS, CHALK, CHALK_NAMES, CHALK_ROLES, LETTERING } from "/layout-format.mjs";
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
  out.brand = clone(content?.brand || {});     // T1b
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
// ── M1 (DP-13; Scot: "optimize the console editing for mobile use"): on a phone (720 px or narrower, or sideways: 500 px or less tall) each list folds to
// its name and a one-line summary, an item is one line (name, price, Sold out) with the rest behind More, and Save and
// See the board sit in a bar at the bottom. Wider screens draw as before. ──
// a phone held sideways (up to 950 px wide but 500 px or less tall) is still a phone
const PHONE = window.matchMedia("(max-width: 720px), (max-height: 500px) and (max-width: 950px)");
E.openFold = new Set(); E.openRows = new Set();
const isPhone = () => PHONE.matches;
const folded = (k) => isPhone() && !E.openFold.has(k);
function foldHead(k, inner, sum) {
  if (!isPhone()) return `<h2>${inner}</h2>`;
  return `<h2 class="me-fold-h"><button type="button" class="me-fold" data-fold="${esc(k)}" aria-expanded="${E.openFold.has(k)}"><span class="me-fold-name">${inner}</span>${sum ? `<span class="me-fold-sum">${esc(sum)}</span>` : ""}</button></h2>`;
}
function listSummary(L, C) {
  const es = C.entries || [];
  if (L.kind === "text") { const e = es[0] || {}; const t = String(e.title || e.body || "").trim(); return e.hidden ? "Hidden" : t ? (t.length > 44 ? `${t.slice(0, 42)}…` : t) : "Empty"; }
  if (L.kind === "hours") return `${es.length} line${es.length === 1 ? "" : "s"}`;
  const sold = es.filter((e) => e.soldOut === today()).length, hid = es.filter((e) => e.hidden).length;
  const on = L.schedule ? es.filter((e) => !e.hidden && entryStatus(e, nowHere()) === "On now").length : null;
  return [`${es.length} item${es.length === 1 ? "" : "s"}`, on !== null ? `${on} on now` : "", sold ? `${sold} sold out` : "", hid ? `${hid} hidden` : ""].filter(Boolean).join(" · ");
}
function itemRowPhone(L, e, i, n) {
  const f = L.fields, sold = e.soldOut === today(), open = E.openRows.has(`${L.key}:${e.id}`);
  const main = ["name", "price"].filter((x) => f.includes(x)).map((x) => textBox(L, x, e, i)).join("");
  const rest = f.filter((x) => x !== "name" && x !== "price").map((x) => x === "image" ? pickPic(L, e, i)
    : x === "tags" ? `<div class="me-tags" role="group" aria-label="Tags for item ${i + 1}">${Object.entries(ITEM_TAGS).map(([t, lbl]) => `<label class="me-tag"><input type="checkbox" data-tag="${t}"${(e.tags || []).includes(t) ? " checked" : ""}> ${lbl}</label>`).join("")}</div>`
    : x === "link" ? `<input data-f="link" maxlength="300" value="${esc(e.link || "")}" placeholder="Web link (optional), https://…" aria-label="Web link for item ${i + 1}" class="me-link">`
    : textBox(L, x, e, i)).join("");
  const st = L.schedule ? entryStatus(e, nowHere()) : "";
  return `<li class="me-row me-row-m${e.hidden ? " is-hidden" : ""}${sold ? " is-sold" : ""}${open ? " is-open" : ""}" data-i="${i}">
    <div class="me-m-main">${main}</div>
    <div class="me-m-bar"><label class="me-sold"><input type="checkbox" data-sw="sold"${sold ? " checked" : ""}> Sold out today</label>
      ${st ? `<span class="me-status ${st === "On now" ? "on" : "off"}">${esc(st)}</span>` : ""}${e.hidden ? `<span class="me-status off">Hidden</span>` : ""}
      <button type="button" class="ghost me-more-btn" data-row-toggle aria-expanded="${open}" aria-label="${open ? "Done with" : "More for"} item ${i + 1}">${open ? "Done" : "More"}</button></div>
    ${open ? `<div class="me-m-more"><div class="me-fields">${rest}${whenHtml(L, e)}</div>
      <label class="check inline"><input type="checkbox" data-sw="hidden"${e.hidden ? " checked" : ""}> Hide</label>
      <div class="me-move">
        <button type="button" class="icon-btn" data-mv="-1" aria-label="Move item ${i + 1} up"${i === 0 ? " disabled" : ""}>↑ Up</button>
        <button type="button" class="icon-btn" data-mv="1" aria-label="Move item ${i + 1} down"${i === n - 1 ? " disabled" : ""}>↓ Down</button>
        <button type="button" class="icon-btn danger" data-rm aria-label="Remove item ${i + 1}">✕ Remove</button>
      </div></div>` : ""}</li>`;
}
function itemRow(L, e, i, n) {
  if (isPhone()) return itemRowPhone(L, e, i, n);
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
  // T1c (DP-13; Scot's bottom line): a list that no published board shows yet (a board published before its lists were
  // made, or not yet published) says so, rather than changes that seem to go nowhere
  const onBoard = E.boards.some((b) => (b.doc?.blocks || []).some((x) => x.content?.list === L.key));
  const unshown = E.boards.length && !onBoard
    ? `<p class="me-unshown" role="status">Not on a board yet: no published board shows this list, so saving it changes only the phone menu. ${E.admin ? "Publish the board that should show it (Layouts → the board → Publish)." : "Ask WayTuGo."}</p>` : "";
  const fk = `list:${L.key}`;
  return `<section class="panel me-list${nofit ? " nofit" : ""}${folded(fk) && !nofit ? " is-folded" : ""}" data-key="${esc(L.key)}" data-fold-key="${esc(fk)}">
    <div class="panel-head">${foldHead(fk, `${esc(L.name)} ${count}`, listSummary(L, C))}</div>${unshown}
    <p class="me-nofit" role="status"${nofit ? "" : " hidden"}>${nofit ? esc(nofitText(nofit)) : ""}</p>
    ${L.hint ? `<p class="hint">${esc(L.hint)}</p>` : ""}${top}${body}</section>`;
}
// T1c: a board published since this page opened (in the console, say) is drawn here only after a reload; on coming back
// to this tab, it says so
window.addEventListener("focus", async () => {
  if (!E.boards?.length || E.publishedNote) return;
  try {
    const now = await Auth.db(`layouts?menu_id=eq.${E.menu.id}&select=id,published_version`);
    if (now.some((l) => (E.boards.find((b) => b.id === l.id)?.published_version ?? null) !== (l.published_version ?? null))) {
      E.publishedNote = true;
      const bar = document.createElement("p"); bar.className = "me-republished"; bar.setAttribute("role", "status");
      bar.innerHTML = `A board on this menu was published since you opened this page. <button type="button" class="ghost" id="me-reload">Reload to see it</button>${same() ? "" : " (save your changes first)"}`;
      $("lists").before(bar);
      $("me-reload").addEventListener("click", () => { if (same() || confirm("Reload without saving your changes?")) location.reload(); });
    }
  } catch { /* try again next time */ }
});
// ── Board look (E2d): a board's look and options, from the presets its layout offers ──
// T1d (DP-13; Scot): this board's sizes, 1Point only: the QR code's size on the glass and the logo's share of its spot
function sizesHtml(b, ch) {
  const doc = b.checked, hasQr = doc.blocks.some((x) => x.type === "qr"), hasLogo = doc.blocks.some((x) => x.type === "logo");
  const pct = (f, label) => `<div class="me-look-row"><span class="me-look-label">${label}</span><select data-look-f="${f}" aria-label="${label} size">${[80, 90, 100, 110, 120, 130].map((n) => `<option value="${n}"${ch.sizes[f] === n ? " selected" : ""}>${n}%${n === 100 ? " (as designed)" : ""}</option>`).join("")}</select></div>`;
  const q = (v, label) => `<label class="me-choice${(ch.sizes.qr || "") === v ? " is-on" : ""}"><input type="radio" name="qr:${esc(b.id)}" data-look-f="qr" value="${v}"${(ch.sizes.qr || "") === v ? " checked" : ""}> ${label}</label>`;
  // T1f (Scot): the code on its white square, or drawn straight on the board (light on a chalkboard): test it with phones
  const qd = (v, label) => `<label class="me-choice${ch.sizes.qrcode === v ? " is-on" : ""}"><input type="radio" name="qrcode:${esc(b.id)}" data-look-f="qrcode" value="${v}"${ch.sizes.qrcode === v ? " checked" : ""}> ${label}</label>`;
  return `<div class="me-sizes"><p class="hint">WayTuGo only: sizes for this board.</p>
    ${hasQr ? `<div class="me-look-row"><span class="me-look-label">QR code</span>${q("", "Fills its spot")}${q("s", "Small · 7 cm")}${q("m", "Medium · 10 cm")}${q("l", "Large · 13 cm")}</div>` : ""}
    ${hasQr ? `<div class="me-look-row"><span class="me-look-label">QR drawn</span>${qd("white", "On a white square (every phone reads it)")}${qd("board", "On the board, in its lettering colour")}</div>` : ""}
    ${pct("headings", "Headings")}${pct("body", "Body text")}
    ${hasLogo ? `<div class="me-look-row"><span class="me-look-label">Logo</span><select data-look-f="logo" aria-label="Logo size">${[100, 90, 80, 70, 60].map((n) => `<option value="${n}"${ch.sizes.logo === n ? " selected" : ""}>${n}% of its spot</option>`).join("")}</select></div>` : ""}
  </div>`;
}
function lookHtml(b) {
  const doc = b.checked, ch = boardChoice(doc, E.draft.boards?.[b.id]), mine = E.draft.boards?.[b.id] && Object.keys(E.draft.boards[b.id]).some((k) => k !== "sizes");
  const looks = doc.theme.looks || ["house"], chalk = ch.look === "chalkboard";
  const radio = (name, val, label, on) => `<label class="me-choice${on ? " is-on" : ""}"><input type="radio" name="${esc(name)}" data-look-f="${esc(name.split(":")[0])}" value="${esc(val)}"${on ? " checked" : ""}> ${esc(label)}</label>`;
  const swatches = (role) => `<div class="me-swatches" role="radiogroup" aria-label="${esc(CHALK_ROLES[role])} chalk">${Object.entries(CHALK).map(([k, hex]) =>
    `<label class="me-swatch${ch.chalk[role] === k ? " is-on" : ""}" title="${esc(CHALK_NAMES[k])}"><input type="radio" name="chalk-${role}:${b.id}" data-look-f="chalk" data-role="${role}" value="${k}"${ch.chalk[role] === k ? " checked" : ""}>`
    + `<span style="background:${hex}"></span><em>${esc(CHALK_NAMES[k])}</em></label>`).join("")}</div>`;
  const fk = `look:${b.id}`;
  return `<section class="panel me-look${folded(fk) ? " is-folded" : ""}" data-board="${esc(b.id)}" data-fold-key="${esc(fk)}">
    <div class="panel-head">${foldHead(fk, `Board look <span class="sub">· ${esc(b.name)}</span>`, LOOKS[ch.look] || "")}</div>
    <p class="hint">Choose how this board looks. Every choice here is made to read well on the board; the preview shows it before you save.</p>
    ${looks.length > 1 ? `<div class="me-look-row"><span class="me-look-label">Look</span>${looks.map((l) => radio(`look:${b.id}`, l, LOOKS[l], ch.look === l)).join("")}</div>` : ""}
    ${chalk ? Object.keys(CHALK_ROLES).map((r) => `<div class="me-look-row"><span class="me-look-label">${esc(CHALK_ROLES[r])}</span>${swatches(r)}</div>`).join("")
      + `<div class="me-look-row"><span class="me-look-label">Lettering</span>${Object.entries(LETTERING).map(([k, lbl]) => radio(`lettering:${b.id}`, k, lbl, ch.chalk.lettering === k)).join("")}</div>`
      + `<div class="me-look-row"><span class="me-look-label">Frame</span><label class="check inline"><input type="checkbox" data-look-f="frame"${ch.chalk.frame ? " checked" : ""}> Wooden frame around the board</label></div>` : ""}
    ${(doc.options || []).length ? `<div class="me-look-row"><span class="me-look-label">Show</span>${doc.options.map((o) => `<label class="check inline"><input type="checkbox" data-look-f="option" data-opt="${esc(o.key)}"${ch.options[o.key] ? " checked" : ""}> ${esc(o.label)}</label>`).join("")}</div>` : ""}
    ${E.admin ? sizesHtml(b, ch) : ""}
    ${mine ? `<button type="button" class="ghost" data-look-reset>Back to WayTuGo's design</button>` : ""}
  </section>`;
}
// ── T1b (DP-13): the shop's brand (1Point only; Scot: the customer provides it, 1Point sets it up and sends the final
// design for approval). Blank keeps the template's own; the preview follows each change ──
function brandHtml() {
  const br = E.draft.brand || {}, first = E.boards.find((b) => b.checked)?.checked;
  const base = first?.theme || { palette: {}, fonts: {} };
  const col = (k) => `<label class="me-brand-col"><span>${esc(BRAND_COLOURS[k])}</span><span class="me-brand-swatch"><input type="color" data-brand="colour" data-k="${k}" value="${esc(br.colours?.[k] || base.palette[k] || "#000000")}" aria-label="${esc(BRAND_COLOURS[k])} colour"></span>
    <em>${br.colours?.[k] ? esc(br.colours[k]) : "template's"}</em>${br.colours?.[k] ? `<button type="button" class="linkish" data-brand-clear="colour" data-k="${k}">use the template's</button>` : ""}</label>`;
  const font = (k) => `<label class="me-brand-font"><span>${esc(BRAND_FONT_ROLES[k])}</span><select data-brand="font" data-k="${k}"><option value="">The template's (${esc(base.fonts[k] || "")})</option>${BRAND_FONTS.map((f) => `<option${br.fonts?.[k] === f ? " selected" : ""}>${esc(f)}</option>`).join("")}</select></label>`;
  // readable? the text colour on the background, and the background on the dark panel
  let warn = "";
  if (first) { const p = applyBrand(first, br).theme.palette; if (contrast(p.ink, p.bg) < 4.5) warn = "The text colour is hard to read on the background. "; if (contrast(p.onPanel, p.panel) < 4.5) warn += "Text on the dark panel is hard to read."; }
  return `<section class="panel me-brand${folded("brand") ? " is-folded" : ""}" id="me-brand" data-fold-key="brand">
    <div class="panel-head">${foldHead("brand", `Brand <span class="sub">· WayTuGo only · every board on this menu and the phone menu</span>`, br.name ? `Name: ${br.name}` : "The template's")}</div>
    <p class="hint">The shop's name, logo, colours and fonts in place of the template's. Leave one blank to keep the template's. The Chalkboard look keeps its slate and chalk lettering, with this name and logo.</p>
    <div class="me-brand-row"><label class="me-brand-name"><span>Shop's name</span><input data-brand="name" maxlength="${BRAND_NAME_MAX}" value="${esc(br.name || "")}" placeholder="(the template's)"></label>
      <label class="me-brand-logo"><span>Logo picture</span><select data-brand="logo"><option value="">None: the name in the heading font</option>${E.pics.map((p) => `<option value="img:${esc(p.key)}"${br.logo === `img:${p.key}` ? " selected" : ""}>${esc(p.name || p.key)}</option>`).join("")}</select></label></div>
    <div class="me-brand-row">${Object.keys(BRAND_COLOURS).map(col).join("")}</div>
    <div class="me-brand-row">${Object.keys(BRAND_FONT_ROLES).map(font).join("")}</div>
    ${warn ? `<p class="warn" role="status">${esc(warn.trim())}</p>` : ""}
  </section>`;
}
// G1b (DP-13; Scot: "When the change is made from one board to another on preview, the controls should follow the
// choice"): with a board picked in Preview, the editor shows that board's look and its lists, in the order they sit on
// it. Its lists that aren't on the board right now (an option's other arrangement, a season outside its dates) fold into
// "Not showing now", each saying when it shows. Lists only on the menu's other boards are one line each, with a button to
// turn the preview to that board. A list no board shows (T1c) or one that doesn't fit is always drawn. Save still saves
// the whole menu and checks every board.
/** The picked board's lists: { now: [keys showing now], later: [{ key, why }], other: [{ board, keys }], rest: [keys on no board] } */
function boardLists(b) {
  const all = (E.spec.lists || []).map((L) => L.key);
  if (!b?.checked) return { now: all, later: [], other: [], rest: [] };
  const ch = boardChoice(b.checked, E.draft.boards?.[b.id]), now = nowHere();
  const optLabel = (k) => String(b.checked.options?.find((o) => o.key === k)?.label || k).replace(/\s*\([^)]*\)\s*$/, "");
  const shows = new Map(), why = new Map();
  for (const x of readingOrder(b.checked.blocks)) {
    const k = x.content?.list; if (!k || !all.includes(k)) continue;
    let reason = "";
    if (x.on === false) reason = "Switched off on this board by WayTuGo";
    else if (x.showWhen?.option && (ch.options[x.showWhen.option] === true) !== (x.showWhen.is === "on"))
      reason = `Shows when "${optLabel(x.showWhen.option)}" is ${x.showWhen.is === "on" ? "ticked" : "not ticked"} (Board look)`;
    else if (!blockShows(x, now)) reason = `Shows ${x.when.map(describeWhen).join(", or ")}`;
    if (!reason) shows.set(k, true);
    else if (!shows.has(k)) { shows.set(k, false); why.set(k, reason); }
  }
  const mine = [...shows.keys()];
  const other = E.boards.filter((o) => o.id !== b.id && o.checked).map((o) => ({ board: o,
    keys: [...new Set(o.checked.blocks.map((x) => x.content?.list).filter((k) => k && all.includes(k) && !shows.has(k)))] })).filter((o) => o.keys.length);
  const elsewhere = new Set(other.flatMap((o) => o.keys));
  return { now: mine.filter((k) => shows.get(k)), later: mine.filter((k) => !shows.get(k)).map((key) => ({ key, why: why.get(key) })),
    other, rest: all.filter((k) => !shows.has(k) && !elsewhere.has(k)) };
}
E.laterOpen = false;
function drawLists() {
  const b = pickedBoard(), G = boardLists(b), L = (k) => E.spec.lists.find((x) => x.key === k);
  const always = (k) => E.nofit.has(k) && !!L(k);   // a list that doesn't fit stays in view wherever it is
  const otherKeys = new Set(G.other.flatMap((o) => o.keys));
  const later = G.later.length ? `<details class="me-later"${E.laterOpen || G.later.some((x) => always(x.key)) ? " open" : ""}><summary>Not showing now on this board <span class="sub">(${G.later.length})</span></summary>
      ${G.later.map((x) => `<p class="me-why">${esc(L(x.key).name)}: ${esc(x.why)}.</p>${listHtml(L(x.key))}`).join("")}</details>` : "";
  const others = G.other.map((o) => `<p class="me-elsewhere" data-elsewhere="${esc(o.board.id)}">On ${esc(o.board.name)}: ${o.keys.map((k) => esc(L(k).name)).join(", ")}.
      <button type="button" class="ghost" data-board-go="${esc(o.board.id)}">Show that board</button></p>`).join("");
  $("lists").innerHTML = `<p class="hint me-intro">Change what's on your boards here. The layout, headings, colours and sizes are set by WayTuGo; ask WayTuGo to change them, or for more room on a list.${E.boards.length > 1 ? " These are the lists on the board in Preview; choose another board there to change its lists." : ""}</p>`
    + (E.admin ? brandHtml() : "")
    + E.boards.filter((x) => x.checked && (offersChoice(x.checked) || E.admin) && (!b || x.id === b.id)).map(lookHtml).join("")
    + G.now.map((k) => listHtml(L(k))).join("")
    + later
    + G.rest.map((k) => listHtml(L(k))).join("")
    + [...otherKeys].filter(always).map((k) => listHtml(L(k))).join("")
    + (others ? `<div class="me-others">${others}</div>` : "");
  $("lists").querySelector(".me-later")?.addEventListener("toggle", (ev) => { E.laterOpen = ev.target.open; });
  // M1: folding and More stay usable on a read-only menu, so its lists can still be read on a phone
  if (!canEdit()) $("lists").querySelectorAll("input, select, textarea, button:not([data-fold]):not([data-row-toggle])").forEach((x) => (x.disabled = true));
  dirty();
}

// M1: folding a list (or the Brand and Board look panels) and opening an item's More, on a phone
$("lists").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-fold], [data-row-toggle]"); if (!b) return;
  ev.stopImmediatePropagation();
  if (b.dataset.fold !== undefined) {
    const k = b.dataset.fold;
    if (E.openFold.has(k)) E.openFold.delete(k); else E.openFold.add(k);
    drawLists();
    const sec = $("lists").querySelector(`[data-fold-key="${CSS.escape(k)}"]`);
    sec?.querySelector("[data-fold]")?.focus();
    if (E.openFold.has(k)) sec?.scrollIntoView({ block: "nearest" });
    return;
  }
  const { L, e } = entryAt(b); if (!L || !e) return;
  const k = `${L.key}:${e.id}`, i = L && E.draft.lists[L.key].entries.indexOf(e);
  if (E.openRows.has(k)) E.openRows.delete(k); else E.openRows.add(k);
  drawLists();
  const row = $("lists").querySelector(`.me-list[data-key="${CSS.escape(L.key)}"] [data-i="${i}"]`);
  (E.openRows.has(k) ? row?.querySelector(".me-m-more input, .me-m-more button") : row?.querySelector("[data-row-toggle]"))?.focus();
});
document.body.classList.toggle("phone", isPhone());
PHONE.addEventListener("change", () => {
  document.body.classList.toggle("phone", isPhone());
  if (!isPhone()) document.body.classList.remove("pv-sheet");
  if (E.spec) drawLists();
  fitFrame();
});

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
  // M1b (Scot: "I need it off the board and I don't need to wait for the save"): Sold out and Hide save on the tap
  if ((t.dataset.sw === "sold" || t.dataset.sw === "hidden") && quickSwitch(L, e, t.dataset.sw, t.checked)) { schedulePreview(); return; }
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

// T1b: the brand (1Point)
function brandChange(t) {
  const br = E.draft.brand = { ...(E.draft.brand || {}) }, k = t.dataset.k;
  if (t.dataset.brand === "name") br.name = t.value;
  else if (t.dataset.brand === "logo") { if (t.value) br.logo = t.value; else delete br.logo; }
  else if (t.dataset.brand === "colour") br.colours = { ...(br.colours || {}), [k]: t.value };
  else if (t.dataset.brand === "font") { br.fonts = { ...(br.fonts || {}) }; if (t.value) br.fonts[k] = t.value; else delete br.fonts[k]; }
}
$("lists").addEventListener("input", (ev) => { const t = ev.target; if (!t.dataset.brand || t.dataset.brand !== "name") return; brandChange(t); schedulePreview(); dirty(); });
$("lists").addEventListener("change", (ev) => {
  const t = ev.target; if (!t.dataset.brand || t.dataset.brand === "name") return;
  brandChange(t); drawLists(); schedulePreview();
});
$("lists").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-brand-clear]"); if (!b) return;
  const br = E.draft.brand = { ...(E.draft.brand || {}) };
  br.colours = { ...(br.colours || {}) }; delete br.colours[b.dataset.k];
  drawLists(); schedulePreview();
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
  else if (f === "qr") { c.sizes = { ...(c.sizes || {}) }; if (t.value) c.sizes.qr = t.value; else delete c.sizes.qr; }
  else if (f === "logo") { c.sizes = { ...(c.sizes || {}) }; if (Number(t.value) < 100) c.sizes.logo = Number(t.value); else delete c.sizes.logo; }
  else if (f === "qrcode") { c.sizes = { ...(c.sizes || {}) }; if (t.value === "board") c.sizes.qrcode = "board"; else delete c.sizes.qrcode; }   // T1f
  else if (f === "headings" || f === "body") { c.sizes = { ...(c.sizes || {}) }; if (Number(t.value) !== 100) c.sizes[f] = Number(t.value); else delete c.sizes[f]; }   // T1e
  showBoard(id); drawLists(); schedulePreview();
});
$("lists").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-look-reset]"); if (!btn) return;
  const id = btn.closest(".me-look").dataset.board;
  const sizes = E.draft.boards[id]?.sizes;   // T1d: the sizes are WayTuGo's, not part of the customer's choices
  delete E.draft.boards[id]; if (sizes) E.draft.boards[id] = { sizes };
  showBoard(id); drawLists(); schedulePreview();
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
    if (b?.sizes && Object.keys(b.sizes).length) x.sizes = { ...b.sizes };   // T1d
    if (Object.keys(x).length) boards[id] = x;
  }
  if (Object.keys(boards).length) out.boards = boards;
  // T1b: the shop's brand, only what's set (blank: the template's own)
  const br = content.brand || {}, brand = {};
  if (br.name?.trim()) brand.name = br.name.trim();
  if (br.logo) brand.logo = br.logo;
  const cols = Object.fromEntries(Object.entries(br.colours || {}).filter(([, v]) => /^#[0-9a-fA-F]{6}$/.test(v || "")));
  if (Object.keys(cols).length) brand.colours = cols;
  const fonts = Object.fromEntries(Object.entries(br.fonts || {}).filter(([, v]) => BRAND_FONTS.includes(v)));
  if (Object.keys(fonts).length) brand.fonts = fonts;
  if (Object.keys(brand).length) out.brand = brand;
  return out;
}
const same = () => JSON.stringify(tidy(E.draft)) === JSON.stringify(tidy(E.saved));
function dirty() {
  const changed = !same();
  $("save").disabled = !changed || !canEdit();
  $("undo").disabled = !changed;
  status();
  document.title = `${changed ? "• " : ""}Edit menu: ${E.menu?.name || ""}`;
}
// M1b: what's saving, waiting for a connection, or saved (and when)
function status() {
  const el = $("saved-line"); if (!el || !E.saved) return;
  const n = (E.qs?.length || 0) + (E.qf?.length || 0), changed = !same();
  const at = E.lastSaved ? E.lastSaved.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  el.classList.toggle("me-offline", !!E.offline);
  el.textContent = E.offline ? E.offline
    : n ? `Saving${n > 1 ? ` ${n} changes` : ""}…${changed ? " · Unsaved changes" : ""}`
    : changed ? "Unsaved changes" : at ? `Saved ${at}` : savedLine();
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
    images, menu: { url: E.menuBase + board.menu_code }, lists: { id: E.menu.id, spec: E.spec, content }, look: content.boards?.[board.id] || null, brand: content.brand || null,
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
  const sheet = document.body.classList.contains("pv-sheet");   // M1: See the board, full screen on a phone
  const maxH = sheet ? Math.max(200, window.innerHeight - others - 40) : window.innerWidth > 1000 ? Math.max(240, window.innerHeight - 84 - others - 40) : Infinity;
  let w = Math.min(col, ((maxH - border) * cw) / ch + border);
  if (sheet) {   // M1: full screen: the width inside the sheet's padding, the height left under the picker and above the note
    const st = getComputedStyle(aside), inner = aside.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight);
    const head = aside.querySelector(".preview-head").getBoundingClientRect().height, note = $("pv-note").getBoundingClientRect().height;
    const room = window.innerHeight - head - note - parseFloat(st.paddingTop) - parseFloat(st.paddingBottom) - 24;
    w = Math.min(inner, ((room - border) * cw) / ch + border);
  }
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
// M1: See the board (a phone): the preview full screen over the editor, with the board picker; Close comes back
$("see-board").addEventListener("click", () => { document.body.classList.add("pv-sheet"); fitFrame(); schedulePreview(); $("pv-close").focus(); });
$("pv-close").addEventListener("click", () => { document.body.classList.remove("pv-sheet"); fitFrame(); $("see-board").focus(); });
window.addEventListener("resize", () => { if (document.body.classList.contains("pv-sheet")) fitFrame(); });
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
  if ([...E.nofit.keys()].some((k) => E.spec.lists.some((l) => l.key === k) && !$("lists").querySelector(`.me-list[data-key="${CSS.escape(k)}"]`))) { drawLists(); return; }   // G1b: bring it into view
  for (const sec of $("lists").querySelectorAll(".me-list")) {
    const b = E.nofit.get(sec.dataset.key), msg = sec.querySelector(".me-nofit");
    sec.classList.toggle("nofit", !!b);
    if (b) sec.classList.remove("is-folded");   // M1: a list that no longer fits opens, so its message shows
    if (msg) { msg.hidden = !b; msg.textContent = b ? nofitText(b) : ""; }
  }
}
let checkTimer = null;
function scheduleCheck() { clearTimeout(checkTimer); checkTimer = setTimeout(() => checkAll().catch(() => {}), 700); }

$("board-pick").addEventListener("change", () => { const b = E.boards.find((x) => x.id === $("board-pick").value); if (b) { $("phone-line").innerHTML = phoneLine(b); drawLists(); previewNow(); } });
// G1b: "Show that board" turns the preview (and so the lists) to another board on this menu
$("lists").addEventListener("click", (ev) => {
  const go = ev.target.closest("[data-board-go]"); if (!go) return;
  showBoard(go.dataset.boardGo); drawLists(); previewNow();
  $("lists").scrollIntoView({ block: "start" });
});
$("show-room").addEventListener("change", () => { $("pv").contentWindow?.postMessage({ type: "layout-room", on: $("show-room").checked }, location.origin); sendFull(); });
window.addEventListener("resize", fitFrame);
const phoneLine = (b) => { const url = E.menuBase + b.menu_code; return `The phone menu (Take this menu with you): <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, ""))}</a> shows what's saved.`; };

// ── Save ──
function showProblems(html) { const el = $("save-problems"); el.innerHTML = html; el.hidden = !html; if (html) el.scrollIntoView({ block: "nearest" }); }
// ── M1b (DP-13; Scot: "the save for the baked ziti needs to save in the background while other things are happening
// ... I accidentally close the app on the phone, does the save keep going?"). Nothing here waits on a save: editing
// carries on while one runs.
//  · A tap on Sold out or Hide is a small save of its own (menu_switch, 42-quick-switch.sql), sent at once, one after
//    another in the order tapped; WayTuGo changes just that item in the menu as it is now.
//  · Save sends the whole menu (after the fit check), in the background; changes made meanwhile stay as Unsaved
//    changes for the next Save. Whatever else changed since (this phone's taps, or another phone's), Save keeps: an
//    item's Sold out and Hide that this Save didn't change are taken from the menu as WayTuGo has it.
//  · Every request goes with keepalive, so one already on its way finishes even if the page is closed. Taps not yet
//    confirmed are kept on the phone and sent the next time the menu opens; a Save that hadn't gone out comes back as
//    Unsaved changes to check and Save again. No connection: it tries again every few seconds. ──
const PKEY = () => `waytugo-menu-pending:${E.menu.id}`;
E.qs = []; E.qf = []; E.busyS = false; E.busyF = false; E.retryS = null; E.offline = ""; E.lastSaved = null;
function keepPending() {
  try {
    const p = { switches: E.qs.map(({ list, entry, what, on, today: d }) => ({ list, entry, what, on, today: d })), save: E.qf[0] ? { content: E.qf[0].content, at: E.qf[0].at } : null };
    if (p.switches.length || p.save) localStorage.setItem(PKEY(), JSON.stringify(p)); else localStorage.removeItem(PKEY());
  } catch { /* private mode: the request itself still goes */ }
}
const offline = (ex) => ex instanceof TypeError || (!ex.status && !ex.code && /fetch|network|load failed|signing in/i.test(ex.message || ""));
const conflict = (ex) => ex.status === 409 || ex.code === "40001" || /Someone else saved/.test(ex.message || "");
const savedEntry = (list, id) => E.saved.lists?.[list]?.entries?.find((x) => x.id === id);
const FLAG = { sold: "soldOut", hidden: "hidden" };
function setFlag(e, what, on, day) { const f = FLAG[what]; if (on) e[f] = what === "sold" ? day : true; else delete e[f]; }
/** A tap on Sold out or Hide; false when the item isn't saved yet (then it goes with Save, like any change) */
function quickSwitch(L, e, what, on) {
  if (!canEdit() || !savedEntry(L.key, e.id)) return false;
  const job = { list: L.key, entry: e.id, what, on, today: today() };
  setFlag(savedEntry(L.key, e.id), what, on, job.today);   // the editor counts it as saved; the queue makes it so
  E.qs.push(job); keepPending(); status(); pumpSwitches();
  return true;
}
async function pumpSwitches() {
  if (E.busyS || !E.qs.length) { status(); return; }
  E.busyS = true; status();
  const job = E.qs[0];
  try {
    const r = await Auth.db("rpc/menu_switch", { method: "POST", keepalive: true, body: { p_menu: E.menu.id, p_list: job.list, p_entry: job.entry, p_what: job.what, p_on: job.on, p_today: job.today } });
    E.menu.rev = Math.max(E.menu.rev, r.rev); E.qs.shift(); E.offline = ""; E.lastSaved = new Date(); keepPending();
  } catch (ex) {
    E.busyS = false;
    if (offline(ex)) { E.offline = "Not saved yet: no connection. Trying again…"; status(); clearTimeout(E.retryS); E.retryS = setTimeout(pumpSwitches, 5000); return; }
    // refused (the item was removed on another phone, say): put this phone back as it was and say why
    E.qs.shift(); keepPending();
    for (const c of [E.draft, E.saved]) { const x = c.lists?.[job.list]?.entries?.find((y) => y.id === job.entry); if (x) setFlag(x, job.what, !job.on, job.today); }
    drawLists(); schedulePreview(); toast(`Not saved: ${ex.message}`, true);
  }
  E.busyS = false;
  if (E.qs.length) pumpSwitches(); else { status(); loadHistory().then(() => { drawHistory(); status(); }); }
}
/** This Save's content, with each item's Sold out and Hide that it didn't change taken from `now` (the menu as saved) */
function withFlags(content, base, now) {
  const out = clone(content);
  for (const [k, c] of Object.entries(out.lists || {})) for (const e of c.entries || []) {
    const b = base.lists?.[k]?.entries?.find((x) => x.id === e.id), n = now.lists?.[k]?.entries?.find((x) => x.id === e.id);
    if (!n) continue;
    for (const f of ["soldOut", "hidden"]) if ((b?.[f] ?? null) === (e[f] ?? null)) { if (n[f] !== undefined) e[f] = n[f]; else delete e[f]; }
  }
  return out;
}
const bare = (c) => { const x = clone(c); for (const l of Object.values(x.lists || {})) for (const e of l.entries || []) { delete e.soldOut; delete e.hidden; } return JSON.stringify(x); };
function save(anyway = false) {
  showProblems("");
  const content = tidy(E.draft);
  const pics = new Set(E.pics.map((p) => p.key));
  const { errors } = checkMenuContent(E.spec, content, { images: pics });
  if (errors.length) { showProblems(`<strong>Fix these first:</strong><ul>${errors.map((x) => `<li><strong>${esc(x.where)}</strong>: ${esc(x.msg)}</li>`).join("")}</ul>`); return; }
  E.qf.push({ content, base: clone(E.saved), anyway, at: new Date().toISOString() }); keepPending(); status(); pumpSaves();
}
async function pumpSaves() {
  if (E.busyF || !E.qf.length) { status(); return; }
  E.busyF = true; status();
  const job = E.qf[0];
  try {
    // Every board on this menu, drawn with the changes: a list that runs out of its box isn't saved (1Point may save anyway)
    const map = await checkAll(job.content);
    const over = [...map].map(([k, boards]) => `${listNames([k])} on ${[...new Set(boards)].join(" and ")}`);
    if (over.length && !job.anyway) {
      E.qf.shift(); keepPending();
      showProblems(`<strong>This wouldn't fit on the board:</strong> ${esc(over.join("; "))}. Shorten the names or descriptions there, or hide an item.`
        + (E.admin ? ` <button type="button" class="ghost" id="save-anyway">Save anyway (1Point)</button>` : ""));
    } else {
      let sent = withFlags(job.content, job.base, E.saved), r;
      try {
        r = await Auth.db("rpc/menu_save", { method: "POST", keepalive: true, body: { p_menu: E.menu.id, p_base_rev: E.menu.rev, p_content: sent } });
      } catch (ex) {
        if (!conflict(ex)) throw ex;
        // someone saved meanwhile: if all they changed was Sold out or Hide, this Save keeps theirs and goes again
        const [m] = await Auth.db(`menus?id=eq.${E.menu.id}&select=content,rev`);
        const there = normalise(m.content);
        if (bare(there) !== bare(job.base)) throw ex;
        sent = withFlags(job.content, job.base, there);
        r = await Auth.db("rpc/menu_save", { method: "POST", keepalive: true, body: { p_menu: E.menu.id, p_base_rev: m.rev, p_content: sent } });
      }
      E.menu.rev = r.rev; E.saved = normalise(sent); E.offline = ""; E.lastSaved = new Date();
      // the editor keeps what's been typed since; this phone's later taps are already in the queue
      for (const s2 of E.qs) { const x = savedEntry(s2.list, s2.entry); if (x) setFlag(x, s2.what, s2.on, s2.today); }
      E.qf.shift(); keepPending();
      toast("Saved. Every board on this menu shows it within 30 seconds.");
      loadHistory().then(() => { drawHistory(); status(); }); loadPics().then(drawPics);
    }
  } catch (ex) {
    if (offline(ex)) { E.busyF = false; E.offline = "Not saved yet: no connection. Trying again…"; status(); setTimeout(pumpSaves, 5000); return; }
    E.qf.shift(); keepPending();
    showProblems(`<strong>Not saved:</strong> ${esc(ex.message)}`);
  }
  E.busyF = false; dirty();
  if (E.qf.length) pumpSaves();
}
window.addEventListener("online", () => { pumpSwitches(); pumpSaves(); });
/** On opening: taps that weren't confirmed go now; a Save that hadn't gone out comes back as Unsaved changes */
function resumePending() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(PKEY()) || "null"); } catch { /* none */ }
  if (!p) return;
  const sw = (p.switches || []).filter((j) => savedEntry(j.list, j.entry));
  for (const j of sw) { for (const c of [E.draft, E.saved]) { const x = c.lists?.[j.list]?.entries?.find((y) => y.id === j.entry); if (x) setFlag(x, j.what, j.on, j.today); } E.qs.push(j); }
  if (p.save?.content) E.draft = withFlags(normalise(p.save.content), normalise(p.save.content), E.saved);
  keepPending();
  const n = sw.length;
  if (n) toast(`${n} change${n === 1 ? "" : "s"} didn't save before the page closed: sending ${n === 1 ? "it" : "them"} now.`);
  if (p.save?.content && !same()) showProblems(`<strong>Your save from ${esc(new Date(p.save.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))} didn't finish before the page closed.</strong> Its changes are back here: check them and Save again.`);
  if (n) pumpSwitches();
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
    resumePending();
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
