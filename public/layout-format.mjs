// The layout format (DP-11, round E1a): what a layout is, how it's checked, and when a block shows.
// One module for all three places that need it: the site (netlify/functions/layouts.mjs checks a layout before it's
// published), the console (the Layouts tab), and the screen (public/board.js draws it). Data only, never code
// (expansion-brief.md): everything a layout can say is in this file, and anything else is refused.
//
// A layout:
//   { "format": 1, "orientation": "portrait" | "landscape",
//     "grid":    { "cols": 12, "rows": 24, "gap": 16, "margin": 40 },     gap and margin in canvas pixels
//     "viewing": { "inches": 43, "metres": 3 },                            for the text-size guardrail
//     "theme":   { "palette": { "bg": "#…", "ink": "#…", … }, "fonts": { "display": "Fraunces", "body": "Instrument Sans", "accent": "Pacifico" } },
//     "blocks":  [ { "id": "hero", "type": "photo", "at": { "col": 1, "row": 4, "w": 12, "h": 7 }, "layer": 0,
//                    "style": { … }, "content": { … }, "when": { "days": [1,2,3,4,5], "from": "11:00", "to": "14:00" }, "on": true } ] }
// The canvas is 1080 x 1920 (portrait) or 1920 x 1080 (landscape) whatever the screen; the screen scales it to fit.
// Days are 1 = Monday to 7 = Sunday. Times are 24-hour "HH:MM" in the building's time zone; "to" is not included.

import { BINDS, PROVIDES } from "./menu-format.mjs";

export const FORMAT = 1;
export const canvas = (orientation) => (orientation === "landscape" ? { w: 1920, h: 1080 } : { w: 1080, h: 1920 });
export const POWERED_STRIP = 36;   // the bottom margin is never less than this: "Powered by WayTuGo" sits in it

/** The curated fonts (public/fonts; Scot, 2026-10-28: from google/fonts, stored on the site so they work offline). */
export const FONTS = {
  "Instrument Sans":  { css: '"Instrument Sans", system-ui, sans-serif', files: [["InstrumentSans-Regular.ttf", 400], ["InstrumentSans-Bold.ttf", 700]] },
  "Lora":             { css: '"Lora", Georgia, serif', files: [["Lora-Bold.ttf", 700]] },
  "Oswald":           { css: '"Oswald", "Arial Narrow", sans-serif', files: [["Oswald-Medium.ttf", 500], ["Oswald-Bold.ttf", 700]] },
  "Bebas Neue":       { css: '"Bebas Neue", Impact, sans-serif', files: [["BebasNeue-Regular.ttf", 400]] },
  "Alfa Slab One":    { css: '"Alfa Slab One", Rockwell, serif', files: [["AlfaSlabOne-Regular.ttf", 400]] },
  "Fraunces":         { css: '"Fraunces", Georgia, serif', files: [["Fraunces-SemiBold.ttf", 600], ["Fraunces-ExtraBold.ttf", 800]] },
  "Playfair Display": { css: '"Playfair Display", Georgia, serif', files: [["PlayfairDisplay-Variable.ttf", "400 900"]] },
  "Pacifico":         { css: '"Pacifico", cursive', files: [["Pacifico-Regular.ttf", 400]] },
  "Crimson Pro":      { css: '"Crimson Pro", Georgia, serif', files: [["CrimsonPro-SemiBold.ttf", 600]] },
  // E2d (DP-13): the chalkboard's hand-drawn lettering (Scot chose it from six, 2026-10-29)
  "Caveat Brush":     { css: '"Caveat Brush", "Comic Sans MS", cursive', files: [["CaveatBrush-Regular.ttf", 400]] },
};

// ── Looks (E2d, DP-13): one layout drawn two ways ──
// "house": the layout's own palette and fonts. "chalkboard": a slate drawn by the screen (no picture to load), chalk
// colours picked from six for the titles, the prices and the accents (chips, lines, boxes' edges), plain text always
// white chalk, a chalk grain on the lettering, and an optional wooden frame. The layout says which looks it offers
// (theme.looks) and its defaults (theme.look, theme.chalk); the customer's choice is kept with the menu
// (menu-format.mjs, content.boards) and drawn by applyLook below.
export const LOOKS = { house: "House", chalkboard: "Chalkboard" };
export const SLATE = "#2a3230";
export const CHALK = { white: "#f3f1e8", yellow: "#f6dd6b", pink: "#f4a7c1", blue: "#9fd3f0", green: "#a9df9c", orange: "#f6b46a" };
export const CHALK_NAMES = { white: "White", yellow: "Yellow", pink: "Pink", blue: "Blue", green: "Green", orange: "Orange" };
export const CHALK_ROLES = { titles: "Titles", prices: "Prices", accents: "Accents" };
export const LETTERING = { sign: "Sign-writer", hand: "Chalk hand" };
const LETTER_FONTS = { sign: { display: "Pacifico", item: "Bebas Neue" }, hand: { display: "Caveat Brush", item: "Caveat Brush" } };
export const CHALK_DEFAULT = { titles: "yellow", prices: "pink", accents: "blue", lettering: "sign", frame: false };
const OPTION_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The palette's names. Each surface has the colour of the text that goes on it ("onAccent" on "accent"). */
export const PALETTE_KEYS = ["bg", "ink", "muted", "accent", "onAccent", "panel", "onPanel", "highlight", "onHighlight", "line"];
export const SURFACES = { none: null, bg: "ink", accent: "onAccent", panel: "onPanel", highlight: "onHighlight" };
const DEFAULT_PALETTE = { bg: "#ffffff", ink: "#1b1f24", muted: "#5b6470", accent: "#0d3b66", onAccent: "#ffffff",
  panel: "#f1f3f6", onPanel: "#1b1f24", highlight: "#f2c14e", onHighlight: "#1b1f24", line: "#d9dde3" };

/** Text sizes, in canvas pixels (the canvas's short side is always 1080). */
export const SIZES = { xs: 24, s: 30, m: 38, l: 50, xl: 66, xxl: 88, huge: 120 };
const RADII = { none: 0, s: 8, m: 18, l: 30, round: 9999 };
const PADS = { none: 0, s: 12, m: 24, l: 40 };
export const TAGS = { "sold-out": "Sold out", seasonal: "Seasonal", new: "New", limited: "Limited", favorite: "Favorite" };

