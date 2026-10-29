// The menu format (DP-12, round E2a): a customer's lists, kept apart from the layout's design.
// A MENU belongs to an account and feeds every layout that names it (the counter board, the chalkboard, the outdoor
// stand, the phone menu): one set of lists, many boards. 1Point sets the lists up (their kind, room and which boxes the
// customer fills: the "spec"); the customer fills them in (the "content"), and what they save shows at once. A layout's
// block says which list it shows ({"list": "donuts"}); its heading, size, colours and place stay the layout's (1Point).
// One module for the site (supabase/32-menus.sql checks the same rules), the console, the menu editor and the screens.
//
// spec:    { "lists": [ { "key": "donuts", "name": "Donuts", "kind": "items", "room": 16,
//                         "fields": ["name", "price", "tags"], "caps": { "name": 28 }, "groupPrice": true, "hint": "…" },
//                       { "key": "hours", "name": "Hours", "kind": "hours", "room": 3, "note": true },
//                       { "key": "party", "name": "Party box", "kind": "text", "room": 1, "fields": ["title", "body", "link"] } ] }
// content: { "lists": { "donuts": { "price": "$1.89 each", "entries": [ { "id": "k3j9x2", "name": "Maple Bacon", "tags": ["favorite"] } ] },
//                       "hours":  { "note": "I-65 Exit 242", "entries": [ { "id": "h1a2b3", "days": [2,3,4,5,6], "open": "06:00", "close": "18:00" } ] } } }
// Every entry may be "hidden": true (kept, not shown); an item may be "soldOut": "2026-10-29" (sold out that day only:
// it clears itself at the building's midnight).

/** What each kind of list holds, and the most each box may say (1Point may set a list's caps lower, never higher). */
export const KINDS = {
  items: { fields: ["name", "line", "price", "image", "tags", "link"], maxRoom: 60, label: "Items" },
  text:  { fields: ["title", "body", "link"], maxRoom: 1, label: "Text" },
  hours: { fields: [], maxRoom: 14, label: "Hours" },
};
export const FIELD_MAX = { name: 80, line: 160, price: 16, title: 120, body: 400 };
export const FIELD_LABEL = { name: "Name", line: "Description", price: "Price", image: "Picture", tags: "Tags", link: "Web link", title: "Heading", body: "Text" };
/** Tags the customer can put on an item (sold out is its own switch, for the day). */
export const ITEM_TAGS = { new: "New", seasonal: "Seasonal", limited: "Limited", favorite: "Favorite" };
/** Which list kinds each block type can show. */
export const BINDS = { items: "items", chips: "items", rotator: "items", photo: "items", text: "text", hours: "hours" };
/** The content a block takes from its list (so the layout can't say these too). */
export const PROVIDES = { items: ["items", "price"], chips: ["items", "price"], rotator: ["items"], photo: ["image", "caption", "line", "price", "link", "alt"],
  text: ["title", "body", "link"], hours: ["hours", "note"] };