/** Where a cropped picture keeps its subject. */
const FOCUS = ["center", "top", "bottom", "left", "right"];
/** Block types and the content each may carry: [name, kind, max length or count]. */
// E2a (DP-12): "list" on items, chips, rotator, photo, text and hours blocks: the block shows that list of the layout's
// menu (public/menu-format.mjs), and the content the list gives can't also be written in the layout.
// E1c: "link" on items, text, photos and a rotator's pictures: a web address the phone menu opens in a new tab (the board
// itself shows no links)
const ITEM = { name: ["text", 80], line: ["text", 160], price: ["text", 16], tags: ["tags"], link: ["link"] };
const SESSION = { days: ["days"], from: ["time"], to: ["time"], name: ["text", 60], line: ["text", 120] };
export const TYPES = {
  text:      { kicker: ["text", 60], title: ["text", 120], body: ["text", 400], note: ["text", 120], link: ["link"], list: ["listkey"], schedule: ["bool"] },
  // E2e (DP-13): "room" on a block that writes its own items: the room its list gets when Make these lists turns it
  // into one (and the board keeps that room meanwhile); "schedule": true, its entries get dates and times. A block on
  // a list takes both from the list
  items:     { heading: ["text", 60], price: ["text", 24], columns: ["int", 1, 3], leaders: ["bool"], items: ["list", 60, ITEM], list: ["listkey"], room: ["int", 1, 60], schedule: ["bool"] },
  chips:     { heading: ["text", 60], price: ["text", 24], items: ["list", 60, { name: ["text", 80], tags: ["tags"] }], list: ["listkey"], room: ["int", 1, 60] },
  price:     { label: ["text", 20], price: ["text", 16], note: ["text", 30] },
  photo:     { image: ["image"], alt: ["text", 120], caption: ["text", 80], line: ["text", 120], price: ["text", 16], fit: ["enum", ["cover", "contain"]], focus: ["enum", FOCUS], link: ["link"], list: ["listkey"] },
  logo:      { image: ["image"], text: ["text", 60], chalkImage: ["image"] },   // E2d: a light logo for the chalkboard (else the name in chalk)
  // E1b: several pictures taking turns, each with its own caption, line and price
  rotator:   { seconds: ["int", 4, 60], fit: ["enum", ["cover", "contain"]], focus: ["enum", FOCUS],
               items: ["list", 12, { image: ["image"], alt: ["text", 120], caption: ["text", 80], line: ["text", 120], price: ["text", 16], link: ["link"] }], list: ["listkey"] },
  clock:     { show: ["enum", ["time", "date", "both"]] },
  weather:   { label: ["text", 30] },
  hours:     { heading: ["text", 40], hours: ["list", 14, { days: ["days"], open: ["time"], close: ["time"] }], note: ["text", 80], list: ["listkey"] },
  timetable: { heading: ["text", 60], columns: ["strings", 6, 24], rows: ["list", 14, { days: ["days"], label: ["text", 16], cells: ["strings", 6, 40] }] },
  nownext:   { now: ["text", 20], next: ["text", 20], empty: ["text", 60], sessions: ["list", 40, SESSION] },
  // E1c: the QR code for "Take this menu with you" (waytugo.com/m/<the layout's code>), with a line under it
  qr:        { line: ["text", 80] },
};
export const QR_LINE = "Take this menu with you";
/** A QR code reads from about 10 times its width; below this many millimetres across, the guardrail warns. */
export const QR_MIN_MM = 100;
export const FAMILIES = ["list", "schedule", "menu", "board"];

const STYLE = {
  surface: ["enum", Object.keys(SURFACES)], ink: ["palette"], font: ["enum", ["display", "body", "accent"]],
  size: ["enum", Object.keys(SIZES)], align: ["enum", ["left", "center", "right"]], valign: ["enum", ["top", "middle", "bottom"]],
  radius: ["enum", Object.keys(RADII)], pad: ["enum", Object.keys(PADS)], border: ["palette"], tilt: ["int", -8, 8], shadow: ["bool"],
  case: ["enum", ["normal", "upper"]],
};

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const TIME_RE = /^([01]\d|2[0-4]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE_RE = /^img:[a-z0-9][a-z0-9-]{0,59}$/;
const LINK_RE = /^https?:\/\/[^\s<>"']+\.[^\s<>"']+$/i;   // E1c: a web address, written in full   // E1b: a picture's key in the layout's account (console → Layouts → Pictures)

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/**
 * Checks a layout. Returns { errors, warnings, doc }: errors stop it being published (a malformed layout or something
 * the format doesn't allow); warnings are the guardrails (expansion-brief.md: a customer designer will be stopped by
 * them, 1Point is warned and may publish anyway). doc is the layout with defaults filled in, as the screen draws it.
 * Each problem is { where, msg } in plain words.
 * ctx.lists (E2a): the layout's menu's lists (its spec's lists), or null when the layout has no menu; given, each block's
 * "list" must be one of them, of a kind the block can show. Left out (a screen drawing a published version), not checked.
 */
export function checkLayout(input, ctx = {}) {
  const errors = [], warnings = [];
  const err = (where, msg) => errors.push({ where, msg });
  const warn = (where, msg, kind) => warnings.push({ where, msg, kind });
  if (!isObj(input)) { err("layout", "A layout is a JSON object: { \"format\": 1, \"orientation\": …, \"grid\": …, \"theme\": …, \"blocks\": [ … ] }."); return { errors, warnings, doc: null }; }
  const known = (obj, keys, where) => { for (const k of Object.keys(obj)) if (!keys.includes(k)) err(where, `"${k}" isn't something a layout can say here (allowed: ${keys.join(", ")}).`); };
  known(input, ["format", "orientation", "grid", "viewing", "theme", "blocks", "name", "notes", "options"], "layout");
  if (input.format !== FORMAT) err("format", `"format" must be ${FORMAT}.`);
  const orientation = input.orientation;
  if (!["portrait", "landscape"].includes(orientation)) err("orientation", "\"orientation\" must be \"portrait\" or \"landscape\".");

  // Grid
  const g = isObj(input.grid) ? input.grid : {};
  if (!isObj(input.grid)) err("grid", "\"grid\" is missing: { \"cols\": 12, \"rows\": 24 }.");
  else known(g, ["cols", "rows", "gap", "margin"], "grid");
  const int = (v, lo, hi, dflt, where, label) => {
    if (v === undefined) return dflt;
    if (!Number.isInteger(v) || v < lo || v > hi) { err(where, `${label} must be a whole number from ${lo} to ${hi}.`); return dflt; }
    return v;
  };
  const grid = { cols: int(g.cols, 4, 24, 12, "grid.cols", "Columns"), rows: int(g.rows, 4, 48, 24, "grid.rows", "Rows"),
    gap: int(g.gap, 0, 60, 16, "grid.gap", "The gap"), margin: int(g.margin, 0, 120, 40, "grid.margin", "The margin") };

  const vw = isObj(input.viewing) ? input.viewing : {};
  if (input.viewing !== undefined && !isObj(input.viewing)) err("viewing", "\"viewing\" is { \"inches\": 43, \"metres\": 3 }.");
  const num = (v, lo, hi, dflt, where, label) => (v === undefined ? dflt : typeof v === "number" && v >= lo && v <= hi ? v : (err(where, `${label} must be a number from ${lo} to ${hi}.`), dflt));
  const viewing = { inches: num(vw.inches, 7, 100, 43, "viewing.inches", "The screen size (inches)"), metres: num(vw.metres, 0.5, 15, 3, "viewing.metres", "The viewing distance (metres)") };

  // Theme
  const th = isObj(input.theme) ? input.theme : {};
  if (input.theme !== undefined && !isObj(input.theme)) err("theme", "\"theme\" is { \"palette\": { … }, \"fonts\": { … } }.");
  else if (isObj(input.theme)) known(th, ["palette", "fonts", "background", "looks", "look", "chalk"], "theme");
  const palette = { ...DEFAULT_PALETTE };
  if (th.palette !== undefined) {
    if (!isObj(th.palette)) err("theme.palette", "The palette is { \"bg\": \"#ffffff\", \"ink\": \"#1b1f24\", … }.");
    else for (const [k, v] of Object.entries(th.palette)) {
      if (!PALETTE_KEYS.includes(k)) err(`theme.palette.${k}`, `"${k}" isn't a palette colour (allowed: ${PALETTE_KEYS.join(", ")}).`);
      else if (typeof v !== "string" || !HEX_RE.test(v)) err(`theme.palette.${k}`, `${k} must be a colour like "#c0392b".`);
      else palette[k] = v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v.toLowerCase();
    }
  }
  const fonts = { display: "Instrument Sans", body: "Instrument Sans", accent: "Instrument Sans" };
  if (th.fonts !== undefined) {
    if (!isObj(th.fonts)) err("theme.fonts", "The fonts are { \"display\": \"Fraunces\", \"body\": \"Instrument Sans\", \"accent\": \"Pacifico\" }.");
    else for (const [k, v] of Object.entries(th.fonts)) {
      if (!["display", "body", "accent"].includes(k)) err(`theme.fonts.${k}`, `"${k}" isn't a font role (display, body, accent).`);
      else if (!FONTS[v]) err(`theme.fonts.${k}`, `"${v}" isn't on the font list (${Object.keys(FONTS).join(", ")}).`);
      else fonts[k] = v;
    }
  }
  if (th.fonts && fonts.accent === "Instrument Sans" && !th.fonts.accent) fonts.accent = fonts.display;

  // E2d: the looks the layout offers, and its defaults (1Point's); the customer picks among them in the menu editor
  let looks = ["house"], look = "house";
  if (th.looks !== undefined) {
    if (!Array.isArray(th.looks) || !th.looks.length || th.looks.some((x) => !LOOKS[x])) err("theme.looks", `"looks" is the looks this board offers, from: ${Object.keys(LOOKS).join(", ")}.`);
    else looks = [...new Set(th.looks)];
  }
  if (th.look !== undefined) {
    if (!LOOKS[th.look]) err("theme.look", `"look" is one of: ${Object.keys(LOOKS).join(", ")}.`);
    else if (!looks.includes(th.look)) err("theme.look", `"look" is "${th.look}", which isn't among its "looks".`);
    else look = th.look;
  } else if (!looks.includes(look)) look = looks[0];
  const chalk = { ...CHALK_DEFAULT };
  if (th.chalk !== undefined) {
    if (!isObj(th.chalk)) err("theme.chalk", "\"chalk\" is { \"titles\": \"yellow\", \"prices\": \"pink\", \"accents\": \"blue\", \"lettering\": \"sign\", \"frame\": false }.");
    else for (const [k, v] of Object.entries(th.chalk)) {
      if (CHALK_ROLES[k]) { if (!CHALK[v]) err(`theme.chalk.${k}`, `${k} is a chalk colour: ${Object.keys(CHALK).join(", ")}.`); else chalk[k] = v; }
      else if (k === "lettering") { if (!LETTERING[v]) err("theme.chalk.lettering", `lettering is ${Object.keys(LETTERING).map((x) => `"${x}"`).join(" or ")}.`); else chalk.lettering = v; }
      else if (k === "frame") { if (typeof v !== "boolean") err("theme.chalk.frame", "frame is true or false."); else chalk.frame = v; }
      else err(`theme.chalk.${k}`, `"${k}" isn't part of chalk (titles, prices, accents, lettering, frame).`);
    }
  }
  // E2d: the board's options (Scot: a tick box such as "Show the coffee bar"); a block says which way it shows with
  // "showWhen": { "option": "coffee-bar", "is": "on" | "off" }, so 1Point can lay out both arrangements
  const options = [];
  if (input.options !== undefined) {
    if (!Array.isArray(input.options) || input.options.length > 6) err("options", "\"options\" is a list of up to 6: [ { \"key\": \"coffee-bar\", \"label\": \"Show the coffee bar\", \"default\": false } ].");
    else input.options.forEach((o, i) => {
      const at = `option ${i + 1}`;
      if (!isObj(o) || Object.keys(o).some((k) => !["key", "label", "default"].includes(k))) { err(at, "An option is { \"key\", \"label\", \"default\" }."); return; }
      if (typeof o.key !== "string" || !OPTION_KEY_RE.test(o.key)) { err(at, "Its \"key\" is lowercase letters, numbers and dashes, up to 40."); return; }
      if (options.some((x) => x.key === o.key)) { err(at, `Two options share the key "${o.key}".`); return; }
      if (typeof o.label !== "string" || !o.label.trim() || o.label.length > 60) { err(at, "Its \"label\" is what the customer sees by the tick box (up to 60 characters)."); return; }
      if (o.default !== undefined && typeof o.default !== "boolean") { err(at, "\"default\" is true or false."); return; }
      options.push({ key: o.key, label: o.label.trim(), default: o.default === true });
    });
  }

  // Blocks
  const blocks = [];
  if (!Array.isArray(input.blocks)) err("blocks", "\"blocks\" must be a list: [ { \"id\": …, \"type\": …, \"at\": … }, … ].");
  else if (input.blocks.length > 60) err("blocks", "A layout can have up to 60 blocks.");
  const ids = new Set();
  (Array.isArray(input.blocks) ? input.blocks.slice(0, 60) : []).forEach((b, i) => {
    const where = `block ${i + 1}${isObj(b) && typeof b.id === "string" ? ` ("${b.id}")` : ""}`;
    if (!isObj(b)) { err(where, "Each block is an object."); return; }
    known(b, ["id", "type", "at", "layer", "style", "content", "when", "on", "label", "showWhen"], where);
    if (typeof b.id !== "string" || !ID_RE.test(b.id)) err(where, "Each block needs an \"id\": lowercase letters, numbers and dashes, up to 40 (it stays the same for the life of the layout).");
    else if (ids.has(b.id)) err(where, `Two blocks share the id "${b.id}".`);
    else ids.add(b.id);
    if (!TYPES[b.type]) { err(where, `"type" must be one of: ${Object.keys(TYPES).join(", ")}.`); return; }
    const at = isObj(b.at) ? b.at : {};
    if (!isObj(b.at)) err(where, "\"at\" is missing: { \"col\": 1, \"row\": 1, \"w\": 12, \"h\": 2 }.");
    else known(at, ["col", "row", "w", "h"], `${where} at`);
    const pos = { col: int(at.col, 1, grid.cols, 1, `${where} at.col`, "col"), row: int(at.row, 1, grid.rows, 1, `${where} at.row`, "row"),
      w: int(at.w, 1, grid.cols, 1, `${where} at.w`, "w"), h: int(at.h, 1, grid.rows, 1, `${where} at.h`, "h") };
    if (pos.col + pos.w - 1 > grid.cols) err(where, `It runs past the grid's ${grid.cols} columns (col ${pos.col} + w ${pos.w}).`);
    if (pos.row + pos.h - 1 > grid.rows) err(where, `It runs past the grid's ${grid.rows} rows (row ${pos.row} + h ${pos.h}).`);
    const layer = int(b.layer, 0, 9, 0, `${where} layer`, "layer");
    const style = checkStyle(b.style, where, err);
    const content = checkContent(TYPES[b.type], b.content, where, err);
    if (content.list) {
      const given = PROVIDES[b.type].filter((k) => content[k] !== undefined);
      if (given.length) err(where, `It shows the list "${content.list}", so its ${given.join(", ")} come from the menu; take ${given.length === 1 ? "it" : "them"} out of the layout.`);
      if (ctx.lists === null) err(where, `It shows the list "${content.list}", but this layout has no menu yet. Make lists from this layout, or choose a menu for it.`);
      else if (Array.isArray(ctx.lists)) {
        const L = ctx.lists.find((x) => x.key === content.list);
        if (!L) err(where, `There's no list "${content.list}" on this layout's menu (it has: ${ctx.lists.map((x) => x.key).join(", ") || "none"}).`);
        else if (BINDS[b.type] !== L.kind) err(where, `The list "${content.list}" is ${L.kind === "items" ? "an items" : `a ${L.kind}`} list; a ${b.type} block shows ${BINDS[b.type] === "items" ? "an items" : `a ${BINDS[b.type]}`} list.`);
      }
    }
    const when = checkWhen(b.when, where, err);
    if (b.on !== undefined && typeof b.on !== "boolean") err(where, "\"on\" is true or false.");
    // E2b: shows only while one of the menu's lists has nothing on ("empty") or something on ("showing")
    // E2d: or while one of the board's options is on or off
    let showWhen = null;
    if (b.showWhen !== undefined && isObj(b.showWhen) && "option" in b.showWhen) {
      const sw = b.showWhen;
      if (Object.keys(sw).some((k) => !["option", "is"].includes(k)) || !["on", "off"].includes(sw.is)) err(where, "\"showWhen\" for an option is { \"option\": \"coffee-bar\", \"is\": \"on\" } or \"off\".");
      else if (!options.some((o) => o.key === sw.option)) err(where, `Its showWhen names the option "${sw.option}", which isn't among the layout's "options".`);
      else showWhen = { option: sw.option, is: sw.is };
    } else if (b.showWhen !== undefined) {
      const sw = b.showWhen;
      if (!isObj(sw) || Object.keys(sw).some((k) => !["list", "is"].includes(k)) || typeof sw.list !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(sw.list) || !["empty", "showing"].includes(sw.is))
        err(where, "\"showWhen\" is { \"list\": \"fall\", \"is\": \"empty\" } or { \"list\": \"fall\", \"is\": \"showing\" }.");
      else {
        showWhen = { list: sw.list, is: sw.is };
        if (ctx.lists === null) err(where, `Its showWhen names the list "${sw.list}", but this layout has no menu yet.`);
        else if (Array.isArray(ctx.lists) && !ctx.lists.some((x) => x.key === sw.list)) err(where, `Its showWhen names the list "${sw.list}", which isn't on this layout's menu.`);
      }
    }
    blocks.push({ id: b.id, type: b.type, at: pos, layer, style, content, when, on: b.on !== false, label: typeof b.label === "string" ? b.label.slice(0, 60) : "", ...(showWhen ? { showWhen } : {}) });
  });

  // E1b: a background picture behind the whole layout, dimmed by the palette's bg colour (0 to 90%)
  let background = null;
  if (th.background !== undefined) {
    if (!isObj(th.background)) err("theme.background", "The background is { \"image\": \"img:…\", \"dim\": 60 }.");
    else {
      known(th.background, ["image", "dim"], "theme.background");
      const image = checkValue(["image"], th.background.image, "theme.background", "image", err);
      const dim = th.background.dim === undefined ? 60 : checkValue(["int", 0, 90], th.background.dim, "theme.background", "dim", err);
      if (image) background = { image, dim: dim ?? 60 };
    }
  }
  const doc = { format: FORMAT, orientation, grid, viewing, theme: { palette, fonts, ...(background ? { background } : {}), looks, look, chalk }, options, blocks };
  if (!errors.length) {
    guardrails(doc, warn, ctx);
    // E2d: the chalkboard drawn with its default colours is checked too (every chalk colour passes on slate, so this
    // only speaks when a layout's own palette is used on it somewhere)
    if (looks.includes("chalkboard") && look !== "chalkboard") guardrails(applyLook(doc, { look: "chalkboard" }), (w, m, k) => warn(w, `On the chalkboard: ${m}`, k), ctx);
  }
  return { errors, warnings, doc };
}

/** E2d: the board's look and options as drawn: the layout's defaults, with the customer's choice (menu content.boards
 *  [layout id]) where it's one the layout offers. Returns { look, chalk: { titles, prices, accents, lettering, frame },
 *  options: { key: true|false } }. */
export function boardChoice(doc, choice) {
  const th = doc?.theme || {}, looks = th.looks || ["house"], c = isObj(choice) ? choice : {};
  const look = LOOKS[c.look] && looks.includes(c.look) ? c.look : th.look || looks[0];
  const chalk = { ...CHALK_DEFAULT, ...(th.chalk || {}) };
  const cc = isObj(c.chalk) ? c.chalk : {};
  for (const k of Object.keys(CHALK_ROLES)) if (CHALK[cc[k]]) chalk[k] = cc[k];
  if (LETTERING[c.lettering]) chalk.lettering = c.lettering;
  if (typeof c.frame === "boolean") chalk.frame = c.frame;
  const options = {};
  for (const o of doc?.options || []) options[o.key] = typeof c.options?.[o.key] === "boolean" ? c.options[o.key] : o.default;
  return { look, chalk, options };
}

/** E2d: whether a layout offers the customer anything to choose (a second look, or an option). */
export const offersChoice = (doc) => (doc?.theme?.looks || []).length > 1 || (doc?.options || []).length > 0;

/** E2d: the layout as drawn with a look and options chosen: on the chalkboard its palette and fonts become the chalk
 *  ones; blocks shown for an option the other way are switched off. doc.look says what was drawn (board.js styles the
 *  slate, grain and frame from it). */
// ── T1b (DP-13): the shop's brand (menu-format.mjs brandProblem; kept with the menu), drawn before the look: the shop's
// name and logo picture on every logo block (a name without a logo picture takes the template's picture away, so the
// name shows), its five colours (the colours on them, a quieter text and the lines worked out to suit), its two fonts.
// The Chalkboard look then draws its slate and chalk lettering over the colours and fonts, and keeps the name and logo. ──
const mixHex = (a, b, t) => `#${hexRgb(a).map((v, i) => Math.round(v * (1 - t) + hexRgb(b)[i] * t).toString(16).padStart(2, "0")).join("")}`;
/** White or the darkest of two inks, whichever reads better on a colour */
const onColour = (c, dark) => (contrast("#ffffff", c) >= contrast(dark, c) ? "#ffffff" : dark);
export function applyBrand(doc, brand) {
  if (!doc || !brand || typeof brand !== "object") return doc;
  const c = brand.colours && typeof brand.colours === "object" ? brand.colours : {};
  const hex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
  const p0 = doc.theme.palette, p = { ...p0 };
  for (const k of ["bg", "ink", "accent", "panel", "highlight"]) if (hex(c[k])) p[k] = c[k];
  if (Object.keys(c).some((k) => hex(c[k]))) {
    const dark = contrast(p.ink, "#ffffff") > contrast(p.bg, "#ffffff") ? p.ink : p.bg;
    if (hex(c.accent)) p.onAccent = onColour(p.accent, dark);
    // text on the dark panel: the background colour when it reads well there (cream on espresso), else white or dark
    if (hex(c.panel)) p.onPanel = onColour(p.panel, dark) === "#ffffff" && contrast(p.bg, p.panel) >= 4.5 ? p.bg : onColour(p.panel, dark);
    if (hex(c.highlight)) p.onHighlight = onColour(p.highlight, dark);
    if (hex(c.ink) || hex(c.bg)) { p.muted = mixHex(p.ink, p.bg, 0.35); p.line = mixHex(p.ink, p.bg, 0.82); }
  }
  const f = brand.fonts && typeof brand.fonts === "object" ? brand.fonts : {};
  const fonts = { ...doc.theme.fonts };
  for (const k of ["display", "body"]) if (FONTS[f[k]]) fonts[k] = f[k];
  const name = typeof brand.name === "string" && brand.name.trim() ? brand.name.trim().slice(0, 60) : null;
  const logo = typeof brand.logo === "string" && /^img:[a-z0-9][a-z0-9-]{0,59}$/.test(brand.logo) ? brand.logo : null;
  const blocks = (name || logo) ? doc.blocks.map((b) => {
    if (b.type !== "logo") return b;
    const content = { ...b.content };
    if (name) content.text = name;
    if (logo) content.image = logo; else if (name) delete content.image;
    return { ...b, content };
  }) : doc.blocks;
  return { ...doc, blocks, theme: { ...doc.theme, palette: p, fonts } };
}

export function applyLook(doc, choice) {
  if (!doc) return doc;
  const ch = boardChoice(doc, choice);
  const blocks = doc.blocks.map((b) => (b.showWhen?.option ? { ...b, on: b.on !== false && (ch.options[b.showWhen.option] === true) === (b.showWhen.is === "on") } : b));
  if (ch.look !== "chalkboard") return { ...doc, blocks, look: { ...ch, item: null } };
  const t = CHALK[ch.chalk.titles], pr = CHALK[ch.chalk.prices], ac = CHALK[ch.chalk.accents], lf = LETTER_FONTS[ch.chalk.lettering];
  const palette = { bg: SLATE, ink: CHALK.white, muted: "#c9cbc2", accent: "#343e3b", onAccent: CHALK.white, panel: "#343e3b", onPanel: CHALK.white,
    highlight: "#343e3b", onHighlight: CHALK.white, line: ac };   // a band (surface) on the slate is outlined in the accent chalk (board.css)
  // On the slate every block's text is chalk: a block's own ink ("muted" and the like) maps to the chalk palette above
  return { ...doc, blocks, theme: { ...doc.theme, palette, fonts: { display: lf.display, body: "Instrument Sans", accent: lf.display }, background: undefined },
    look: { ...ch, item: lf.item, colours: { titles: t, prices: pr, accents: ac } } };
}

function checkStyle(s, where, err) {
  const out = {};
  if (s === undefined) return out;
  if (!isObj(s)) { err(where, "\"style\" is an object."); return out; }
  for (const [k, v] of Object.entries(s)) {
    const rule = STYLE[k];
    if (!rule) { err(`${where} style`, `"${k}" isn't a style (allowed: ${Object.keys(STYLE).join(", ")}).`); continue; }
    const [kind, a, b] = rule;
    if (kind === "enum" && !a.includes(v)) err(`${where} style.${k}`, `${k} must be one of: ${a.join(", ")}.`);
    else if (kind === "palette" && !PALETTE_KEYS.includes(v)) err(`${where} style.${k}`, `${k} must be a palette colour name (${PALETTE_KEYS.join(", ")}).`);
    else if (kind === "int" && !(Number.isInteger(v) && v >= a && v <= b)) err(`${where} style.${k}`, `${k} must be a whole number from ${a} to ${b}.`);
    else if (kind === "bool" && typeof v !== "boolean") err(`${where} style.${k}`, `${k} is true or false.`);
    else out[k] = v;
  }
  return out;
}

function checkValue(rule, v, where, label, err) {
  const [kind, a, b] = rule;
  switch (kind) {
    case "text":
      if (typeof v !== "string") { err(where, `${label} is text.`); return undefined; }
      if (v.length > a) { err(where, `${label} is ${v.length} characters; at most ${a}.`); return v.slice(0, a); }
      return v;
    case "int": return Number.isInteger(v) && v >= a && v <= b ? v : (err(where, `${label} must be a whole number from ${a} to ${b}.`), undefined);
    case "bool": return typeof v === "boolean" ? v : (err(where, `${label} is true or false.`), undefined);
    case "enum": return a.includes(v) ? v : (err(where, `${label} must be one of: ${a.join(", ")}.`), undefined);
    case "time": return typeof v === "string" && TIME_RE.test(v) && v <= "24:00" ? v : (err(where, `${label} is a 24-hour time like "06:00" or "18:30".`), undefined);
    case "days":
      if (!Array.isArray(v) || !v.length || v.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) { err(where, `${label} is a list of days, 1 = Monday to 7 = Sunday, e.g. [2,3,4,5,6].`); return undefined; }
      return [...new Set(v)].sort();
    case "tags":
      if (!Array.isArray(v) || v.some((t) => !TAGS[t])) { err(where, `${label} are from: ${Object.keys(TAGS).join(", ")}.`); return undefined; }
      return [...new Set(v)];
    case "link":
      if (typeof v !== "string" || v.length > 300 || !LINK_RE.test(v)) { err(where, `${label} is a web address written in full, like "https://donutjoescoffee.com/pages/events" (at most 300 characters).`); return undefined; }
      return v;
    case "listkey": return typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v) ? v : (err(where, `${label} is a list's key on this layout's menu, like "donuts".`), undefined);
    case "image": return typeof v === "string" && IMAGE_RE.test(v) ? v : (err(where, `${label} is a picture's key, like "img:maple-bacon" (Layouts → Pictures shows each one's key).`), undefined);
    case "strings":
      if (!Array.isArray(v) || v.length > a || v.some((s) => typeof s !== "string" || s.length > b)) { err(where, `${label} is a list of up to ${a} short texts (${b} characters each).`); return undefined; }
      return v;
    case "list": {
      if (!Array.isArray(v)) { err(where, `${label} is a list.`); return undefined; }
      if (v.length > a) err(where, `${label} has ${v.length} entries; at most ${a}.`);
      return v.slice(0, a).map((it, i) => {
        if (!isObj(it)) { err(where, `${label} ${i + 1} is an object.`); return null; }
        const o = {};
        for (const [k, x] of Object.entries(it)) {
          if (!b[k]) { err(where, `${label} ${i + 1}: "${k}" isn't allowed (${Object.keys(b).join(", ")}).`); continue; }
          const val = checkValue(b[k], x, where, `${label} ${i + 1} ${k}`, err);
          if (val !== undefined) o[k] = val;
        }
        return o;
      }).filter(Boolean);
    }
    default: return undefined;
  }
}

function checkContent(spec, c, where, err) {
  const out = {};
  if (c === undefined) return out;
  if (!isObj(c)) { err(where, "\"content\" is an object."); return out; }
  for (const [k, v] of Object.entries(c)) {
    if (!spec[k]) { err(`${where} content`, `"${k}" isn't part of this block (allowed: ${Object.keys(spec).join(", ")}).`); continue; }
    const val = checkValue(spec[k], v, `${where} content.${k}`, k, err);
    if (val !== undefined) out[k] = val;
  }
  return out;
}

function checkWhen(w, where, err) {
  if (w === undefined) return null;
  const list = Array.isArray(w) ? w : [w];
  if (!list.length || list.length > 8) { err(`${where} when`, "\"when\" is one schedule, or a list of up to 8 (the block shows when any of them matches)."); return null; }
  return list.map((x, i) => {
    const at = `${where} when${list.length > 1 ? ` ${i + 1}` : ""}`;
    if (!isObj(x)) { err(at, "A schedule is { \"days\": [1,2,3,4,5], \"from\": \"11:00\", \"to\": \"14:00\", \"dates\": { \"from\": \"2026-10-01\", \"to\": \"2026-11-30\" } }."); return null; }
    const o = {};
    for (const k of Object.keys(x)) if (!["days", "from", "to", "dates"].includes(k)) err(at, `"${k}" isn't part of a schedule (days, from, to, dates).`);
    if (x.days !== undefined) o.days = checkValue(["days"], x.days, at, "days", err);
    if (x.from !== undefined) o.from = checkValue(["time"], x.from, at, "from", err);
    if (x.to !== undefined) o.to = checkValue(["time"], x.to, at, "to", err);
    if ((o.from === undefined) !== (o.to === undefined) && !(x.from === undefined && x.to === undefined)) err(at, "Give both \"from\" and \"to\", or neither.");
    if (x.dates !== undefined) {
      if (!isObj(x.dates) || Object.keys(x.dates).some((k) => !["from", "to"].includes(k))
          || Object.values(x.dates).some((d) => typeof d !== "string" || !DATE_RE.test(d) || Number.isNaN(Date.parse(d)))) err(at, "\"dates\" is { \"from\": \"2026-10-01\", \"to\": \"2026-11-30\" } (either may be left out; both days included).");
      else o.dates = { ...x.dates };
    }
    return o;
  }).filter(Boolean);
}

// ── Guardrails (warnings) ──
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function luminance(h) { return hexRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0); }
export function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/** The colours a block's text is drawn in, and what it's drawn on. */
export function blockColours(doc, b) {
  const p = doc.theme.palette, surf = b.style.surface || "none";
  const back = surf === "none" ? p.bg : p[surf];
  const ink = b.style.ink ? p[b.style.ink] : surf === "none" ? p.ink : p[SURFACES[surf]];
  return { back, ink };
}