export const MAX_LISTS = 20, GROUP_PRICE_MAX = 24, NOTE_MAX = 80, MAX_BYTES = 256 * 1024;

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID_RE = /^[a-z0-9]{4,12}$/;
const TIME_RE = /^([01]\d|2[0-4]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE_RE = /^img:[a-z0-9][a-z0-9-]{0,59}$/;
const LINK_RE = /^https?:\/\/[^\s<>"']+\.[^\s<>"']+$/i;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const str = (v) => typeof v === "string";

/** A new entry's id (six letters and digits; it never changes, so history can follow an item through renames). */
export function newEntryId() {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = ""; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

/** The cap on one box of a list: the list's own, else the most the box may ever say. */
export const capOf = (list, field) => Math.min(FIELD_MAX[field] || 9999, Number.isInteger(list?.caps?.[field]) ? list.caps[field] : FIELD_MAX[field] || 9999);

/** Checks the lists 1Point sets up. Returns { errors: [{where, msg}], spec } (spec with defaults filled in). */
export function checkMenuSpec(input) {
  const errors = [], err = (where, msg) => errors.push({ where, msg });
  if (!isObj(input) || !Array.isArray(input.lists)) { err("lists", "The lists are { \"lists\": [ { \"key\": …, \"name\": …, \"kind\": …, \"room\": … } ] }."); return { errors, spec: null }; }
  for (const k of Object.keys(input)) if (k !== "lists") err("lists", `"${k}" isn't something the lists can say (only "lists").`);
  if (input.lists.length > MAX_LISTS) err("lists", `A menu can have up to ${MAX_LISTS} lists.`);
  const seen = new Set(), lists = [];
  input.lists.slice(0, MAX_LISTS).forEach((l, i) => {
    const where = `list ${i + 1}${isObj(l) && str(l.key) ? ` ("${l.key}")` : ""}`;
    if (!isObj(l)) { err(where, "Each list is an object."); return; }
    for (const k of Object.keys(l)) if (!["key", "name", "kind", "room", "fields", "caps", "groupPrice", "note", "hint"].includes(k)) err(where, `"${k}" isn't something a list can say (key, name, kind, room, fields, caps, groupPrice, note, hint).`);
    if (!str(l.key) || !KEY_RE.test(l.key)) err(where, "Each list needs a \"key\": lowercase letters, numbers and dashes, up to 40 (a block says it, and it never changes).");
    else if (seen.has(l.key)) err(where, `Two lists share the key "${l.key}".`);
    else seen.add(l.key);
    if (!str(l.name) || !l.name.trim() || l.name.length > 60) err(where, "Each list needs a \"name\" (up to 60 characters): what the customer sees in the menu editor.");
    const kind = KINDS[l.kind];
    if (!kind) { err(where, `"kind" must be one of: ${Object.keys(KINDS).join(", ")}.`); return; }
    const room = l.kind === "text" ? (l.room === undefined ? 1 : l.room) : l.room;
    if (!Number.isInteger(room) || room < 1 || room > kind.maxRoom) err(where, l.kind === "text" ? "A text list has room for 1." : `"room" is how many entries the list has room for: a whole number from 1 to ${kind.maxRoom}.`);
    let fields = [];
    if (l.kind === "hours") { if (l.fields !== undefined && !(Array.isArray(l.fields) && !l.fields.length)) err(where, "An hours list has no \"fields\" (each line is days, opening and closing)."); }
    else if (!Array.isArray(l.fields) || !l.fields.length || l.fields.some((f) => !kind.fields.includes(f))) err(where, `"fields" are the boxes the customer fills, from: ${kind.fields.join(", ")}.`);
    else fields = [...new Set(l.fields)];
    if (l.kind === "items" && fields.length && !fields.includes("name")) err(where, "An items list always has \"name\" among its fields.");
    const caps = {};
    if (l.caps !== undefined) {
      if (!isObj(l.caps)) err(where, "\"caps\" is { \"name\": 28 }: the most characters a box may hold on this list.");
      else for (const [f, n] of Object.entries(l.caps)) {
        if (!FIELD_MAX[f] || !fields.includes(f)) err(where, `caps.${f}: only the list's text boxes can have a cap (${fields.filter((x) => FIELD_MAX[x]).join(", ") || "none"}).`);
        else if (!Number.isInteger(n) || n < 4 || n > FIELD_MAX[f]) err(where, `caps.${f} must be a whole number from 4 to ${FIELD_MAX[f]}.`);
        else caps[f] = n;
      }
    }
    if (l.groupPrice !== undefined && (typeof l.groupPrice !== "boolean" || (l.groupPrice && l.kind !== "items"))) err(where, "\"groupPrice\" (one price over the whole list, like \"$1.89 each\") is true or false, on an items list.");
    if (l.note !== undefined && (typeof l.note !== "boolean" || (l.note && l.kind !== "hours"))) err(where, "\"note\" (a line under the hours) is true or false, on an hours list.");
    if (l.hint !== undefined && (!str(l.hint) || l.hint.length > 200)) err(where, "\"hint\" is a short line for the customer, up to 200 characters.");
    lists.push({ key: l.key, name: str(l.name) ? l.name.trim() : "", kind: l.kind, room, fields, caps,
      groupPrice: l.groupPrice === true, note: l.note === true, hint: str(l.hint) ? l.hint : "" });
  });
  return { errors, spec: errors.length ? null : { lists } };
}

/** Says an entry in plain words for a message: "item 3 (\"Cold Brew\")". */
const entryWhere = (list, e, i) => {
  const what = list.kind === "hours" ? "line" : list.kind === "text" ? "entry" : "item";
  const nm = isObj(e) && (e.name || e.title) ? ` ("${String(e.name || e.title).slice(0, 40)}")` : "";
  return `${what} ${i + 1}${nm}`;
};

/**
 * Checks what a customer saves against the lists. Returns { errors: [{where, msg}], content } (content tidied: unknown
 * lists dropped is an error, text kept as typed). images: a Set of the account's picture keys, to check pictures exist
 * (left out: not checked here; the database checks).
 */
export function checkMenuContent(spec, input, { images } = {}) {
  const errors = [], err = (where, msg) => errors.push({ where, msg });
  const lists = spec?.lists || [];
  const byKey = Object.fromEntries(lists.map((l) => [l.key, l]));
  if (!isObj(input) || (input.lists !== undefined && !isObj(input.lists))) { err("menu", "The menu is { \"lists\": { \"<list key>\": { \"entries\": [ … ] } } }."); return { errors, content: null }; }
  if (JSON.stringify(input).length > MAX_BYTES) err("menu", "This menu is too large (at most 256 KB).");
  const out = { lists: {} };
  for (const [key, c] of Object.entries(input.lists || {})) {
    const L = byKey[key];
    if (!L) { err(`list "${key}"`, `There's no list "${key}" on this menu.`); continue; }
    const where = `"${L.name}"`;
    if (!isObj(c)) { err(where, "Each list is { \"entries\": [ … ] }."); continue; }
    for (const k of Object.keys(c)) if (!["entries", "price", "note"].includes(k)) err(where, `"${k}" isn't part of a list.`);
    const o = { entries: [] };
    if (c.price !== undefined && c.price !== "") {
      if (!L.groupPrice) err(where, "This list has no price over the whole list.");
      else if (!str(c.price) || c.price.length > GROUP_PRICE_MAX) err(where, `The list's price is at most ${GROUP_PRICE_MAX} characters.`);
      else o.price = c.price;
    }
    if (c.note !== undefined && c.note !== "") {
      if (!L.note) err(where, "This list has no note.");
      else if (!str(c.note) || c.note.length > NOTE_MAX) err(where, `The note is at most ${NOTE_MAX} characters.`);
      else o.note = c.note;
    }
    const entries = c.entries === undefined ? [] : c.entries;
    if (!Array.isArray(entries)) { err(where, "\"entries\" is a list."); continue; }
    if (entries.length > L.room) err(where, `${where} has room for ${L.room}; this has ${entries.length}. More room is a menu expansion: ask 1Point.`);
    const ids = new Set();
    entries.slice(0, L.room).forEach((e, i) => {
      const at = `${where}, ${entryWhere(L, e, i)}`;
      if (!isObj(e)) { err(at, "Each entry is an object."); return; }
      const allowed = ["id", "hidden", ...(L.kind === "items" ? ["soldOut"] : []), ...(L.kind === "hours" ? ["days", "open", "close"] : L.fields)];
      const x = {};
      for (const [k, v] of Object.entries(e)) {
        if (!allowed.includes(k)) { err(at, L.kind !== "hours" && KINDS[L.kind].fields.includes(k) ? `This list has no ${FIELD_LABEL[k].toLowerCase()} box (1Point can add one).` : `"${k}" isn't part of an entry here.`); continue; }
        if (k === "id") { if (!str(v) || !ID_RE.test(v)) err(at, "Its id is 4 to 12 lowercase letters and digits."); else if (ids.has(v)) err(at, "Two entries share an id."); else { ids.add(v); x.id = v; } continue; }
        if (k === "hidden") { if (typeof v !== "boolean") err(at, "\"hidden\" is true or false."); else if (v) x.hidden = true; continue; }
        if (k === "soldOut") { if (!str(v) || !DATE_RE.test(v)) err(at, "\"soldOut\" is the day it's sold out, like \"2026-10-29\"."); else x.soldOut = v; continue; }
        if (k === "days") { if (!Array.isArray(v) || !v.length || v.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) err(at, "Choose at least one day."); else x.days = [...new Set(v)].sort(); continue; }
        if (k === "open" || k === "close") { if (!str(v) || !TIME_RE.test(v) || v > "24:00") err(at, `The ${k === "open" ? "opening" : "closing"} time is a time like 06:00 or 18:30.`); else x[k] = v; continue; }
        if (k === "tags") { if (!Array.isArray(v) || v.length > 4 || v.some((t) => !ITEM_TAGS[t])) err(at, `Tags are from: ${Object.values(ITEM_TAGS).join(", ")}.`); else if (v.length) x.tags = [...new Set(v)]; continue; }
        if (k === "image") { if (v === "") continue; if (!str(v) || !IMAGE_RE.test(v)) err(at, "Choose a picture from the account's pictures."); else if (images && !images.has(v.slice(4))) err(at, `The picture "${v.slice(4)}" isn't in this account's pictures.`); else x.image = v; continue; }
        if (k === "link") { if (v === "") continue; if (!str(v) || v.length > 300 || !LINK_RE.test(v)) err(at, "The web link is an address written in full, like https://donutjoescoffee.com (at most 300 characters)."); else x.link = v; continue; }
        // a text box
        if (!str(v)) { err(at, `${FIELD_LABEL[k]} is text.`); continue; }
        const cap = capOf(L, k);
        if (v.length > cap) { err(at, `${FIELD_LABEL[k]} is ${v.length} characters; this list has room for ${cap}.`); continue; }
        if (v !== "") x[k] = v;
      }
      if (!x.id) { if (e.id === undefined) err(at, "It has no id."); return; }
      if (L.kind === "items" && !String(x.name || "").trim()) err(at, "An item needs a name.");
      if (L.kind === "text" && !String(x.title || "").trim() && !String(x.body || "").trim()) err(at, "Write something, or remove the entry.");
      if (L.kind === "hours" && !(x.days && x.open && x.close)) err(at, "A line of hours needs its days, an opening time and a closing time.");
      o.entries.push(x);
    });
    out.lists[key] = o;
  }
  return { errors, content: errors.length ? null : out };
}

/** The entries of a list that show: not hidden, and complete. */
export function shownEntries(L, c) {
  const list = (c?.entries || []).filter((e) => !e.hidden);
  if (L.kind === "items") return list.filter((e) => String(e.name || "").trim());
  if (L.kind === "hours") return list.filter((e) => e.days && e.open && e.close);
  return list.filter((e) => e.title || e.body);
}

/**
 * The layout as drawn with its menu: each block that says {"list": …} takes that list's entries (only those shown; an
 * item sold out today is marked so), and a block whose list shows nothing is switched off. date is the building's
 * "YYYY-MM-DD". With room: true (the boards), an items or chips block also carries its list's room, so the board keeps
 * the space for a full list and the text stays the size it was designed at whatever's filled in (Scot, 2026-10-28).
 * The phone menu draws without room.
 */
export function applyMenu(doc, menu, date, { room = false } = {}) {
  if (!doc || !doc.blocks.some((b) => b.content?.list)) return doc;
  const spec = menu?.spec?.lists || [], content = menu?.content?.lists || {};
  const byKey = Object.fromEntries(spec.map((l) => [l.key, l]));
  const blocks = doc.blocks.map((b) => {
    const key = b.content?.list;
    if (!key) return b;
    const L = byKey[key];
    if (!L || BINDS[b.type] !== L.kind) return { ...b, on: false };
    const C = content[key] || {};
    const shown = shownEntries(L, C);
    const c = { ...b.content };
    const sold = (e) => !!e.soldOut && e.soldOut === date;
    const item = (e) => ({ name: e.name, ...(e.line ? { line: e.line } : {}), ...(e.price ? { price: e.price } : {}), ...(e.link ? { link: e.link } : {}),
      tags: [...(e.tags || []), ...(sold(e) ? ["sold-out"] : [])] });
    let on = shown.length > 0;
    switch (b.type) {
      case "items": case "chips":
        c.items = shown.map(item);
        if (L.groupPrice && C.price) c.price = C.price;
        if (room) c.room = L.room;
        break;
      case "rotator": {   // a featured item that's sold out today steps out of the turns
        const feat = shown.filter((e) => !sold(e));
        c.items = feat.map((e) => ({ ...(e.image ? { image: e.image } : {}), alt: e.name, caption: e.name, ...(e.line ? { line: e.line } : {}), ...(e.price ? { price: e.price } : {}), ...(e.link ? { link: e.link } : {}) }));
        on = feat.length > 0;
        break;
      }
      case "photo": {
        const e = shown.find((x) => !sold(x));
        if (e) Object.assign(c, { ...(e.image ? { image: e.image } : {}), alt: e.name, caption: e.name, ...(e.line ? { line: e.line } : {}), ...(e.price ? { price: e.price } : {}), ...(e.link ? { link: e.link } : {}) });
        on = !!e;
        break;
      }
      case "text": {
        const e = shown[0];
        if (e) Object.assign(c, { ...(e.title ? { title: e.title } : {}), ...(e.body ? { body: e.body } : {}), ...(e.link ? { link: e.link } : {}) });
        break;
      }
      case "hours":
        c.hours = shown.map((e) => ({ days: e.days, open: e.open, close: e.close }));
        if (L.note && C.note) c.note = C.note;
        break;
    }
    return { ...b, content: c, on: b.on !== false && on };
  });
  return { ...doc, blocks };
}

/** The pictures a menu's content uses ("img:…" keys, without "img:"). */
export const menuPictureKeys = (content) => [...new Set(JSON.stringify(content || {}).match(/"img:[a-z0-9][a-z0-9-]{0,59}"/g)?.map((s) => s.slice(5, -1)) || [])];

/** What changed between two saves of a menu, in plain lines, for the history. */
export function menuChanges(spec, before, after, max = 40) {
  const lines = [];
  const lists = spec?.lists || [];
  const b = before?.lists || {}, a = after?.lists || {};
  const say = (e) => e.name || e.title || (e.days ? `${e.days.length} day${e.days.length === 1 ? "" : "s"}` : "an entry");
  const show = (v) => (v === undefined || v === "" ? "(blank)" : Array.isArray(v) ? (v.length ? v.join(", ") : "(none)") : String(v));
  for (const L of lists) {
    const B = b[L.key] || {}, A = a[L.key] || {};
    if ((B.price || "") !== (A.price || "")) lines.push(`${L.name}: list price ${show(B.price)} → ${show(A.price)}`);
    if ((B.note || "") !== (A.note || "")) lines.push(`${L.name}: note ${show(B.note)} → ${show(A.note)}`);
    const be = B.entries || [], ae = A.entries || [];
    const bi = Object.fromEntries(be.map((e) => [e.id, e])), ai = Object.fromEntries(ae.map((e) => [e.id, e]));
    for (const e of ae) if (!bi[e.id]) lines.push(`${L.name}: added ${say(e)}`);
    for (const e of be) if (!ai[e.id]) lines.push(`${L.name}: removed ${say(e)}`);
    for (const e of ae) {
      const o = bi[e.id]; if (!o) continue;
      for (const k of ["name", "title", "line", "body", "price", "image", "link", "tags", "days", "open", "close"]) {
        if (JSON.stringify(o[k] ?? "") !== JSON.stringify(e[k] ?? "") && !(Array.isArray(o[k] ?? []) && Array.isArray(e[k] ?? []) && !(o[k] || []).length && !(e[k] || []).length))
          lines.push(`${L.name} · ${say(e)}: ${(FIELD_LABEL[k] || k).toLowerCase()} ${show(o[k])} → ${show(e[k])}`);
      }
      if (!!o.hidden !== !!e.hidden) lines.push(`${L.name}: ${e.hidden ? "hid" : "showed"} ${say(e)}`);
      if ((o.soldOut || "") !== (e.soldOut || "")) lines.push(`${L.name}: ${e.soldOut ? `${say(e)} sold out (${e.soldOut})` : `${say(e)} back on`}`);
    }
    const order = (list, other) => list.filter((e) => other[e.id]).map((e) => e.id).join(",");
    if (order(be, ai) !== order(ae, bi)) lines.push(`${L.name}: reordered`);
  }
  return lines.length > max ? [...lines.slice(0, max), `…and ${lines.length - max} more`] : lines;
}

/**
 * "Make lists from this layout" (1Point): turns the items, chips, pictures, text and hours a layout spells out itself
 * into a menu's lists, and points those blocks at them. Each list gets room for about a third more than it holds now
 * (Scot: overbuilt, e.g. 30 → 40), only the boxes the layout already uses, and caps a little longer than the longest
 * entry today (1Point can change any of it). ids: the blocks to turn (default: every items, chips, rotator, text and
 * hours block not already on a list; a lone photo only when chosen). Returns { spec, content, doc, made: [block ids] }.
 */
export function extractMenu(doc, ids) {
  const lists = [], content = { lists: {} }, made = [];
  const roomFor = (n, max) => Math.min(max, Math.max(1, n + Math.max(1, Math.round(n / 3))));
  const capFor = (vals, field, min) => Math.min(FIELD_MAX[field], Math.max(min, Math.ceil(Math.max(0, ...vals.map((v) => String(v || "").length)) * 1.3)));
  const MINCAP = { name: 24, line: 60, price: 10, title: 60, body: 160 };
  // A list's name in the menu editor: the block's label, else its heading, else a plain name for its kind
  const nameOf = (b) => String(b.label || (b.type === "rotator" ? "Featured pictures" : b.type === "text" ? "" : b.content?.heading) || (b.type === "text" ? "Announcement" : b.id))
    .replace(/\s*·.*$/, "").slice(0, 60) || b.id;
  const blocks = doc.blocks.map((b) => {
    // a lone photo stays the layout's unless it's chosen (its picture is part of the design; a list of pictures is a rotator)
    if (!BINDS[b.type] || b.content?.list || (ids ? !ids.includes(b.id) : b.type === "photo")) return b;
    const c = { ...(b.content || {}) }, key = b.id;
    let L, entries;
    if (b.type === "items" || b.type === "chips" || b.type === "rotator") {
      const src = c.items || [];
      const pics = b.type === "rotator";
      entries = src.map((it) => ({ id: newEntryId(), name: pics ? it.caption || it.alt || "" : it.name || "",
        ...(it.line ? { line: it.line } : {}), ...(it.price ? { price: it.price } : {}), ...(it.image ? { image: it.image } : {}),
        ...(it.link ? { link: it.link } : {}), ...((it.tags || []).filter((t) => ITEM_TAGS[t]).length ? { tags: it.tags.filter((t) => ITEM_TAGS[t]) } : {}),
        ...((it.tags || []).includes("sold-out") ? { hidden: true } : {}) })).filter((e) => e.name);
      const used = (f) => entries.some((e) => e[f] !== undefined);
      const fields = ["name", ...["line", "price", "image", "tags", "link"].filter((f) => used(f) || (pics && (f === "image" || f === "line" || f === "price")))];
      const caps = {};
      for (const f of fields.filter((x) => FIELD_MAX[x])) caps[f] = capFor(entries.map((e) => e[f]), f, MINCAP[f]);
      L = { key, name: nameOf(b), kind: "items", room: roomFor(entries.length, KINDS.items.maxRoom), fields, caps, groupPrice: !!c.price, note: false, hint: "" };
      content.lists[key] = { ...(c.price ? { price: c.price } : {}), entries };
      for (const k of PROVIDES[b.type]) delete c[k];
    } else if (b.type === "photo") {
      entries = c.image || c.caption ? [{ id: newEntryId(), name: c.caption || c.alt || "Picture", ...(c.line ? { line: c.line } : {}), ...(c.price ? { price: c.price } : {}), ...(c.image ? { image: c.image } : {}), ...(c.link ? { link: c.link } : {}) }] : [];
      L = { key, name: nameOf(b), kind: "items", room: 3, fields: ["name", "image", "line", "price"], caps: { name: 40, line: 120, price: 12 }, groupPrice: false, note: false, hint: "The first one shown is the picture on the board." };
      content.lists[key] = { entries };
      for (const k of PROVIDES.photo) delete c[k];
    } else if (b.type === "text") {
      const fields = ["title", "body", "link"].filter((f) => c[f] !== undefined);
      if (!fields.length) return b;
      entries = [{ id: newEntryId(), ...Object.fromEntries(fields.map((f) => [f, c[f]])) }];
      const caps = {};
      for (const f of fields.filter((x) => FIELD_MAX[x])) caps[f] = capFor([c[f]], f, MINCAP[f]);
      L = { key, name: nameOf(b), kind: "text", room: 1, fields, caps, groupPrice: false, note: false, hint: "" };
      content.lists[key] = { entries };
      for (const k of PROVIDES.text) delete c[k];
    } else if (b.type === "hours") {
      entries = (c.hours || []).map((h) => ({ id: newEntryId(), days: h.days, open: h.open, close: h.close }));
      L = { key, name: String(b.label || c.heading || "Hours").slice(0, 60), kind: "hours", room: roomFor(entries.length, KINDS.hours.maxRoom), fields: [], caps: {}, groupPrice: false, note: true, hint: "" };
      content.lists[key] = { ...(c.note ? { note: String(c.note).slice(0, NOTE_MAX) } : {}), entries };
      for (const k of PROVIDES.hours) delete c[k];
    }
    if (!L.groupPrice) delete L.groupPrice;
    if (!L.note) delete L.note;
    if (!L.hint) delete L.hint;
    if (!Object.keys(L.caps).length) delete L.caps;
    if (L.kind === "hours") delete L.fields;
    lists.push(L); made.push(b.id);
    c.list = key;
    return { ...b, content: c };
  });
  return { spec: { lists }, content, doc: { ...doc, blocks }, made };
}