/** Millimetres per canvas pixel on a screen of this size (the canvas's short side is 1080). */
export const mmPerPx = (inches) => (inches * 25.4 * 9 / Math.hypot(16, 9)) / 1080;
/** The smallest text (its full height, in mm) that reads comfortably from this distance: 1 mm for every 300 mm. */
export const minTextMm = (metres) => metres * 1000 / 300;
/** The smallest text a block draws, as a share of its size (board.css draws these shares: small lines 0.62, tags 0.55,
 *  kickers and notes 0.5, and so on). It looks at what the block actually holds, so a line on its own is full size. */
function smallestShare(b, list) {
  const c = b.content || {};
  // A block on a list: what the list's entries may hold (a customer can add a tag or a description any day)
  if (list) {
    const f = list.fields || [];
    if (b.type === "items") return f.includes("tags") ? 0.55 : f.includes("line") ? 0.62 : 1;
    if (b.type === "photo" || b.type === "rotator") return f.includes("line") ? 0.55 : 1;
    if (b.type === "text") return c.kicker || c.note ? 0.5 : f.includes("title") && f.includes("body") ? 0.62 : 1;
    if (b.type === "hours") return 0.55;
  }
  switch (b.type) {
    case "text": return c.kicker || c.note ? 0.5 : c.title && c.body ? 0.62 : 1;
    case "items": return (c.items || []).some((i) => (i.tags || []).length) ? 0.55 : (c.items || []).some((i) => i.line) ? 0.62 : 1;
    case "chips": return 0.8;
    case "price": return c.note ? 0.35 : c.label ? 0.4 : 1;
    case "photo": case "rotator": return c.line || (c.items || []).some((i) => i.line) ? 0.55 : 1;
    case "logo": return 1;
    case "clock": return (c.show || "both") === "both" ? 0.4 : 0.5;
    case "weather": return c.label ? 0.4 : 0.45;
    case "hours": return c.heading || c.note ? 0.55 : 0.62;
    case "timetable": return 0.55;
    case "nownext": return 0.42;
    case "qr": return 0.62;
    default: return 0.62;
  }
}
/** Whether two blocks ever show at the same moment (each day of the week, every 15 minutes; date ranges left aside). */
function everTogether(a, b) {
  // E2b: a block shown only while a list is empty is never on with one that shows that list, or that needs it showing
  const needs = (x) => [x.content?.list ? [x.content.list, "showing"] : null, x.showWhen?.list ? [x.showWhen.list, x.showWhen.is] : null].filter(Boolean);
  for (const [k1, is1] of needs(a)) for (const [k2, is2] of needs(b)) if (k1 === k2 && is1 !== is2) return false;
  // E2d: a block shown with an option on is never on with one shown with it off
  if (a.showWhen?.option && a.showWhen.option === b.showWhen?.option && a.showWhen.is !== b.showWhen.is) return false;
  if (!a.when?.length || !b.when?.length) return true;
  // E1b: two entries whose date ranges never meet are never on together (a fall box and the box that follows it)
  const apart = (x, y) => x.dates && y.dates && ((x.dates.to && y.dates.from && x.dates.to < y.dates.from) || (y.dates.to && x.dates.from && y.dates.to < x.dates.from));
  for (const wa of a.when) for (const wb of b.when) {
    if (apart(wa, wb)) continue;
    for (let dow = 1; dow <= 7; dow++) for (let m = 0; m < 1440; m += 15) {
      const hm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const at = { dow, hm, date: "" };
      if (inSchedule({ ...wa, dates: undefined }, at) && inSchedule({ ...wb, dates: undefined }, at)) return true;
    }
  }
  return false;
}

function guardrails(doc, warn, ctx = {}) {
  const lists = Object.fromEntries((Array.isArray(ctx.lists) ? ctx.lists : []).map((l) => [l.key, l]));
  const { inches, metres } = doc.viewing;
  const need = minTextMm(metres), perPx = mmPerPx(inches);
  for (const b of doc.blocks) {
    const where = `block "${b.id}"`;
    const { back, ink } = blockColours(doc, b);
    const size = SIZES[b.style.size || "m"];
    const c = contrast(ink, back), large = size >= SIZES.l;
    if (c < (large ? 3 : 4.5)) warn(where, `Its text is hard to read on its background (contrast ${c.toFixed(1)}:1; at least ${large ? 3 : 4.5}:1 is needed).`, "contrast");
    const smallest = size * smallestShare(b, lists[b.content?.list]) * perPx;
    if (smallest < need) warn(where, `Its smallest text is about ${smallest.toFixed(0)} mm tall on a ${inches}" screen; from ${metres} m away it should be at least ${need.toFixed(0)} mm. Use a larger size.`, "small");
  }
  // E1c: a QR code too small to read from where people stand
  for (const b of doc.blocks.filter((x) => x.type === "qr")) {
    const mm = Math.round(qrSide(doc, b) * perPx);
    if (mm < QR_MIN_MM) warn(`block "${b.id}"`, `Its QR code is about ${Math.max(0, mm)} mm across on a ${inches}" screen, so phones read it from about ${(Math.max(0, mm) / 100).toFixed(1)} m (a code reads from about 10 times its width). Make the box bigger, so it reads from at least 1 m.`, "qr");
  }
  // E1b: text standing straight on a picture, with no band behind it, can't be read reliably whatever its colour
  const PICTURE = new Set(["photo", "rotator"]), BANDED = new Set(["photo", "rotator", "logo", "price", "qr"]);
  const overlaps = (a, b) => a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
  for (const b of doc.blocks) {
    if (BANDED.has(b.type) || (b.style.surface && b.style.surface !== "none")) continue;
    const under = doc.blocks.find((x) => x !== b && PICTURE.has(x.type) && x.layer <= b.layer && overlaps(x.at, b.at) && everTogether(x, b));
    if (under) warn(`block "${b.id}"`, `Its text sits straight on the picture "${under.id}". Give it a surface (a band behind the text), or move it off the picture.`, "photo");
    else if (doc.theme.background && doc.theme.background.dim < 60) warn(`block "${b.id}"`, `Its text sits on the background picture, dimmed only ${doc.theme.background.dim}%. Dim it 60% or more, or give the block a surface.`, "photo");
  }
  // Blocks on the same layer that overlap (put one on a higher layer if it's meant to sit on top)
  const bs = doc.blocks;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i].at, b = bs[j].at;
    if (bs[i].layer === bs[j].layer && a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h && everTogether(bs[i], bs[j]))
      warn(`blocks "${bs[i].id}" and "${bs[j].id}"`, "They overlap on the same layer. Move one, or give the one on top a higher \"layer\".", "overlap");
  }
}

// ── Time: when a block shows, and today's hours ──
/** Now in a time zone: { dow: 1..7 (Monday 1), hm: "HH:MM", date: "YYYY-MM-DD" }. */
export function zonedNow(ms, tz) {
  let parts;
  try { parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)); }
  catch { parts = new Intl.DateTimeFormat("en-US", { hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)); }
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get("weekday")] || 1;
  return { dow, hm: `${get("hour").replace(/^24$/, "00")}:${get("minute")}`, date: `${get("year")}-${get("month")}-${get("day")}` };
}

const inSchedule = (w, now) => (!w.days || w.days.includes(now.dow))
  && (!w.from || (w.from <= w.to ? now.hm >= w.from && now.hm < w.to : now.hm >= w.from || now.hm < w.to))
  && (!w.dates || ((!w.dates.from || now.date >= w.dates.from) && (!w.dates.to || now.date <= w.dates.to)));

/** Whether a block shows now: switched on, and inside one of its schedules (or it has none). */
export const blockShows = (b, now) => b.on !== false && (!b.when || !b.when.length || b.when.some((w) => inSchedule(w, now)));

/** "06:00" -> "6 AM", "18:30" -> "6:30 PM", "12:00" -> "Noon". */
export function niceTime(t) {
  const [h, m] = t.split(":").map(Number);
  if (h === 12 && m === 0) return "Noon";
  if ((h === 0 || h === 24) && m === 0) return "Midnight";
  const h12 = h % 12 || 12, ap = h % 24 < 12 ? "AM" : "PM";
  return m ? `${h12}:${String(m).padStart(2, "0")} ${ap}` : `${h12} ${ap}`;
}
const DAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAYNAME = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** [2,3,4,5,6] -> "Tue–Sat"; [1,3,5] -> "Mon, Wed, Fri". */
export function niceDays(days) {
  const d = [...days].sort();
  const runs = [];
  for (const x of d) { const r = runs[runs.length - 1]; if (r && x === r[1] + 1) r[1] = x; else runs.push([x, x]); }
  return runs.map(([a, b]) => (a === b ? DAY[a] : b === a + 1 ? `${DAY[a]}, ${DAY[b]}` : `${DAY[a]}–${DAY[b]}`)).join(", ");
}

/** Open or closed now, from a week of opening hours: { open, line, week: ["Tue–Sat · 6 AM – 6 PM", …] }. */
export function hoursNow(hours, now) {
  const list = (hours || []).filter((h) => h.days && h.open && h.close);
  const today = list.filter((h) => h.days.includes(now.dow));
  const openNow = today.find((h) => now.hm >= h.open && now.hm < h.close);
  let line;
  if (openNow) line = `Open now · until ${niceTime(openNow.close)}`;
  else {
    const later = today.filter((h) => now.hm < h.open).sort((a, b) => a.open.localeCompare(b.open))[0];
    if (later) line = `Closed now · opens at ${niceTime(later.open)}`;
    else {
      let next = null;
      for (let k = 1; k <= 7 && !next; k++) {
        const d = ((now.dow - 1 + k) % 7) + 1;
        const h = list.filter((x) => x.days.includes(d)).sort((a, b) => a.open.localeCompare(b.open))[0];
        if (h) next = { d, h, k };
      }
      line = next ? `Closed now · opens ${next.k === 1 ? "tomorrow" : DAYNAME[next.d]} at ${niceTime(next.h.open)}` : "Closed";
    }
  }
  return { open: !!openNow, line, week: list.map((h) => `${niceDays(h.days)} · ${niceTime(h.open)} – ${niceTime(h.close)}`) };
}

/** The current and next session of a timetable-like list, for "on now / next". */
export function nowNext(sessions, now) {
  const list = (sessions || []).filter((s) => s.from && s.to);
  const cur = list.find((s) => (!s.days || s.days.includes(now.dow)) && now.hm >= s.from && now.hm < s.to) || null;
  let next = null;
  for (let k = 0; k <= 7 && !next; k++) {
    const d = ((now.dow - 1 + k) % 7) + 1;
    const cands = list.filter((s) => (!s.days || s.days.includes(d)) && (k > 0 || s.from > now.hm)).sort((a, b) => a.from.localeCompare(b.from));
    if (cands.length) next = { ...cands[0], day: k === 0 ? "" : k === 1 ? "Tomorrow" : DAYNAME[d] };
  }
  return { now: cur, next };
}

/** Where a block sits on the canvas, in canvas pixels. */
export function blockBox(doc, b) {
  const { w: W, h: H } = canvas(doc.orientation), g = doc.grid;
  const bottom = Math.max(g.margin, POWERED_STRIP);
  const cw = (W - 2 * g.margin - (g.cols - 1) * g.gap) / g.cols;
  const ch = (H - g.margin - bottom - (g.rows - 1) * g.gap) / g.rows;
  return { left: g.margin + (b.at.col - 1) * (cw + g.gap), top: g.margin + (b.at.row - 1) * (ch + g.gap),
    width: b.at.w * cw + (b.at.w - 1) * g.gap, height: b.at.h * ch + (b.at.h - 1) * g.gap };
}

export const STYLE_PX = { RADII, PADS };

/** E1c: how many canvas pixels across a QR block draws its code (the board draws it exactly this size): the box less
 *  its padding, and less one line of text under the code. */
export function qrSide(doc, b) {
  const box = blockBox(doc, b), surf = b.style.surface || "none";
  const pad = PADS[b.style.pad || (surf === "none" ? "none" : "m")];
  const line = SIZES[b.style.size || "m"] * 0.62 * 1.2 + 10;
  return Math.floor(Math.min(box.width - 2 * pad, box.height - 2 * pad - line));
}

/** E1c: the order a person reads a layout's blocks in (the phone menu lists them this way). The board is cut into
 *  columns wherever no block crosses the line, left first, or failing that into strips across, top first, and each
 *  part the same way, and so on down; blocks that can't be separated go by row, then column. So a menu in three
 *  columns reads each column top to bottom, and a stack of full-width bands reads top to bottom. */
export function readingOrder(blocks) {
  const cut = (list) => {
    if (list.length <= 1) return list;
    for (const [pos, size] of [["col", "w"], ["row", "h"]]) {
      const starts = [...new Set(list.map((b) => b.at[pos]))].sort((a, b) => a - b).slice(1);
      for (const s of starts) {
        if (list.some((b) => b.at[pos] < s && b.at[pos] + b.at[size] > s)) continue;   // a block crosses this line
        return [...cut(list.filter((b) => b.at[pos] < s)), ...cut(list.filter((b) => b.at[pos] >= s))];
      }
    }
    return [...list].sort((a, b) => a.at.row - b.at.row || a.at.col - b.at.col);
  };
  return cut([...blocks]);
}
